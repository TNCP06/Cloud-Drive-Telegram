"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type { Kind } from "@/lib/types";
import { startUpload } from "@/app/actions";
import {
  uploadResumable,
  newToken,
  autoTypeTag,
  withTag,
  type UploadCtl,
} from "@/lib/uploadClient";
import {
  putUpload,
  deleteUpload,
  getAllUploads,
  markUploadErrored,
} from "@/lib/uploadDb";

// A file selected in the browser but not yet (fully) uploaded to the VPS. Lives in
// this global provider so the upload keeps running across page navigation and a
// floating panel can show it anywhere. Persisted to IndexedDB so a refresh resumes
// instead of forcing a re-pick (see lib/uploadDb.ts).
export type LocalStage = "ready" | "uploading" | "finalizing" | "done" | "error";

export interface LocalItem {
  id: string;
  file: File | Blob;
  kind: Kind;
  title: string;
  tags: string;
  partSize: number;
  name: string;
  size: number;
  token: string;
  tokenKey: string;
  stage: LocalStage;
  sent: number;
  error?: string;
  jobId?: number;
  handedOff?: boolean;
}

export interface UploadDefaults {
  kind: Kind;
  title: string;
  tags: string;
  partSize: number;
}

interface UploadContextValue {
  items: LocalItem[];
  speed: number;
  running: boolean;
  readyCount: number;
  uploadingNow: boolean;
  activeCount: number;
  addFiles: (files: File[], folder: boolean, defaults: UploadDefaults) => void;
  runQueue: () => void;
  pauseRun: () => void;
  cancelRun: () => void;
  removeLocal: (id: string) => void;
  updateLocal: (id: string, patch: Partial<LocalItem>) => void;
  clearDone: () => void;
}

const UploadContext = createContext<UploadContextValue | null>(null);

const stripExt = (s: string) => s.replace(/\.[^.]+$/, "");

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  // Queue is held in a ref so the async runner always sees fresh state; a counter
  // forces re-renders for consumers.
  const itemsRef = useRef<LocalItem[]>([]);
  const [, force] = useState(0);
  const rerender = useCallback(() => force((x) => x + 1), []);
  const setItems = useCallback(
    (fn: (prev: LocalItem[]) => LocalItem[]) => {
      itemsRef.current = fn(itemsRef.current);
      rerender();
    },
    [rerender]
  );
  const updateLocal = useCallback(
    (id: string, patch: Partial<LocalItem>) =>
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it))),
    [setItems]
  );

  // Runner control.
  const runningRef = useRef(false);
  const cancelRef = useRef(false);
  const pauseRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [speed, setSpeed] = useState(0);
  const [running, setRunning] = useState(false);

  const runQueue = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    cancelRef.current = false;
    pauseRef.current = false;
    const ctl: UploadCtl = {
      get cancel() {
        return cancelRef.current;
      },
      get pause() {
        return pauseRef.current;
      },
      setAbort: (a) => {
        abortRef.current = a;
      },
    };
    try {
      while (!cancelRef.current && !pauseRef.current) {
        const next = itemsRef.current.find((i) => i.stage === "ready");
        if (!next) break;
        updateLocal(next.id, { stage: "uploading", error: undefined });
        const res = await uploadResumable(
          next.file,
          next.name,
          next.token,
          { kind: next.kind, title: next.title, tags: next.tags, partSize: next.partSize },
          (sent, sp) => {
            updateLocal(next.id, { sent });
            if (sp) setSpeed(sp);
          },
          ctl
        );
        if (res.status === "paused" || res.status === "canceled") {
          updateLocal(next.id, { stage: "ready" });
          break;
        }
        if (res.status === "done") {
          // Browser→VPS phase done: the watcher job takes over. Drop the persisted
          // blob now so IndexedDB only holds in-flight uploads.
          await deleteUpload(next.token);
          try {
            localStorage.removeItem(next.tokenKey);
          } catch {
            /* ignore */
          }
          updateLocal(next.id, { stage: "done", jobId: res.jobId, handedOff: true, sent: next.size });
          if (res.jobId) {
            try {
              await startUpload(res.jobId);
            } catch {
              /* the per-job Start button on /upload remains as a fallback */
            }
          }
          router.refresh();
        } else {
          updateLocal(next.id, { stage: "error", error: res.error });
          markUploadErrored(next.token, true);
        }
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
      setSpeed(0);
    }
  }, [router, updateLocal]);

  // Rehydrate the queue from IndexedDB on first mount and auto-resume any uploads
  // that were in flight (this is what makes a refresh non-destructive).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    let canceled = false;
    (async () => {
      const recs = await getAllUploads();
      if (canceled || recs.length === 0) return;
      const restored: LocalItem[] = recs
        .filter((r) => !itemsRef.current.some((it) => it.token === r.token))
        .map((r) => ({
          id: r.token,
          file: r.file,
          kind: r.kind,
          title: r.title,
          tags: r.tags,
          partSize: r.partSize,
          name: r.name,
          size: r.size,
          token: r.token,
          tokenKey: r.tokenKey,
          stage: r.errored ? ("error" as const) : ("ready" as const),
          sent: 0,
          error: r.errored ? "Interrupted — retry to resume." : undefined,
        }));
      if (restored.length === 0) return;
      setItems((prev) => [...restored, ...prev]);
      // Resume non-errored items automatically from the server offset.
      if (restored.some((it) => it.stage === "ready")) runQueue();
    })();
    return () => {
      canceled = true;
    };
  }, [runQueue, setItems]);

  const addFiles = useCallback(
    (files: File[], folder: boolean, defaults: UploadDefaults) => {
      if (!files.length) return;
      const additions: LocalItem[] = files.map((f) => {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        const itTitle = folder
          ? stripExt(rel)
          : files.length === 1 && defaults.title.trim()
          ? defaults.title.trim()
          : stripExt(f.name);
        const itTags = withTag(defaults.tags, autoTypeTag(f.name, defaults.kind));
        const tokenKey = `tcd_up_${folder ? rel : f.name}:${f.size}:${f.lastModified}`;
        let token: string | null = null;
        try {
          token = localStorage.getItem(tokenKey);
        } catch {
          /* ignore */
        }
        if (!token) {
          token = newToken();
          try {
            localStorage.setItem(tokenKey, token);
          } catch {
            /* ignore */
          }
        }
        const item: LocalItem = {
          id: token,
          file: f,
          kind: defaults.kind,
          title: itTitle,
          tags: itTags,
          partSize: defaults.partSize,
          name: f.name,
          size: f.size,
          token,
          tokenKey,
          stage: "ready",
          sent: 0,
        };
        // Persist the bytes + metadata so a refresh can resume without a re-pick.
        putUpload({
          token: item.token,
          tokenKey: item.tokenKey,
          file: f,
          name: item.name,
          size: item.size,
          kind: item.kind,
          title: item.title,
          tags: item.tags,
          partSize: item.partSize,
          errored: false,
        });
        return item;
      });
      setItems((prev) => [...prev, ...additions]);
    },
    [setItems]
  );

  const pauseRun = useCallback(() => {
    pauseRef.current = true;
    abortRef.current?.abort();
  }, []);

  const cancelRun = useCallback(() => {
    cancelRef.current = true;
    abortRef.current?.abort();
  }, []);

  const removeLocal = useCallback(
    (id: string) => {
      const it = itemsRef.current.find((i) => i.id === id);
      if (it) {
        deleteUpload(it.token);
        try {
          localStorage.removeItem(it.tokenKey);
        } catch {
          /* ignore */
        }
      }
      setItems((prev) => prev.filter((i) => i.id !== id));
    },
    [setItems]
  );

  const clearDone = useCallback(() => {
    setItems((prev) => prev.filter((i) => i.stage !== "done"));
  }, [setItems]);

  // Persist user edits (title/tags) so a refresh resumes with them intact.
  const persistMeta = useCallback((id: string, patch: Partial<LocalItem>) => {
    updateLocal(id, patch);
    if (patch.title === undefined && patch.tags === undefined) return;
    const it = itemsRef.current.find((i) => i.id === id);
    if (!it || it.stage === "done") return;
    putUpload({
      token: it.token,
      tokenKey: it.tokenKey,
      file: it.file,
      name: it.name,
      size: it.size,
      kind: it.kind,
      title: it.title,
      tags: it.tags,
      partSize: it.partSize,
      errored: it.stage === "error",
    });
  }, [updateLocal]);

  const items = itemsRef.current;
  const readyCount = items.filter((i) => i.stage === "ready").length;
  const uploadingNow = items.some((i) => i.stage === "uploading");
  const activeCount = items.filter(
    (i) => i.stage === "uploading" || i.stage === "finalizing" || i.stage === "ready"
  ).length;

  const value: UploadContextValue = {
    items,
    speed,
    running,
    readyCount,
    uploadingNow,
    activeCount,
    addFiles,
    runQueue,
    pauseRun,
    cancelRun,
    removeLocal,
    updateLocal: persistMeta,
    clearDone,
  };

  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}

export function useUpload(): UploadContextValue {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUpload must be used within an UploadProvider");
  return ctx;
}
