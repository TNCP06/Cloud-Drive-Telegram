"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/lib/icons";
import { fmtDate, fmtSize } from "@/lib/format";
import type { Kind, Tag, UploadJob, UploadStatus } from "@/lib/types";
import { TagPicker } from "@/components/TagPicker";
import {
  enqueueUpload,
  cancelUpload,
  clearFinishedUploads,
  startUpload,
  startAllUploads,
  retryUpload,
  updateUploadJob,
} from "@/app/actions";
import { FsBrowser } from "@/components/FsBrowser";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useUpload, type LocalItem } from "@/components/UploadProvider";

type UploadMode = "device" | "laptop";

const STATUS_LABEL: Record<UploadStatus, string> = {
  queued: "Queued",
  pending: "Waiting for watcher",
  running: "Uploading → Telegram",
  done: "Done",
  error: "Failed",
  canceled: "Canceled",
};

function deriveTitle(p: string): string {
  const base = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  return base.replace(/-pc$/i, "").replace(/[-_]+/g, " ").trim();
}

export function UploadManager({
  jobs,
  allTags = [],
}: {
  jobs: UploadJob[];
  allTags?: Tag[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // --- form defaults (applied to newly added items) ---
  const [kind, setKind] = useState<Kind>("media");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [partSize, setPartSize] = useState(1500);
  const [mode, setMode] = useState<UploadMode>("device");
  const [sourcePath, setSourcePath] = useState("");
  const [browse, setBrowse] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showAllJobs, setShowAllJobs] = useState(false);

  // --- global upload queue (runs in UploadProvider so it survives navigation &
  //     refresh; the floating panel reads the same state on other pages) ---
  const {
    items,
    speed,
    readyCount,
    uploadingNow,
    addFiles: addFilesCtx,
    runQueue,
    pauseRun,
    cancelRun,
    removeLocal,
    updateLocal,
  } = useUpload();

  const addFiles = (files: File[], folder: boolean) =>
    addFilesCtx(files, folder, { kind, title, tags, partSize });

  const queuedJobCount = jobs.filter((j) => j.status === "queued").length;
  const activeCount =
    jobs.filter((j) => j.status === "pending" || j.status === "running").length +
    items.filter((i) => i.stage === "uploading" || i.stage === "finalizing").length;
  const hasActive = activeCount > 0;

  useEffect(() => {
    const t = setInterval(() => router.refresh(), hasActive ? 3000 : 6000);
    return () => clearInterval(t);
  }, [hasActive, router]);

  const startAll = () => {
    runQueue();
    if (queuedJobCount > 0) startTransition(() => startAllUploads());
  };

  // --- host-path (laptop) enqueue ----------------------------------------
  const submitHostPath = () => {
    setErr(null);
    startTransition(async () => {
      try {
        await enqueueUpload({ kind, title, tags, sourcePath, partSize });
        setTitle("");
        setSourcePath("");
        router.refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to add to queue.");
      }
    });
  };

  // Hide a local item once its watcher job shows up in the server list (handoff done).
  const visibleLocal = items.filter(
    (it) => !(it.handedOff && jobs.some((j) => j.id === it.jobId))
  );

  const JOBS_COLLAPSED = 6;
  const totalRows = visibleLocal.length + jobs.length;
  const shownJobs = showAllJobs ? jobs : jobs.slice(0, Math.max(0, JOBS_COLLAPSED - visibleLocal.length));
  const hiddenJobCount = jobs.length - shownJobs.length;

  return (
    <div className="up-wrap scroll">
      <div className="up-inner">
        <div className="up-head">
          <Link className="btn subtle" href="/">
            <Icon name="back" size={16} />
            Back
          </Link>
          <h1>Upload files</h1>
          <div style={{ marginLeft: "auto" }}>
            <ThemeToggle />
          </div>
        </div>

        {/* FORM (defaults for newly added files) */}
        <div className="up-form">
          <div className="field">
            <label>Type</label>
            <div className="seg-radio">
              {/* Media on the LEFT (default) */}
              <button className={kind === "media" ? "on" : ""} onClick={() => setKind("media")}>
                <Icon name="video" size={15} /> Media (single file)
              </button>
              <button className={kind === "archive" ? "on" : ""} onClick={() => setKind("archive")}>
                <Icon name="archive" size={15} /> Archive (split)
              </button>
            </div>
          </div>

          <div className="field">
            <label>
              Title{" "}
              {kind === "archive" ? (
                <span className="hint">— include version, e.g. &quot;Archive 1.0.0&quot;</span>
              ) : (
                <span className="hint">— default for added files; edit per file in the queue</span>
              )}
            </label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === "archive" ? "Archive 1.0.0" : "(optional) auto-filled from filename"}
            />
          </div>

          <div className="up-row">
            <div className="field" style={{ flex: 1 }}>
              <label>
                Categories <span className="hint">— {kind === "archive" ? '"Archive"' : '"Image"/"Video"'} added automatically by type</span>
              </label>
              <TagPicker value={tags} onChange={setTags} suggestions={allTags} placeholder="rpg, fantasy" />
            </div>
            {kind === "archive" && (
              <div className="field" style={{ width: 150 }}>
                <label>Part size (MB)</label>
                <input
                  className="input"
                  type="number"
                  value={partSize}
                  min={1}
                  max={1990}
                  onChange={(e) => setPartSize(parseInt(e.target.value) || 1500)}
                />
              </div>
            )}
          </div>

          <div className="field">
            <label>Source</label>
            <div className="seg-radio">
              <button className={mode === "device" ? "on" : ""} onClick={() => setMode("device")}>
                <Icon name="upload" size={15} /> Upload from this device
              </button>
              <button className={mode === "laptop" ? "on" : ""} onClick={() => setMode("laptop")}>
                <Icon name="folder" size={15} /> Host path (advanced)
              </button>
            </div>
          </div>

          {mode === "device" ? (
            <div className="up-pickers">
              <label className="btn">
                <input
                  type="file"
                  hidden
                  multiple
                  onChange={(e) => {
                    addFiles(Array.from(e.target.files ?? []), false);
                    e.currentTarget.value = "";
                  }}
                />
                <Icon name="upload" size={16} /> Add file(s) to queue
              </label>
              <label className="btn">
                <input
                  type="file"
                  hidden
                  multiple
                  // webkitdirectory/directory are non-standard but widely supported.
                  {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                  onChange={(e) => {
                    addFiles(Array.from(e.target.files ?? []), true);
                    e.currentTarget.value = "";
                  }}
                />
                <Icon name="folder" size={16} /> Add folder to queue
              </label>
              <span className="pick-note" style={{ margin: 0, alignSelf: "center" }}>
                Files are queued first — set titles/tags below, then Start.
              </span>
            </div>
          ) : (
            <>
              <div className="field">
                <label>{kind === "archive" ? "Archive folder/file" : "Media file"} path on the host</label>
                <div className="pick-row">
                  <button type="button" className="btn" onClick={() => setBrowse(true)}>
                    <Icon name={kind === "archive" ? "folder" : "upload"} size={16} />
                    Browse…
                  </button>
                  <input
                    className="input"
                    value={sourcePath}
                    onChange={(e) => setSourcePath(e.target.value)}
                    placeholder="path on the machine running the watcher: C:\… or /data/…"
                  />
                </div>
                <div className="pick-note">
                  Reads a file already on the machine that runs the watcher (no transfer).
                </div>
              </div>
              {err && <div className="up-err">{err}</div>}
              <div className="up-actions">
                <button className="btn primary" onClick={submitHostPath} disabled={isPending}>
                  {isPending ? <span className="spinner sm" /> : <Icon name="plus" size={16} stroke={2} />}
                  Add to queue
                </button>
              </div>
            </>
          )}
        </div>

        {/* UNIFIED QUEUE */}
        <div className="up-listhead">
          <h2>
            Queue {hasActive && <span className="up-live">● live</span>}
          </h2>
          <div style={{ display: "flex", gap: 8 }}>
            {readyCount > 0 && !uploadingNow && (
              <button className="btn primary" onClick={startAll}>
                <Icon name="upload" size={15} /> Start ({readyCount + queuedJobCount})
              </button>
            )}
            {uploadingNow && (
              <>
                <button className="btn" onClick={pauseRun}>Pause</button>
                <button className="btn subtle" onClick={cancelRun}>Stop</button>
              </>
            )}
            {!uploadingNow && readyCount === 0 && queuedJobCount > 0 && (
              <button className="btn primary" onClick={() => startTransition(() => startAllUploads())}>
                <Icon name="upload" size={15} /> Start all ({queuedJobCount})
              </button>
            )}
            {jobs.some((j) => ["done", "error", "canceled"].includes(j.status)) && (
              <button className="btn subtle" onClick={() => startTransition(() => clearFinishedUploads())}>
                <Icon name="trash" size={15} /> Clear finished
              </button>
            )}
          </div>
        </div>

        {totalRows === 0 ? (
          <div className="up-empty">No uploads queued. Add files above.</div>
        ) : (
          <>
            <div className="up-list">
              {visibleLocal.map((it) => (
                <LocalRow
                  key={it.id}
                  item={it}
                  tags={allTags}
                  speed={speed}
                  onEdit={(patch) => updateLocal(it.id, patch)}
                  onStart={() => runQueue()}
                  onRemove={() => removeLocal(it.id)}
                />
              ))}
              {shownJobs.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  tags={allTags}
                  onCancel={() => startTransition(() => cancelUpload(j.id))}
                  onStart={() => startTransition(() => startUpload(j.id))}
                  onRetry={() => startTransition(() => retryUpload(j.id))}
                  onSaveMeta={(title, tags) =>
                    startTransition(async () => {
                      await updateUploadJob(j.id, { title, tags });
                      router.refresh();
                    })
                  }
                />
              ))}
            </div>
            {jobs.length > shownJobs.length + 0 && (hiddenJobCount > 0 || showAllJobs) && jobs.length > JOBS_COLLAPSED && (
              <button className="up-expand" onClick={() => setShowAllJobs((v) => !v)}>
                <Icon name={showAllJobs ? "chevup" : "chevdown"} size={15} />
                {showAllJobs ? "Show less" : `Show ${hiddenJobCount} more`}
              </button>
            )}
          </>
        )}
      </div>

      {browse && (
        <FsBrowser
          mode={kind === "archive" ? "dir" : "file"}
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

// A client-side queue item (browser → VPS phase).
function LocalRow({
  item,
  tags,
  speed,
  onEdit,
  onStart,
  onRemove,
}: {
  item: LocalItem;
  tags: Tag[];
  speed: number;
  onEdit: (patch: Partial<LocalItem>) => void;
  onStart: () => void;
  onRemove: () => void;
}) {
  const pct = item.size ? Math.floor((item.sent / item.size) * 100) : 0;
  const badge =
    item.stage === "ready" ? "Ready"
    : item.stage === "uploading" ? "Uploading → VPS"
    : item.stage === "finalizing" || item.stage === "done" ? "Queuing"
    : "Failed";
  const badgeClass =
    item.stage === "error" ? "st-error" : item.stage === "ready" ? "st-queued" : "st-running";

  return (
    <div className="up-job">
      <div className={"up-badge " + badgeClass}>{badge}</div>
      <div className="up-job-main">
        {item.stage === "ready" ? (
          <div className="up-edit">
            <input
              className="input"
              value={item.title}
              placeholder="Title"
              onChange={(e) => onEdit({ title: e.target.value })}
            />
            <TagPicker value={item.tags} onChange={(t) => onEdit({ tags: t })} suggestions={tags} />
            <div className="up-edit-meta">
              <span className="up-kind">{item.kind}</span> · {item.name} · {fmtSize(item.size)}
            </div>
          </div>
        ) : (
          <>
            <div className="up-job-title">
              {item.title} <span className="up-kind">{item.kind}</span>
            </div>
            <div className="up-job-path">{item.name} · {fmtSize(item.size)}</div>
            {item.stage === "uploading" && (
              <div className="up-bar">
                <span style={{ width: pct + "%" }} />
              </div>
            )}
            {item.error && <div className="up-job-msg up-err">{item.error}</div>}
          </>
        )}
      </div>
      <div className="up-job-side">
        {item.stage === "uploading" && (
          <>
            <div className="up-pct">{pct}%</div>
            <div className="up-job-time">{fmtSize(item.sent)} / {fmtSize(item.size)}{speed > 0 ? ` · ${fmtSize(speed)}/s` : ""}</div>
          </>
        )}
        {item.stage === "ready" && (
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn primary sm" onClick={onStart}>Start</button>
            <button className="btn subtle sm" onClick={onRemove}>Remove</button>
          </div>
        )}
        {item.stage === "error" && (
          <button className="btn primary sm" onClick={onStart}>Retry</button>
        )}
        {(item.stage === "finalizing" || item.stage === "done") && <span className="spinner sm" />}
      </div>
    </div>
  );
}

function JobRow({
  job,
  tags,
  onCancel,
  onStart,
  onRetry,
  onSaveMeta,
}: {
  job: UploadJob;
  tags: Tag[];
  onCancel: () => void;
  onStart: () => void;
  onRetry: () => void;
  onSaveMeta: (title: string, tags: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState(job.title);
  const [eTags, setETags] = useState(job.tags || "");

  return (
    <div className="up-job">
      <div className={"up-badge st-" + job.status}>{STATUS_LABEL[job.status]}</div>
      <div className="up-job-main">
        {editing ? (
          <div className="up-edit">
            <input className="input" value={eTitle} onChange={(e) => setETitle(e.target.value)} placeholder="Title" />
            <TagPicker value={eTags} onChange={setETags} suggestions={tags} />
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="btn primary sm"
                onClick={() => {
                  onSaveMeta(eTitle, eTags);
                  setEditing(false);
                }}
              >
                Save
              </button>
              <button className="btn subtle sm" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div className="up-job-title">
              {job.title} <span className="up-kind">{job.kind}</span>
              {job.origin === "upload" && <span className="up-kind">uploaded</span>}
            </div>
            <div className="up-job-path" title={job.sourcePath}>{job.sourcePath}</div>
            {job.status === "running" && (
              <div className="up-bar">
                <span style={{ width: job.progress + "%" }} />
              </div>
            )}
            {job.message && <div className="up-job-msg">{job.message}</div>}
          </>
        )}
      </div>
      {!editing && (
        <div className="up-job-side">
          <div className="up-job-time">{fmtDate(job.updatedAt)}</div>
          {job.status === "running" && <div className="up-pct">{job.progress}%</div>}
          {job.status === "queued" && (
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn primary sm" onClick={onStart}>Start</button>
              <button className="btn subtle sm" onClick={() => setEditing(true)}>Edit</button>
              <button className="btn subtle sm" onClick={onCancel}>Cancel</button>
            </div>
          )}
          {job.status === "pending" && (
            <button className="btn subtle sm" onClick={onCancel}>Cancel</button>
          )}
          {job.status === "error" && (
            <button className="btn primary sm" onClick={onRetry}>Retry</button>
          )}
        </div>
      )}
    </div>
  );
}
