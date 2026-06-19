"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/lib/icons";
import { fmtSize } from "@/lib/format";
import type { Kind } from "@/lib/types";

// Resumable browser uploader. Sends each (possibly multi-GB) file to the server in
// chunks; a dropped chunk retries with backoff and re-syncs from the server offset —
// never restarts from 0. When a file is fully staged it calls /api/upload/complete,
// which queues a watcher job. Supports three selections:
//   • single file  — full rich view + pause/resume + resume-after-refresh.
//   • many files   — uploaded sequentially, each its own item (title from filename).
//   • a folder     — each file's title is its relative path (e.g. "Album/sub/photo"),
//                    which the bot turns into nested folders (Telegram has no folders).

const CHUNK = 16 * 1024 * 1024; // 16 MB per request
const MAX_RETRY = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Phase = "idle" | "uploading" | "retrying" | "finalizing" | "done" | "error" | "paused";
type ItemStatus = "pending" | "uploading" | "done" | "error" | "paused";

interface BatchItem {
  id: string;
  file: File | null; // null = restored from localStorage, needs re-select
  name: string; // staging basename (f.name)
  title: string; // per-file title (folder path / filename / single-form title)
  size: number;
  token: string;
  tokenKey: string;
  kind: Kind;
  tags: string;
  partSize: number;
  status: ItemStatus;
  sent: number;
  error?: string;
}

const stripExt = (s: string) => s.replace(/\.[^.]+$/, "");

function newToken(): string {
  return (crypto.randomUUID?.() ?? String(Date.now()) + Math.random()).replace(/[-.]/g, "");
}

interface UploadCtl {
  readonly cancel: boolean;
  readonly pause: boolean;
  setAbort: (a: AbortController | null) => void;
}

// Upload ONE file's bytes, then finalize. Returns the terminal state. Reads the
// server offset first so it transparently resumes a partially-staged file.
async function uploadOne(
  item: BatchItem,
  onProgress: (sent: number, speed: number) => void,
  ctl: UploadCtl
): Promise<{ status: "done" | "error" | "paused" | "canceled"; error?: string }> {
  const f = item.file;
  if (!f) return { status: "error", error: "File not selected." };
  const { name, token } = item;

  let offset = 0;
  try {
    const r = await fetch(`/api/upload?token=${token}&name=${encodeURIComponent(name)}`);
    if (r.ok) offset = (await r.json()).received ?? 0;
  } catch {
    /* start from 0 */
  }
  if (offset > f.size) offset = 0;
  onProgress(offset, 0);

  let anchor = { t: Date.now(), bytes: offset };

  while (offset < f.size) {
    if (ctl.cancel) return { status: "canceled" };
    if (ctl.pause) return { status: "paused" };

    const end = Math.min(offset + CHUNK, f.size);
    const blob = f.slice(offset, end);
    const ac = new AbortController();
    ctl.setAbort(ac);

    let ok = false;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      if (ctl.cancel) return { status: "canceled" };
      if (ctl.pause) return { status: "paused" };
      try {
        const res = await fetch(
          `/api/upload?token=${token}&name=${encodeURIComponent(name)}&offset=${offset}`,
          { method: "POST", body: blob, signal: ac.signal }
        );
        if (res.status === 409) {
          const j = await res.json();
          offset = Number(j.received ?? offset);
          onProgress(offset, 0);
          ok = true;
          break;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        offset = Number(j.received ?? end);
        const now = Date.now();
        let sp = 0;
        if (now - anchor.t > 1200) {
          sp = ((offset - anchor.bytes) * 1000) / (now - anchor.t);
          anchor = { t: now, bytes: offset };
        }
        onProgress(offset, sp);
        ok = true;
        break;
      } catch {
        if (ctl.cancel) return { status: "canceled" };
        if (ctl.pause) return { status: "paused" };
        if (attempt === MAX_RETRY)
          return { status: "error", error: "Connection lost — progress saved, retry to continue." };
        await sleep(Math.min(1000 * 2 ** attempt, 15000));
      }
    }
    if (!ok) return { status: "error", error: "Upload interrupted." };
  }

  // Whole file staged → queue the watcher job.
  try {
    const res = await fetch("/api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        name,
        size: f.size,
        kind: item.kind,
        title: item.title,
        tags: item.tags,
        partSize: item.partSize,
      }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "Failed to queue upload.");
    return { status: "done" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "Failed to queue upload." };
  }
}

export function FileUploader({
  kind,
  title,
  tags,
  partSize,
  onQueued,
}: {
  kind: Kind;
  title: string;
  tags: string;
  partSize: number;
  onQueued: () => void;
}) {
  const [items, setItems] = useState<BatchItem[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [phase, setPhase] = useState<Phase>("idle");
  const [speed, setSpeed] = useState(0);
  const cancelRef = useRef(false);
  const pauseRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const single = items.length === 1;

  const updateItem = useCallback((id: string, patch: Partial<BatchItem>) => {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }, []);

  // Restore a single interrupted upload across a page refresh (large-file safety).
  useEffect(() => {
    const saved = localStorage.getItem("tcd_active_upload");
    if (!saved) return;
    try {
      const p = JSON.parse(saved) as {
        token: string; name: string; size: number;
        kind: Kind; title: string; tags: string; partSize: number;
      };
      const item: BatchItem = {
        id: p.token, file: null, name: p.name, title: p.title, size: p.size,
        token: p.token, tokenKey: "", kind: p.kind, tags: p.tags, partSize: p.partSize,
        status: "paused", sent: 0,
      };
      setItems([item]);
      setActiveIdx(0);
      setPhase("paused");
      fetch(`/api/upload?token=${p.token}&name=${encodeURIComponent(p.name)}`)
        .then((r) => r.json())
        .then((j) => updateItem(p.token, { sent: j.received ?? 0 }))
        .catch(() => {});
    } catch {
      localStorage.removeItem("tcd_active_upload");
    }
  }, [updateItem]);

  const buildItems = (files: File[], mode: "single" | "multi" | "folder"): BatchItem[] =>
    files.map((f) => {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const itemTitle =
        mode === "single" ? title.trim() : mode === "folder" ? stripExt(rel) : stripExt(f.name);
      const tokenKey = `tcd_up_${mode === "folder" ? rel : f.name}:${f.size}:${f.lastModified}`;
      let token = localStorage.getItem(tokenKey);
      if (!token) {
        token = newToken();
        localStorage.setItem(tokenKey, token);
      }
      return {
        id: token, file: f, name: f.name, title: itemTitle, size: f.size,
        token, tokenKey, kind, tags, partSize, status: "pending", sent: 0,
      };
    });

  const run = useCallback(
    async (list: BatchItem[], startIdx: number) => {
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

      for (let i = startIdx; i < list.length; i++) {
        if (cancelRef.current) return;
        if (pauseRef.current) {
          setPhase("paused");
          return;
        }
        const it = list[i];
        if (it.status === "done" || !it.file) continue;
        setActiveIdx(i);
        setPhase("uploading");
        updateItem(it.id, { status: "uploading", error: undefined });

        const res = await uploadOne(
          it,
          (sent, sp) => {
            updateItem(it.id, { sent });
            if (sp) setSpeed(sp);
          },
          ctl
        );

        if (res.status === "paused") {
          updateItem(it.id, { status: "paused" });
          setPhase("paused");
          return;
        }
        if (res.status === "canceled") return;
        if (res.status === "done") {
          localStorage.removeItem(it.tokenKey);
          if (single) localStorage.removeItem("tcd_active_upload");
          updateItem(it.id, { status: "done", sent: it.size });
          onQueued();
        } else {
          updateItem(it.id, { status: "error", error: res.error });
          // Keep going so one bad file doesn't block the rest of a batch.
        }
      }

      setActiveIdx(-1);
      setSpeed(0);
      if (!cancelRef.current) setPhase("done");
    },
    [single, onQueued, updateItem]
  );

  const start = (files: File[], mode: "single" | "multi" | "folder") => {
    if (!files.length) return;
    const list = buildItems(files, mode);
    setItems(list);
    if (mode === "single") {
      const it = list[0];
      localStorage.setItem(
        "tcd_active_upload",
        JSON.stringify({
          token: it.token, name: it.name, size: it.size,
          kind: it.kind, title: it.title, tags: it.tags, partSize: it.partSize,
        })
      );
    } else {
      localStorage.removeItem("tcd_active_upload");
    }
    run(list, 0);
  };

  const pause = () => {
    pauseRef.current = true;
    setPhase("paused");
    abortRef.current?.abort();
  };

  const resume = () => {
    if (items.some((i) => !i.file)) return; // restored item: must re-select first
    pauseRef.current = false;
    run(items, Math.max(0, activeIdx));
  };

  const cancel = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
    items.forEach((i) => localStorage.removeItem(i.tokenKey));
    localStorage.removeItem("tcd_active_upload");
    setItems([]);
    setActiveIdx(-1);
    setSpeed(0);
    setPhase("idle");
  };

  // Re-select a single file that was restored from localStorage after a refresh.
  const onReselect = (f: File | undefined) => {
    if (!f || !single) return;
    const it = items[0];
    if (f.name !== it.name || f.size !== it.size) return;
    const fixed = { ...it, file: f };
    setItems([fixed]);
    pauseRef.current = false;
    run([fixed], 0);
  };

  const totalSize = items.reduce((a, i) => a + i.size, 0);
  const totalSent = items.reduce((a, i) => a + (i.status === "done" ? i.size : i.sent), 0);
  const overallPct = totalSize ? Math.floor((totalSent / totalSize) * 100) : 0;
  const doneCount = items.filter((i) => i.status === "done").length;
  const busy = phase === "uploading" || phase === "retrying" || phase === "finalizing";

  // ---- Idle: pickers ------------------------------------------------------
  if (items.length === 0 || phase === "done") {
    return (
      <div className="fu">
        <div className="fu-pickers">
          <label className="fu-drop">
            <input
              type="file"
              hidden
              multiple
              onChange={(e) => {
                const fs = Array.from(e.target.files ?? []);
                if (fs.length) start(fs, fs.length > 1 ? "multi" : "single");
                e.currentTarget.value = "";
              }}
            />
            <Icon name="upload" size={22} />
            <div className="fu-drop-main">
              <strong>Choose file(s)</strong>
              <span className="hint">
                {kind === "archive"
                  ? "One or more files. Bigger than 2 GB? The server splits each automatically."
                  : "One or more media files (video/image). Select many to upload in sequence."}
              </span>
            </div>
            {phase === "done" && (
              <span className="fu-done">
                <Icon name="check" size={14} /> Queued {doneCount > 0 ? `(${doneCount})` : ""}
              </span>
            )}
          </label>

          <label className="fu-folder-btn" title="Upload a whole folder (its structure becomes nested folders)">
            <input
              type="file"
              hidden
              multiple
              // webkitdirectory/directory are non-standard but widely supported for folder picks.
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(e) => {
                const fs = Array.from(e.target.files ?? []);
                if (fs.length) start(fs, "folder");
                e.currentTarget.value = "";
              }}
            />
            <Icon name="folder" size={16} />
            Choose folder
          </label>
        </div>
      </div>
    );
  }

  // ---- Single file: rich view --------------------------------------------
  if (single) {
    const it = items[0];
    const pct = it.size ? Math.floor((it.sent / it.size) * 100) : 0;
    return (
      <div className="fu">
        <div className="fu-active">
          <div className="fu-row1">
            <span className="fu-name" title={it.name}>{it.name}</span>
            <span className="fu-meta">
              {fmtSize(it.sent)} / {fmtSize(it.size)}
              {speed > 0 && busy ? ` · ${fmtSize(speed)}/s` : ""}
            </span>
          </div>
          <div className="up-bar">
            <span style={{ width: pct + "%" }} />
          </div>
          <div className="fu-row2">
            <span className="fu-phase">
              {phase === "retrying" && (<><span className="spinner sm" /> Reconnecting…</>)}
              {phase === "uploading" && <>{pct}% uploaded</>}
              {phase === "paused" && <>Paused</>}
              {phase === "finalizing" && (<><span className="spinner sm" /> Queuing…</>)}
              {phase === "error" && <span className="fu-err">{it.error}</span>}
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              {!it.file && (
                <label className="btn primary sm" style={{ cursor: "pointer", margin: 0 }}>
                  <input type="file" hidden onChange={(e) => onReselect(e.target.files?.[0])} />
                  Select file to resume
                </label>
              )}
              {it.file && phase === "uploading" && (
                <button className="btn primary sm" onClick={pause}>Pause</button>
              )}
              {it.file && (phase === "paused" || phase === "error") && (
                <button className="btn primary sm" onClick={resume}>
                  {phase === "error" ? "Retry" : "Resume"}
                </button>
              )}
              <button className="btn subtle sm" onClick={cancel}>Cancel</button>
            </span>
          </div>
          {!it.file && (
            <div className="fu-resume-note">
              Upload was paused by a page refresh. Re-select <b>{it.name}</b> to resume.
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- Batch (many files / folder) ---------------------------------------
  return (
    <div className="fu">
      <div className="fu-active">
        <div className="fu-row1">
          <span className="fu-name">
            {doneCount} / {items.length} files{" "}
            {phase === "uploading" && activeIdx >= 0 && items[activeIdx]
              ? `· ${items[activeIdx].title || items[activeIdx].name}`
              : ""}
          </span>
          <span className="fu-meta">
            {fmtSize(totalSent)} / {fmtSize(totalSize)}
            {speed > 0 && busy ? ` · ${fmtSize(speed)}/s` : ""}
          </span>
        </div>
        <div className="up-bar">
          <span style={{ width: overallPct + "%" }} />
        </div>
        <div className="fu-row2">
          <span className="fu-phase">
            {phase === "uploading" && <>{overallPct}% · uploading…</>}
            {phase === "retrying" && (<><span className="spinner sm" /> Reconnecting…</>)}
            {phase === "paused" && <>Paused</>}
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            {phase === "uploading" && <button className="btn primary sm" onClick={pause}>Pause</button>}
            {phase === "paused" && <button className="btn primary sm" onClick={resume}>Resume</button>}
            <button className="btn subtle sm" onClick={cancel}>Cancel</button>
          </span>
        </div>

        <div className="fu-list scroll">
          {items.map((it) => {
            const pct = it.size ? Math.floor((it.sent / it.size) * 100) : 0;
            return (
              <div className="fu-item" key={it.id}>
                <span className={"fu-item-dot " + it.status} />
                <span className="fu-item-name" title={it.title || it.name}>{it.title || it.name}</span>
                <span className="fu-item-meta">
                  {it.status === "done"
                    ? "Queued"
                    : it.status === "error"
                    ? "Failed"
                    : it.status === "uploading"
                    ? `${pct}%`
                    : it.status === "pending"
                    ? "Waiting"
                    : "Paused"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
