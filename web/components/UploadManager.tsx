"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/lib/icons";
import { fmtDate } from "@/lib/format";
import type { Kind, UploadJob, UploadStatus, WatcherStatus } from "@/lib/types";
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
  queued: "Antri",
  pending: "Menunggu watcher",
  running: "Mengunggah",
  done: "Selesai",
  error: "Gagal",
  canceled: "Dibatalkan",
};

// Nama dasar dari path → tebak judul (buang -pc, ganti -/_ jadi spasi).
function deriveTitle(p: string): string {
  const base = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  return base.replace(/-pc$/i, "").replace(/[-_]+/g, " ").trim();
}

export function UploadManager({ jobs, watcher }: { jobs: UploadJob[]; watcher: WatcherStatus }) {
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

  // Selalu poll agar status watcher & progress tetap live (lebih cepat saat ada job aktif).
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
        setErr(e instanceof Error ? e.message : "Gagal menambah antrian.");
      }
    });
  };

  const onStartWatcher = async () => {
    setWatcherErr(null);
    setWatcherBusy(true);
    try {
      const r = await startWatcher();
      if (!r.ok) setWatcherErr(r.error ?? "Gagal menjalankan watcher.");
    } finally {
      setWatcherBusy(false);
      router.refresh();
    }
  };

  const onStopWatcher = async () => {
    if (
      watcher.status === "busy" &&
      !window.confirm("Watcher sedang mengupload. Hentikan paksa? Upload yang sedang berjalan akan gagal.")
    )
      return;
    setWatcherErr(null);
    setWatcherBusy(true);
    try {
      const r = await stopWatcher();
      if (!r.ok) setWatcherErr(r.error ?? "Gagal menghentikan watcher.");
    } finally {
      setWatcherBusy(false);
      router.refresh();
    }
  };

  return (
    <div className="up-wrap scroll">
      <div className="up-inner">
        <div className="up-head">
          <a className="btn subtle" href="/">
            <Icon name="back" size={16} />
            Kembali
          </a>
          <h1>Upload via laptop</h1>
        </div>

        {/* PERINGATAN */}
        <div className="up-warn">
          <Icon name="warn" size={20} />
          <div>
            <strong>Laptop harus menyala &amp; watcher aktif.</strong> File besar diupload dari
            laptop (lewat Telegram MTProto), <em>bukan</em> dari browser ini. Form di bawah hanya
            menaruh antrian — lalu nyalakan watcher (tombol di bawah) dan klik <b>Mulai</b>. Jangan
            matikan laptop saat status masih <b>Mengunggah</b>.
          </div>
        </div>

        {/* STATUS + KONTROL WATCHER */}
        <div className="watcher-row">
          <span className={"wdot " + (watcher.online ? (watcher.status === "busy" ? "busy" : "on") : "off")} />
          <span className="wlabel">
            {watcher.online
              ? watcher.status === "busy"
                ? "Watcher memproses upload…"
                : "Watcher aktif"
              : "Watcher tidak aktif"}
          </span>
          {watcher.online ? (
            <button className="btn subtle sm wbtn" onClick={onStopWatcher} disabled={watcherBusy}>
              {watcherBusy ? <span className="spinner sm" /> : <Icon name="power" size={14} />}
              Matikan watcher
            </button>
          ) : (
            <button className="btn primary sm wbtn" onClick={onStartWatcher} disabled={watcherBusy}>
              {watcherBusy ? <span className="spinner sm" /> : <Icon name="power" size={14} />}
              Nyalakan watcher
            </button>
          )}
        </div>
        {watcherErr && <div className="up-err">{watcherErr}</div>}
        {activeCount > 0 && !watcher.online && (
          <div className="up-warn danger">
            <Icon name="warn" size={20} />
            <div>
              <strong>{activeCount} upload menunggu tapi watcher tidak aktif.</strong> Klik{" "}
              <b>Nyalakan watcher</b> di atas agar proses berjalan.
            </div>
          </div>
        )}

        {/* FORM */}
        <div className="up-form">
          <div className="field">
            <label>Jenis</label>
            <div className="seg-radio">
              <button className={kind === "game" ? "on" : ""} onClick={() => setKind("game")}>
                <Icon name="archive" size={15} /> Game (di-split)
              </button>
              <button className={kind === "media" ? "on" : ""} onClick={() => setKind("media")}>
                <Icon name="video" size={15} /> Media (1 file)
              </button>
            </div>
          </div>

          <div className="field">
            <label>
              Judul{" "}
              {kind === "game" ? (
                <span className="hint">— sertakan versi, mis. &quot;ReRudy 0.6.0&quot;</span>
              ) : (
                <span className="hint">— opsional, otomatis dari nama file bila dikosongkan</span>
              )}
            </label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === "game" ? "ReRudy 0.6.0" : "(opsional) otomatis dari nama file"}
            />
          </div>

          <div className="field">
            <label>{kind === "game" ? "Folder game" : "File media"} di laptop</label>
            <div className="pick-row">
              <button type="button" className="btn" onClick={() => setBrowse(true)}>
                <Icon name={kind === "game" ? "folder" : "upload"} size={16} />
                Telusuri laptop…
              </button>
              <input
                className="input"
                value={sourcePath}
                onChange={(e) => setSourcePath(e.target.value)}
                placeholder="path terisi otomatis — atau tempel manual: C:\…"
              />
            </div>
            <div className="pick-note">
              Telusuri langsung folder/file asli di laptop — path lengkap (termasuk OneDrive) terisi
              otomatis. Tak perlu salin-tempel manual.
            </div>
          </div>

          <div className="up-row">
            <div className="field" style={{ flex: 1 }}>
              <label>Tag (pisahkan koma)</label>
              <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="rpg, fantasy" />
            </div>
            {kind === "game" && (
              <div className="field" style={{ width: 150 }}>
                <label>Ukuran part (MB)</label>
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
              Tambah ke antrian
            </button>
          </div>
        </div>

        {/* ANTRIAN */}
        <div className="up-listhead">
          <h2>Antrian {hasActive && <span className="up-live">● live</span>}</h2>
          <div style={{ display: "flex", gap: 8 }}>
            {queuedCount > 0 && (
              <button className="btn primary" onClick={() => startTransition(() => startAllUploads())}>
                <Icon name="upload" size={15} /> Mulai semua ({queuedCount})
              </button>
            )}
            {jobs.some((j) => ["done", "error", "canceled"].includes(j.status)) && (
              <button className="btn subtle" onClick={() => startTransition(() => clearFinishedUploads())}>
                <Icon name="trash" size={15} /> Bersihkan selesai
              </button>
            )}
          </div>
        </div>

        {jobs.length === 0 ? (
          <div className="up-empty">Belum ada antrian upload.</div>
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
              Mulai
            </button>
            <button className="btn subtle sm" onClick={onCancel}>
              Batal
            </button>
          </div>
        )}
        {job.status === "pending" && (
          <button className="btn subtle sm" onClick={onCancel}>
            Batal
          </button>
        )}
      </div>
    </div>
  );
}
