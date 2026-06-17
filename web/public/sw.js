// web/public/sw.js

const DB_NAME = 'video-cache-db';
const DB_VERSION = 1;
const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB chunks
const MAX_CACHE_SIZE = 4 * 1024 * 1024 * 1024; // 4 GB in bytes
const MAX_RESPONSE_CHUNKS = 2; // Max chunks returned in a single response to keep memory low

// Helper to open IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('files')) {
        const filesStore = db.createObjectStore('files', { keyPath: 'partId' });
        filesStore.createIndex('lastAccessed', 'lastAccessed', { unique: false });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

// Promisified DB Operations
function getFromStore(storeName, key) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}

function putInStore(storeName, value) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}

// Parse the Range header (e.g. "bytes=1000-2000")
function parseRange(rangeHeader) {
  if (!rangeHeader) return null;
  const parts = rangeHeader.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : null;
  return { start, end };
}

// Merge multiple ArrayBuffers into one
function mergeArrayBuffers(buffers) {
  let totalLength = buffers.reduce((acc, buf) => acc + buf.byteLength, 0);
  let tmp = new Uint8Array(totalLength);
  let offset = 0;
  for (let buf of buffers) {
    tmp.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return tmp.buffer;
}

// Evict old chunks when cache exceeds 4GB limit
async function cleanUpCache() {
  try {
    const db = await openDB();
    
    // Read all chunks to calculate total size
    const allChunks = await new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readonly');
      const store = tx.objectStore('chunks');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    let totalSize = allChunks.reduce((acc, c) => acc + c.size, 0);
    if (totalSize <= MAX_CACHE_SIZE) return;

    console.log(`[SW Cache] Current cache size: ${(totalSize / (1024 * 1024)).toFixed(2)} MB. Limit: 4096 MB. Evicting...`);

    // Get all files sorted by lastAccessed ascending
    const allFiles = await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly');
      const store = tx.objectStore('files');
      const index = store.index('lastAccessed');
      const req = index.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    const tx = db.transaction(['chunks', 'files'], 'readwrite');
    const chunksStore = tx.objectStore('chunks');
    const filesStore = tx.objectStore('files');

    for (const file of allFiles) {
      if (totalSize <= MAX_CACHE_SIZE) break;

      // Delete all chunks for this file
      const fileChunks = allChunks.filter(c => c.partId === file.partId);
      for (const chunk of fileChunks) {
        chunksStore.delete(chunk.id);
        totalSize -= chunk.size;
      }
      // Delete the file metadata
      filesStore.delete(file.partId);
      console.log(`[SW Cache] Evicted cache for partId: ${file.partId}`);
    }
  } catch (err) {
    console.error('[SW Cache] Eviction error:', err);
  }
}

// Core fetch handler
async function handleVideoRequest(request) {
  const url = new URL(request.url);
  const match = url.pathname.match(/\/api\/stream\/([^/]+)/);
  const partId = match ? match[1] : null;

  if (!partId) {
    return fetch(request);
  }

  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) {
    // No range header -> bypass cache to avoid memory pressure of full download
    return fetch(request);
  }

  const range = parseRange(rangeHeader);
  let fileMeta = await getFromStore('files', partId).catch(() => null);

  // If we don't have file size or content-type yet, fetch a minimal range first to retrieve them
  if (!fileMeta) {
    try {
      console.log(`[SW Cache] Fetching metadata for partId: ${partId}`);
      // Fetch a tiny range (0-1) to get headers
      const res = await fetch(request.url, {
        headers: { 'Range': 'bytes=0-1' }
      });

      if (res.status === 200 || res.status === 206) {
        const contentRange = res.headers.get('content-range');
        const contentType = res.headers.get('content-type') || 'video/mp4';
        let totalSize = 0;

        if (contentRange) {
          const parts = contentRange.split('/');
          totalSize = parseInt(parts[parts.length - 1], 10);
        } else {
          totalSize = parseInt(res.headers.get('content-length') || '0', 10);
        }

        if (totalSize > 0) {
          fileMeta = {
            partId,
            size: totalSize,
            contentType,
            lastAccessed: Date.now()
          };
          await putInStore('files', fileMeta);
        }
      }
    } catch (err) {
      console.error('[SW Cache] Failed to fetch metadata:', err);
    }
  }

  // Fallback to direct network fetch if metadata couldn't be retrieved
  if (!fileMeta || fileMeta.size <= 0) {
    return fetch(request);
  }

  // Update last accessed timestamp for LRU
  fileMeta.lastAccessed = Date.now();
  await putInStore('files', fileMeta).catch(() => {});

  const fileSize = fileMeta.size;
  const start = range.start;
  let end = range.end !== null ? range.end : fileSize - 1;
  if (end >= fileSize) {
    end = fileSize - 1;
  }

  // Convert byte range to chunk indices
  const startChunkIdx = Math.floor(start / CHUNK_SIZE);
  let endChunkIdx = Math.floor(end / CHUNK_SIZE);

  // Limit response size to prevent memory crash
  if (endChunkIdx - startChunkIdx >= MAX_RESPONSE_CHUNKS) {
    endChunkIdx = startChunkIdx + MAX_RESPONSE_CHUNKS - 1;
    end = (endChunkIdx + 1) * CHUNK_SIZE - 1;
    if (end >= fileSize) {
      end = fileSize - 1;
    }
  }

  const chunkBuffers = [];

  for (let i = startChunkIdx; i <= endChunkIdx; i++) {
    const chunkId = `${partId}_chunk_${i}`;
    let chunk = await getFromStore('chunks', chunkId).catch(() => null);

    if (!chunk) {
      const chunkStart = i * CHUNK_SIZE;
      const chunkEnd = Math.min((i + 1) * CHUNK_SIZE - 1, fileSize - 1);

      try {
        console.log(`[SW Cache] Fetching chunk ${i} for partId ${partId} (bytes ${chunkStart}-${chunkEnd})`);
        const res = await fetch(request.url, {
          headers: { 'Range': `bytes=${chunkStart}-${chunkEnd}` }
        });

        if (res.status === 200 || res.status === 206) {
          const arrayBuffer = await res.arrayBuffer();
          chunk = {
            id: chunkId,
            partId,
            index: i,
            data: arrayBuffer,
            size: arrayBuffer.byteLength
          };
          await putInStore('chunks', chunk);
          
          // Trigger LRU eviction check asynchronously
          setTimeout(cleanUpCache, 0);
        } else {
          throw new Error(`Server returned status ${res.status}`);
        }
      } catch (err) {
        console.error(`[SW Cache] Failed to fetch chunk ${i}:`, err);
        // If chunk download fails, fallback directly to network for the original requested range
        return fetch(request);
      }
    }

    chunkBuffers.push(chunk.data);
  }

  // Reconstruct the exact requested byte range from the retrieved chunks
  const mergedBuffer = mergeArrayBuffers(chunkBuffers);
  const relativeStart = start - (startChunkIdx * CHUNK_SIZE);
  const relativeEnd = relativeStart + (end - start + 1);
  const slicedData = mergedBuffer.slice(relativeStart, relativeEnd);

  return new Response(slicedData, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': slicedData.byteLength.toString(),
      'Content-Type': fileMeta.contentType,
      'Accept-Ranges': 'bytes'
    }
  });
}

// Listen to fetch events
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.includes('/api/stream/')) {
    event.respondWith(handleVideoRequest(event.request));
  }
});

// Self-claim and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
