"use client";

import { useCallback, useRef, useState } from "react";
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

type Phase = "idle" | "uploading" | "retrying" | "finalizing" | "done" | "error";

function fileSig(f: File) {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

// Stable per-file token so re-selecting the same file resumes its server-side bytes.
function tokenFor(f: File) {
  const key = "tcd_up_" + fileSig(f);
  let t = localStorage.getItem(key);
  if (!t) {
    t = (crypto.randomUUID?.() ?? String(Date.now()) + Math.random()).replace(/-/g, "");
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

  const reset = () => {
    setPhase("idle");
    setFile(null);
    setSent(0);
    setSpeed(0);
    setErr(null);
    abortRef.current = null;
    cancelRef.current = false;
  };

  const cancel = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
  };

  const upload = useCallback(
    async (f: File) => {
      setErr(null);
      setFile(f);
      setSent(0);
      setPhase("uploading");
      cancelRef.current = false;
      const token = tokenFor(f);
      const name = f.name;

      // Where does the server already have us? (resume across reloads / earlier tries)
      let offset = 0;
      try {
        const r = await fetch(`/api/upload?token=${token}&name=${encodeURIComponent(name)}`);
        if (r.ok) offset = (await r.json()).received ?? 0;
      } catch {
        /* start from 0 */
      }
      if (offset > f.size) offset = 0; // stale/mismatched staging → restart this file
      setSent(offset);

      let speedAnchor = { t: Date.now(), bytes: offset };

      while (offset < f.size && !cancelRef.current) {
        const end = Math.min(offset + CHUNK, f.size);
        const blob = f.slice(offset, end);
        const ac = new AbortController();
        abortRef.current = ac;

        let ok = false;
        for (let attempt = 0; attempt <= MAX_RETRY && !cancelRef.current; attempt++) {
          try {
            if (attempt > 0) setPhase("retrying");
            const res = await fetch(
              `/api/upload?token=${token}&name=${encodeURIComponent(name)}&offset=${offset}`,
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
            if (cancelRef.current) break;
            if (attempt === MAX_RETRY) {
              setErr(
                "Connection lost. Your progress is saved on the server — click Retry to continue."
              );
              setPhase("error");
              return;
            }
            await sleep(Math.min(1000 * 2 ** attempt, 15000)); // backoff: 1s,2s,4s…15s
          }
        }
        if (!ok) return; // canceled mid-chunk
      }

      if (cancelRef.current) return;

      // Whole file is on the server → enqueue the job.
      setPhase("finalizing");
      try {
        const res = await fetch("/api/upload/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, name, size: f.size, kind, title, tags, partSize }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "Failed to queue upload.");
        clearToken(f);
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
    if (kind === "game" && f.size > 1.9 * 1024 ** 3) {
      // fine — the server will split it. No action needed; informational only.
    }
    upload(f);
  };

  const pct = file && file.size ? Math.floor((sent / file.size) * 100) : 0;
  const busy = phase === "uploading" || phase === "retrying" || phase === "finalizing";

  return (
    <div className="fu">
      {phase === "idle" || phase === "done" ? (
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
              {kind === "game"
                ? "One file (archive). Bigger than 2 GB? The server splits it automatically."
                : "One media file (video/image)."}
            </span>
          </div>
          {phase === "done" && <span className="fu-done"><Icon name="check" size={14} /> Queued</span>}
        </label>
      ) : (
        <div className="fu-active">
          <div className="fu-row1">
            <span className="fu-name" title={file?.name}>{file?.name}</span>
            <span className="fu-meta">
              {fmtSize(sent)} / {file ? fmtSize(file.size) : "0"}
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
              {phase === "finalizing" && <><span className="spinner sm" /> Queuing…</>}
              {phase === "error" && <span className="fu-err">{err}</span>}
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              {phase === "error" && file && (
                <button className="btn primary sm" onClick={() => upload(file)}>Retry</button>
              )}
              <button className="btn subtle sm" onClick={() => { cancel(); reset(); }}>
                {phase === "error" ? "Dismiss" : "Cancel"}
              </button>
            </span>
          </div>
        </div>
      )}
      {err && phase !== "error" && <div className="up-err">{err}</div>}
    </div>
  );
}
