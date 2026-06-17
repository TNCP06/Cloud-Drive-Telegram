"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/lib/icons";
import { fmtSize } from "@/lib/format";
import type { Kind } from "@/lib/types";

// Resumable browser uploader. Sends a single (possibly multi-GB) file to the server
// in chunks. If a chunk fails (flaky connection) it retries with backoff; if it gets
// out of sync it re-reads the server offset and continues — never restarts from 0.
// When the whole file is on the server it calls /api/upload/complete, which queues a
// job for the watcher (which splits >2 GB files and pushes them to Telegram).

const CHUNK = 16 * 1024 * 1024; // 16 MB per request
const MAX_RETRY = 6;

type Phase = "idle" | "uploading" | "retrying" | "finalizing" | "done" | "error" | "paused";

interface ActiveUploadInfo {
  token: string;
  name: string;
  size: number;
  kind: Kind;
  title: string;
  tags: string;
  partSize: number;
}

function fileSig(f: File) {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

// Stable per-file token so re-selecting the same file resumes its server-side bytes.
function tokenFor(f: File) {
  const key = "tcd_up_" + fileSig(f);
  let t = localStorage.getItem(key);
  if (!t) {
    t = (crypto.randomUUID?.() ?? String(Date.now()) + Math.random()).replace(/[-.]/g, "");
    localStorage.setItem(key, t);
  }
  return t;
}

function clearToken(f: File) {
  localStorage.removeItem("tcd_up_" + fileSig(f));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [sent, setSent] = useState(0);
  const [speed, setSpeed] = useState(0); // bytes/sec
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelRef = useRef(false);
  const pausedRef = useRef(false);
  const [activeUpload, setActiveUpload] = useState<ActiveUploadInfo | null>(null);

  // Restore active upload from localStorage on mount (persistence across refresh)
  useEffect(() => {
    const saved = localStorage.getItem("tcd_active_upload");
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as ActiveUploadInfo;
        setActiveUpload(parsed);
        setPhase("paused");
        // Get last known sent bytes from server
        fetch(`/api/upload?token=${parsed.token}&name=${encodeURIComponent(parsed.name)}`)
          .then((r) => r.json())
          .then((j) => {
            setSent(j.received ?? 0);
          })
          .catch(() => {});
      } catch {
        localStorage.removeItem("tcd_active_upload");
      }
    }
  }, []);

  const reset = () => {
    setPhase("idle");
    setFile(null);
    setSent(0);
    setSpeed(0);
    setErr(null);
    abortRef.current = null;
    cancelRef.current = false;
    pausedRef.current = false;
  };

  const cancel = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
    localStorage.removeItem("tcd_active_upload");
    setActiveUpload(null);
    reset();
  };

  const pause = () => {
    pausedRef.current = true;
    setPhase("paused");
    abortRef.current?.abort();
  };

  const resume = () => {
    if (file) {
      pausedRef.current = false;
      upload(file, activeUpload || undefined);
    }
  };

  const upload = useCallback(
    async (f: File, savedInfo?: ActiveUploadInfo) => {
      setErr(null);
      setFile(f);
      setSent(0);
      setPhase("uploading");
      cancelRef.current = false;
      pausedRef.current = false;

      // Extract config from savedState if resuming after reload, else use props/file
      const uploadKind = savedInfo ? savedInfo.kind : kind;
      const uploadTitle = savedInfo ? savedInfo.title : title;
      const uploadTags = savedInfo ? savedInfo.tags : tags;
      const uploadPartSize = savedInfo ? savedInfo.partSize : partSize;
      const uploadToken = savedInfo ? savedInfo.token : tokenFor(f);
      const name = f.name;

      const info: ActiveUploadInfo = {
        token: uploadToken,
        name,
        size: f.size,
        kind: uploadKind,
        title: uploadTitle,
        tags: uploadTags,
        partSize: uploadPartSize,
      };

      // Persist in localStorage
      localStorage.setItem("tcd_active_upload", JSON.stringify(info));
      setActiveUpload(info);

      // Where does the server already have us? (resume across reloads / earlier tries)
      let offset = 0;
      try {
        const r = await fetch(`/api/upload?token=${uploadToken}&name=${encodeURIComponent(name)}`);
        if (r.ok) offset = (await r.json()).received ?? 0;
      } catch {
        /* start from 0 */
      }
      if (offset > f.size) offset = 0; // stale/mismatched staging → restart this file
      setSent(offset);

      let speedAnchor = { t: Date.now(), bytes: offset };

      while (offset < f.size && !cancelRef.current && !pausedRef.current) {
        const end = Math.min(offset + CHUNK, f.size);
        const blob = f.slice(offset, end);
        const ac = new AbortController();
        abortRef.current = ac;

        let ok = false;
        for (let attempt = 0; attempt <= MAX_RETRY && !cancelRef.current && !pausedRef.current; attempt++) {
          try {
            if (attempt > 0) setPhase("retrying");
            const res = await fetch(
              `/api/upload?token=${uploadToken}&name=${encodeURIComponent(name)}&offset=${offset}`,
              { method: "POST", body: blob, signal: ac.signal }
            );
            if (res.status === 409) {
              // Out of sync — adopt the server's offset and continue.
              const j = await res.json();
              offset = Number(j.received ?? offset);
              setSent(offset);
              ok = true;
              setPhase("uploading");
              break;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const j = await res.json();
            offset = Number(j.received ?? end);
            setSent(offset);
            setPhase("uploading");
            ok = true;
            // speed (rolling, ~every 1.5s)
            const now = Date.now();
            if (now - speedAnchor.t > 1500) {
              setSpeed(((offset - speedAnchor.bytes) * 1000) / (now - speedAnchor.t));
              speedAnchor = { t: now, bytes: offset };
            }
            break;
          } catch {
            if (cancelRef.current || pausedRef.current) break;
            if (attempt === MAX_RETRY) {
              setErr(
                "Connection lost. Your progress is saved on the server — click Resume to continue."
              );
              setPhase("error");
              return;
            }
            await sleep(Math.min(1000 * 2 ** attempt, 15000)); // backoff: 1s,2s,4s…15s
          }
        }
        if (!ok) return; // canceled mid-chunk
      }

      if (cancelRef.current || pausedRef.current) return;

      // Whole file is on the server → enqueue the job.
      setPhase("finalizing");
      try {
        const res = await fetch("/api/upload/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: uploadToken,
            name,
            size: f.size,
            kind: uploadKind,
            title: uploadTitle,
            tags: uploadTags,
            partSize: uploadPartSize,
          }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "Failed to queue upload.");
        clearToken(f);
        localStorage.removeItem("tcd_active_upload");
        setActiveUpload(null);
        setPhase("done");
        onQueued();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to queue upload.");
        setPhase("error");
      }
    },
    [kind, title, tags, partSize, onQueued]
  );

  const onPick = (f: File | undefined) => {
    if (!f) return;
    upload(f);
  };

  const onPickResumed = (f: File | undefined) => {
    if (!f || !activeUpload) return;
    if (f.name !== activeUpload.name || f.size !== activeUpload.size) {
      setErr(`File mismatch. Please select the correct file: "${activeUpload.name}" (${fmtSize(activeUpload.size)})`);
      return;
    }
    setErr(null);
    upload(f, activeUpload);
  };

  const totalSize = file ? file.size : activeUpload ? activeUpload.size : 0;
  const pct = totalSize ? Math.floor((sent / totalSize) * 100) : 0;
  const busy = phase === "uploading" || phase === "retrying" || phase === "finalizing";

  return (
    <div className="fu">
      {(!activeUpload && phase === "idle") || phase === "done" ? (
        <label className="fu-drop">
          <input
            type="file"
            hidden
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          <Icon name="upload" size={22} />
          <div className="fu-drop-main">
            <strong>Choose a file to upload</strong>
            <span className="hint">
              {kind === "archive"
                ? "One file (archive). Bigger than 2 GB? The server splits it automatically."
                : "One media file (video/image)."}
            </span>
          </div>
          {phase === "done" && <span className="fu-done"><Icon name="check" size={14} /> Queued</span>}
        </label>
      ) : (
        <div className="fu-active">
          <div className="fu-row1">
            <span className="fu-name" title={file?.name || activeUpload?.name}>
              {file?.name || activeUpload?.name}
            </span>
            <span className="fu-meta">
              {fmtSize(sent)} / {fmtSize(totalSize)}
              {speed > 0 && busy ? ` · ${fmtSize(speed)}/s` : ""}
            </span>
          </div>
          <div className="up-bar">
            <span style={{ width: pct + "%" }} />
          </div>
          <div className="fu-row2">
            <span className="fu-phase">
              {phase === "retrying" && <><span className="spinner sm" /> Reconnecting…</>}
              {phase === "uploading" && <>{pct}% uploaded</>}
              {phase === "paused" && <>Paused</>}
              {phase === "finalizing" && <><span className="spinner sm" /> Queuing…</>}
              {phase === "error" && <span className="fu-err">{err}</span>}
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              {/* Need to re-select file after refresh */}
              {!file && activeUpload && (
                <label className="btn primary sm" style={{ cursor: "pointer", margin: 0 }}>
                  <input
                    type="file"
                    hidden
                    onChange={(e) => onPickResumed(e.target.files?.[0])}
                  />
                  Select File to Resume
                </label>
              )}

              {/* Pause/Resume buttons when file is selected */}
              {file && (
                <>
                  {phase === "uploading" && (
                    <button className="btn primary sm" onClick={pause}>Pause</button>
                  )}
                  {phase === "paused" && (
                    <button className="btn primary sm" onClick={resume}>Resume</button>
                  )}
                </>
              )}

              {phase === "error" && file && (
                <button className="btn primary sm" onClick={() => upload(file, activeUpload || undefined)}>Retry</button>
              )}
              <button className="btn subtle sm" onClick={cancel}>
                {phase === "error" ? "Dismiss" : "Cancel"}
              </button>
            </span>
          </div>
        </div>
      )}
      {!file && activeUpload && (
        <div className="up-err" style={{ marginTop: 8, background: "rgba(59, 130, 246, 0.1)", border: "1px solid rgba(59, 130, 246, 0.2)", color: "#93c5fd" }}>
          Upload was paused by page refresh. Please re-select the file <b>{activeUpload.name}</b> to resume.
        </div>
      )}
      {err && file && <div className="up-err">{err}</div>}
    </div>
  );
}
