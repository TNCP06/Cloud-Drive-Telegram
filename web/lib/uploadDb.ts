import type { Kind } from "@/lib/types";

// IndexedDB persistence for the client-side upload queue. The File bytes are stored
// alongside the metadata so a page refresh (or accidental reload) does NOT force the
// user to re-pick files: on next load we rehydrate the queue and resume each upload
// from the server's staged offset. Records are deleted as soon as the browser→VPS
// phase completes (handoff to the watcher) or the user removes the item, so the blob
// only lives in IndexedDB while an upload is actually in flight.

const DB_NAME = "tcd-upload-db";
const STORE = "queue";
const META_STORE = "metadata";
const VERSION = 2;

// One persisted queue item. `file` is a Blob (structured-cloneable) — IndexedDB can
// store File/Blob directly, so we keep the original bytes for resume.
export interface PersistedUpload {
  token: string; // primary key (also the staging token)
  tokenKey: string;
  file: Blob;
  name: string;
  size: number;
  kind: Kind;
  title: string;
  tags: string;
  partSize: number;
  // "error" is preserved across reload so a failed item stays retryable; everything
  // else rehydrates as "ready" and auto-resumes.
  errored: boolean;
}

function hasIDB(): boolean {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "token" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "token" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode, store = STORE): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store);
}

// Save (or overwrite) a queue item. Returns false when persistence failed
// (quota/eviction/private mode) — the item still uploads this session from
// memory, but it will NOT survive a refresh, so the caller must warn.
export async function putUpload(rec: PersistedUpload): Promise<boolean> {
  if (!hasIDB()) return false;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const r = tx(db, "readwrite").put(rec);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
    db.close();
    return true;
  } catch (e) {
    console.warn("[uploadDb] persist failed (continuing in-memory)", e);
    return false;
  }
}

// Patch just the `errored` flag without rewriting the (large) blob again.
export async function markUploadErrored(token: string, errored: boolean): Promise<void> {
  if (!hasIDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const store = tx(db, "readwrite");
      const g = store.get(token);
      g.onsuccess = () => {
        const rec = g.result as PersistedUpload | undefined;
        if (!rec) return resolve();
        rec.errored = errored;
        const p = store.put(rec);
        p.onsuccess = () => resolve();
        p.onerror = () => reject(p.error);
      };
      g.onerror = () => reject(g.error);
    });
    db.close();
  } catch (e) {
    console.warn("[uploadDb] mark errored failed", e);
  }
}

// Update metadata without structured-cloning the potentially multi-gigabyte Blob.
export async function patchUploadMeta(
  token: string,
  patch: Partial<Pick<PersistedUpload, "title" | "tags" | "kind" | "errored">>
): Promise<void> {
  if (!hasIDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const put = tx(db, "readwrite", META_STORE).put({ token, ...patch });
      put.onsuccess = () => resolve();
      put.onerror = () => reject(put.error);
    });
    db.close();
  } catch (e) {
    console.warn("[uploadDb] metadata patch failed", e);
  }
}

export async function deleteUpload(token: string): Promise<void> {
  if (!hasIDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const r = tx(db, "readwrite").delete(token);
      r.onsuccess = () => {
        const meta = tx(db, "readwrite", META_STORE).delete(token);
        meta.onsuccess = () => resolve();
        meta.onerror = () => reject(meta.error);
      };
      r.onerror = () => reject(r.error);
    });
    db.close();
  } catch (e) {
    console.warn("[uploadDb] delete failed", e);
  }
}

export async function getAllUploads(): Promise<PersistedUpload[]> {
  if (!hasIDB()) return [];
  try {
    const db = await openDb();
    const rows = await new Promise<PersistedUpload[]>((resolve, reject) => {
      const r = tx(db, "readonly").getAll();
      r.onsuccess = () => {
        const queue = (r.result as PersistedUpload[]) ?? [];
        const meta = tx(db, "readonly", META_STORE).getAll();
        meta.onsuccess = () => {
          const patches = new Map(
            (meta.result as Array<{ token: string } & Partial<PersistedUpload>>).map((m) => [m.token, m])
          );
          resolve(queue.map((item) => ({ ...item, ...patches.get(item.token) })));
        };
        meta.onerror = () => reject(meta.error);
      };
      r.onerror = () => reject(r.error);
    });
    db.close();
    return rows;
  } catch (e) {
    console.warn("[uploadDb] read failed", e);
    return [];
  }
}
