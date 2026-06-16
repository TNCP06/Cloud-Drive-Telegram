"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/lib/icons";
import { fmtDate } from "@/lib/format";
import type { Kind, Tag, UploadJob, UploadStatus, WatcherStatus } from "@/lib/types";
import { TagPicker } from "@/components/TagPicker";
import {
  enqueueUpload,
  cancelUpload,
  clearFinishedUploads,
  startUpload,
  startAllUploads,
  startWatcher,
  stopWatcher,
} from "@/app/actions";
import { FsBrowser } from "@/components/FsBrowser";

const STATUS_LABEL: Record<UploadStatus, string> = {
  queued: "Queued",
  pending: "Waiting for watcher",
  running: "Uploading",
  done: "Done",
  error: "Failed",
  canceled: "Canceled",
};

// Derive title from path: strip -pc suffix, replace -/_ with spaces.
function deriveTitle(p: string): string {
  const base = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  return base.replace(/-pc$/i, "").replace(/[-_]+/g, " ").trim();
}

export function UploadManager({
  jobs,
  watcher,
  allTags = [],
}: {
  jobs: UploadJob[];
  watcher: WatcherStatus;
  allTags?: Tag[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const queuedCount = jobs.filter((j) => j.status === "queued").length;
  const activeCount = jobs.filter((j) => j.status === "pending" || j.status === "running").length;

  const [kind, setKind] = useState<Kind>("game");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [partSize, setPartSize] = useState(1500);
  const [err, setErr] = useState<string | null>(null);
  const [browse, setBrowse] = useState(false);

  const [watcherBusy, setWatcherBusy] = useState(false);
  const [watcherErr, setWatcherErr] = useState<string | null>(null);

  // Always poll so watcher status and upload progress stay live (faster when there are active jobs).
  const hasActive = activeCount > 0;
  useEffect(() => {
    const t = setInterval(() => router.refresh(), hasActive ? 3000 : 6000);
    return () => clearInterval(t);
  }, [hasActive, router]);

  const submit = () => {
    setErr(null);
    startTransition(async () => {
      try {
        await enqueueUpload({ kind, title, tags, sourcePath, partSize });
        setTitle("");
        setTags("");
        setSourcePath("");
        router.refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to add to queue.");
      }
    });
  };

  const onStartWatcher = async () => {
    setWatcherErr(null);
    setWatcherBusy(true);
    try {
      const r = await startWatcher();
      if (!r.ok) setWatcherErr(r.error ?? "Failed to start watcher.");
    } finally {
      setWatcherBusy(false);
      router.refresh();
    }
  };

  const onStopWatcher = async () => {
    if (
      watcher.status === "busy" &&
      !window.confirm("Watcher is currently uploading. Force stop? The running upload will fail.")
    )
      return;
    setWatcherErr(null);
    setWatcherBusy(true);
    try {
      const r = await stopWatcher();
      if (!r.ok) setWatcherErr(r.error ?? "Failed to stop watcher.");
    } finally {
      setWatcherBusy(false);
      router.refresh();
    }
  };

  return (
    <div className="up-wrap scroll">
      <div className="up-inner">
        <div className="up-head">
          <Link className="btn subtle" href="/">
            <Icon name="back" size={16} />
            Back
          </Link>
          <h1>Upload via laptop</h1>
        </div>

        {/* WARNING */}
        <div className="up-warn">
          <Icon name="warn" size={20} />
          <div>
            <strong>Laptop must be on &amp; watcher active.</strong> Large files are uploaded from
            the laptop (via Telegram MTProto), <em>not</em> from this browser. The form below only
            queues the job — then start the watcher (button below) and click <b>Start</b>. Do not
            turn off the laptop while the status is still <b>Uploading</b>.
          </div>
        </div>

        {/* WATCHER STATUS + CONTROL */}
        <div className="watcher-row">
          <span className={"wdot " + (watcher.online ? (watcher.status === "busy" ? "busy" : "on") : "off")} />
          <span className="wlabel">
            {watcher.online
              ? watcher.status === "busy"
                ? "Watcher is uploading…"
                : "Watcher active"
              : "Watcher inactive"}
          </span>
          {watcher.online ? (
            <button className="btn subtle sm wbtn" onClick={onStopWatcher} disabled={watcherBusy}>
              {watcherBusy ? <span className="spinner sm" /> : <Icon name="power" size={14} />}
              Stop watcher
            </button>
          ) : (
            <button className="btn primary sm wbtn" onClick={onStartWatcher} disabled={watcherBusy}>
              {watcherBusy ? <span className="spinner sm" /> : <Icon name="power" size={14} />}
              Start watcher
            </button>
          )}
        </div>
        {watcherErr && <div className="up-err">{watcherErr}</div>}
        {activeCount > 0 && !watcher.online && (
          <div className="up-warn danger">
            <Icon name="warn" size={20} />
            <div>
              <strong>{activeCount} upload(s) waiting but watcher is inactive.</strong> Click{" "}
              <b>Start watcher</b> above to process them.
            </div>
          </div>
        )}

        {/* FORM */}
        <div className="up-form">
          <div className="field">
            <label>Type</label>
            <div className="seg-radio">
              <button className={kind === "game" ? "on" : ""} onClick={() => setKind("game")}>
                <Icon name="archive" size={15} /> Game (split)
              </button>
              <button className={kind === "media" ? "on" : ""} onClick={() => setKind("media")}>
                <Icon name="video" size={15} /> Media (single file)
              </button>
            </div>
          </div>

          <div className="field">
            <label>
              Title{" "}
              {kind === "game" ? (
                <span className="hint">— include version, e.g. &quot;ReRudy 0.6.0&quot;</span>
              ) : (
                <span className="hint">— optional, auto-filled from filename if left blank</span>
              )}
            </label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === "game" ? "ReRudy 0.6.0" : "(optional) auto-filled from filename"}
            />
          </div>

          <div className="field">
            <label>{kind === "game" ? "Game folder" : "Media file"} on laptop</label>
            <div className="pick-row">
              <button type="button" className="btn" onClick={() => setBrowse(true)}>
                <Icon name={kind === "game" ? "folder" : "upload"} size={16} />
                Browse laptop…
              </button>
              <input
                className="input"
                value={sourcePath}
                onChange={(e) => setSourcePath(e.target.value)}
                placeholder="path auto-filled — or paste manually: C:\…"
              />
            </div>
            <div className="pick-note">
              Browse directly to the folder/file on the laptop — the full path (including OneDrive)
              is filled in automatically. No manual copy-paste needed.
            </div>
          </div>

          <div className="up-row">
            <div className="field" style={{ flex: 1 }}>
              <label>Categories</label>
              <TagPicker value={tags} onChange={setTags} suggestions={allTags} placeholder="rpg, fantasy" />
            </div>
            {kind === "game" && (
              <div className="field" style={{ width: 150 }}>
                <label>Part size (MB)</label>
                <input
                  className="input"
                  type="number"
                  value={partSize}
                  min={50}
                  onChange={(e) => setPartSize(parseInt(e.target.value) || 1500)}
                />
              </div>
            )}
          </div>

          {err && <div className="up-err">{err}</div>}

          <div className="up-actions">
            <button className="btn primary" onClick={submit} disabled={isPending}>
              {isPending ? <span className="spinner sm" /> : <Icon name="plus" size={16} stroke={2} />}
              Add to queue
            </button>
          </div>
        </div>

        {/* QUEUE */}
        <div className="up-listhead">
          <h2>Queue {hasActive && <span className="up-live">● live</span>}</h2>
          <div style={{ display: "flex", gap: 8 }}>
            {queuedCount > 0 && (
              <button className="btn primary" onClick={() => startTransition(() => startAllUploads())}>
                <Icon name="upload" size={15} /> Start all ({queuedCount})
              </button>
            )}
            {jobs.some((j) => ["done", "error", "canceled"].includes(j.status)) && (
              <button className="btn subtle" onClick={() => startTransition(() => clearFinishedUploads())}>
                <Icon name="trash" size={15} /> Clear finished
              </button>
            )}
          </div>
        </div>

        {jobs.length === 0 ? (
          <div className="up-empty">No uploads queued.</div>
        ) : (
          <div className="up-list">
            {jobs.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                onCancel={() => startTransition(() => cancelUpload(j.id))}
                onStart={() => startTransition(() => startUpload(j.id))}
              />
            ))}
          </div>
        )}
      </div>

      {browse && (
        <FsBrowser
          mode={kind === "game" ? "dir" : "file"}
          onClose={() => setBrowse(false)}
          onPick={(p) => {
            setSourcePath(p);
            if (!title) setTitle(deriveTitle(p));
          }}
        />
      )}
    </div>
  );
}

function JobRow({
  job,
  onCancel,
  onStart,
}: {
  job: UploadJob;
  onCancel: () => void;
  onStart: () => void;
}) {
  return (
    <div className="up-job">
      <div className={"up-badge st-" + job.status}>{STATUS_LABEL[job.status]}</div>
      <div className="up-job-main">
        <div className="up-job-title">
          {job.title} <span className="up-kind">{job.kind}</span>
        </div>
        <div className="up-job-path" title={job.sourcePath}>{job.sourcePath}</div>
        {job.status === "running" && (
          <div className="up-bar">
            <span style={{ width: job.progress + "%" }}></span>
          </div>
        )}
        {job.message && <div className="up-job-msg">{job.message}</div>}
      </div>
      <div className="up-job-side">
        <div className="up-job-time">{fmtDate(job.updatedAt)}</div>
        {job.status === "running" && <div className="up-pct">{job.progress}%</div>}
        {job.status === "queued" && (
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn primary sm" onClick={onStart}>
              Start
            </button>
            <button className="btn subtle sm" onClick={onCancel}>
              Cancel
            </button>
          </div>
        )}
        {job.status === "pending" && (
          <button className="btn subtle sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
