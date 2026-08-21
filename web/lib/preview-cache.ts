"use client";

const MAX_IMAGES = 12;
type Entry = { src: string; lastUsed: number };

const images = new Map<number, Entry>();
const inflight = new Map<number, Promise<string>>();
const MAX_DOCUMENTS = 6;
type DocumentKind = "text" | "word" | "sheet";
type DocumentEntry = { value: unknown; lastUsed: number };
const documents = new Map<string, DocumentEntry>();
const documentInflight = new Map<string, Promise<unknown>>();

// Keep decoded image data in browser memory so revisiting a photo never creates a new
// request or briefly falls back to its thumbnail. The small LRU bounds memory use.
export function getCachedPreviewSrc(partId: number): string | undefined {
  const entry = images.get(partId);
  if (!entry) return undefined;
  entry.lastUsed = Date.now();
  return entry.src;
}

export function loadPreviewImage(partId: number): Promise<string> {
  const cached = getCachedPreviewSrc(partId);
  if (cached) return Promise.resolve(cached);

  const existing = inflight.get(partId);
  if (existing) return existing;

  const promise = fetch(`/api/stream/${partId}`)
    .then((response) => {
      if (!response.ok) throw new Error(`Failed to load image (HTTP ${response.status}).`);
      return response.blob();
    })
    .then((blob) => {
      const src = URL.createObjectURL(blob);
      images.set(partId, { src, lastUsed: Date.now() });
      while (images.size > MAX_IMAGES) {
        const oldest = [...images.entries()].reduce((a, b) =>
          a[1].lastUsed <= b[1].lastUsed ? a : b
        );
        URL.revokeObjectURL(oldest[1].src);
        images.delete(oldest[0]);
      }
      return src;
    })
    .finally(() => inflight.delete(partId));

  inflight.set(partId, promise);
  return promise;
}

export function getCachedDocument<T>(kind: DocumentKind, partId: number): T | undefined {
  const entry = documents.get(`${kind}:${partId}`);
  if (!entry) return undefined;
  entry.lastUsed = Date.now();
  return entry.value as T;
}

// Share the fetch + parse promise too, so switching away before completion does not make the
// next visit start the same document request and conversion again.
export function loadCachedDocument<T>(
  kind: DocumentKind,
  partId: number,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = getCachedDocument<T>(kind, partId);
  if (cached !== undefined) return Promise.resolve(cached);

  const key = `${kind}:${partId}`;
  const existing = documentInflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = loader().then((value) => {
    documents.set(key, { value, lastUsed: Date.now() });
    while (documents.size > MAX_DOCUMENTS) {
      const oldest = [...documents.entries()].reduce((a, b) =>
        a[1].lastUsed <= b[1].lastUsed ? a : b
      );
      documents.delete(oldest[0]);
    }
    return value;
  }).finally(() => documentInflight.delete(key));

  documentInflight.set(key, promise);
  return promise;
}
