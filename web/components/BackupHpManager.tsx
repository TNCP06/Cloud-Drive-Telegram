"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useUpload } from "@/components/UploadProvider";
import { useLiveRefresh } from "@/lib/useLiveRefresh";
import { fmtSize } from "@/lib/format";
import { Icon } from "@/lib/icons";
import type { UploadJob } from "@/lib/types";
import { cancelUpload, retryAllFailedUploads, retryUpload, clearFinishedUploads } from "@/app/actions";

// Brake thresholds come from the server (/api/staging-status → env-tunable
// BACKUP_PAUSE_GB / BACKUP_RESUME_GB); the local numbers are only a fallback
// for an outdated response. Hysteresis (pause low, resume higher) avoids
// stop-start flapping, so a 30 GB folder can be left overnight.
const FALLBACK_PAUSE_BELOW = 3 * 1024 * 1024 * 1024;
const FALLBACK_RESUME_ABOVE = 4.5 * 1024 * 1024 * 1024;

interface StagingStatus {
  freeBytes: number | null;
  pendingBytes: number;
  activeJobs: number;
  pauseBelow?: number;
  resumeAbove?: number;
}

export function BackupHpManager({ jobs, stats }: { jobs: UploadJob[]; stats: Record<string, number> }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { items, speed, uploadingNow, readyCount, persistFailed, addFiles, runQueue, pauseRun, retryAllFailed, removeLocal } = useUpload();
  const [disk, setDisk] = useState<StagingStatus | null>(null);
  const [autoPaused, setAutoPaused] = useState(false);

  // Server job transitions (running → done/error) arrive by PUSH like /upload —
  // without this the list/counts below would freeze at page-load values.
  useLiveRefresh("upload", { debounceMs: 1000 });

  // VPS disk health, polled so the page can pace itself.
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch("/api/staging-status");
        if (r.ok && !stop) setDisk(await r.json());
      } catch {
        /* offline — the queue itself keeps retrying */
      }
    };
    void load();
    const t = setInterval(load, 10000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  // Safety brake: stop staging new files when the VPS disk runs tight. The
  // watcher keeps draining what is already staged, so space recovers on its own
  // — and staging resumes by itself once there is room again.
  const pauseBelow = disk?.pauseBelow ?? FALLBACK_PAUSE_BELOW;
  const resumeAbove = disk?.resumeAbove ?? FALLBACK_RESUME_ABOVE;
  useEffect(() => {
    if (
      uploadingNow &&
      disk?.freeBytes != null &&
      disk.freeBytes < pauseBelow
    ) {
      pauseRun();
      setAutoPaused(true);
    } else if (
      autoPaused &&
      disk?.freeBytes != null &&
      disk.freeBytes > resumeAbove &&
      readyCount > 0
    ) {
      setAutoPaused(false);
      runQueue();
    }
  }, [uploadingNow, autoPaused, readyCount, disk, pauseBelow, resumeAbove, pauseRun, runQueue]);

  const add = (files: File[], folder: boolean) =>
    addFiles(files, folder, {
      kind: "media", // per-file auto: > ~2 GB splits, the rest stays single media
      autoKind: true,
      title: "",
      tags: "hp-backup",
      partSize: 1500,
      folderPath: "HP Backup",
    });

  const localFailed = items.filter((i) => i.stage === "error").length;
  // Totals come from the server (the job list is capped) — a phone backup can
  // queue hundreds of files, so counting the visible slice would under-report.
  const serverFailed = stats.error ?? 0;
  const failed = localFailed + serverFailed;
  const serverActive = (stats.queued ?? 0) + (stats.pending ?? 0) + (stats.running ?? 0);
  const serverDone = stats.done ?? 0;

  const retryAll = () => {
    setAutoPaused(false);
    retryAllFailed(); // local (browser→VPS) failures back to the queue
    startTransition(() => retryAllFailedUploads()); // server (VPS→Telegram) failures
  };

  return (
    <div className="up-wrap scroll">
      <div className="up-inner">
        <div className="up-head">
          <button className="btn subtle" type="button" onClick={() => router.back()}>
            <Icon name="back" size={16} />
            Back
          </button>
          <h1>Backup HP</h1>
        </div>

        <div className="pick-note" style={{ marginBottom: 12 }}>
          Arsip isi HP lama ke Telegram, sekali jalan. Pilih folder (mis. DCIM, lalu
          WhatsApp, Download — menumpuk jadi satu antrean), tekan <b>Mulai</b>, lalu
          biarkan: tiap file otomatis berjudul dari nama foldernya, file besar
          otomatis dipecah, dan yang gagal bisa diulang <b>sekaligus</b> dengan satu
          tombol. Colok charger dan biarkan tab ini terbuka — kalau HP mati/hang,
          buka lagi halaman ini untuk lanjut dari posisi terakhir (tidak mengulang
          dari nol). Tips hemat: file kecil (≤ ~2 GB) lebih cepat & gratis-egress
          lewat bot Telegram (<b>/backup</b>, kirim file ke bot); halaman ini
          wajib hanya untuk file besar & folder.
        </div>

        {/* Disk + progress summary */}
        <div className="up-listhead">
          <h2>
            Status {uploadingNow && <span className="up-live">● mengunggah</span>}
          </h2>
          {speed > 0 && <span className="up-job-time">{fmtSize(speed)}/s</span>}
        </div>
        <div className="up-job">
          <div className="up-job-main">
            <div className="up-job-title">
              VPS {disk?.freeBytes != null ? `sisa ${fmtSize(disk.freeBytes)}` : "…"}
              <span className="up-kind">
                {disk ? `${fmtSize(disk.pendingBytes)} menunggu` : ""}
              </span>
            </div>
            <div className="up-job-path">
              Antre HP: {items.filter((i) => i.stage === "ready").length} siap ·{" "}
              {items.filter((i) => i.stage === "uploading").length} terkirim ·{" "}
              {localFailed} gagal · VPS aktif: {serverActive} · Selesai: {serverDone} ·{" "}
              Gagal di VPS: {serverFailed}
            </div>
            {autoPaused && (
              <div className="up-job-msg up-err">
                Jeda otomatis: disk VPS menipis. Watcher sedang mengosongkan antrean —
                staging lanjut sendiri setelah disk pulih.
              </div>
            )}
            {persistFailed > 0 && (
              <div className="up-job-msg up-err">
                {persistFailed} file tidak tersimpan di browser ini (memori/kuota penuh?) —
                tetap terkirim sesi ini, tapi JANGAN tutup tab sampai selesai. Kalau
                browser mati, pilih ulang folder yang sama untuk lanjut (server
                mengenali file yang sudah terkirim).
              </div>
            )}
          </div>
        </div>

        {/* Pickers + controls */}
        <div className="up-pickers" style={{ marginTop: 12 }}>
          <label className="btn">
            <input
              type="file"
              hidden
              multiple
              onChange={(e) => {
                add(Array.from(e.target.files ?? []), false);
                e.currentTarget.value = "";
              }}
            />
            <Icon name="upload" size={16} /> Tambah file
          </label>
          <label className="btn">
            <input
              type="file"
              hidden
              multiple
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(e) => {
                add(Array.from(e.target.files ?? []), true);
                e.currentTarget.value = "";
              }}
            />
            <Icon name="folder" size={16} /> Tambah folder (DCIM…)
          </label>
        </div>
        <div className="up-actions" style={{ marginTop: 8 }}>
          {!uploadingNow && (
            <button className="btn primary" onClick={() => { setAutoPaused(false); runQueue(); }}>
              <Icon name="upload" size={15} /> Mulai / Lanjutkan
            </button>
          )}
          {uploadingNow && (
            <button className="btn" onClick={pauseRun}>Jeda</button>
          )}
          {failed > 0 && (
            <button className="btn primary" onClick={retryAll} disabled={isPending}>
              <Icon name="upload" size={15} /> Ulangi {failed} yang gagal
            </button>
          )}
          {jobs.some((j) => ["done", "error", "canceled"].includes(j.status)) && (
            <button
              className="btn subtle"
              onClick={() => startTransition(() => { clearFinishedUploads(); router.refresh(); })}
            >
              <Icon name="trash" size={15} /> Bersihkan riwayat selesai
            </button>
          )}
        </div>
        <div className="pick-note">
          Kalau browser mati/hang total: buka lagi halaman ini, pilih ulang folder yang
          sama — file yang sudah terkirim dikenali dari server dan tidak diulang.
        </div>

        {/* Failed files (names, so the user knows WHAT failed) */}
        {(localFailed > 0 || serverFailed > 0) && (
          <>
            <div className="up-listhead" style={{ marginTop: 16 }}>
              <h2>Gagal ({failed})</h2>
            </div>
            <div className="up-list">
              {items.filter((i) => i.stage === "error").map((it) => (
                <div className="up-job" key={it.id}>
                  <div className="up-badge st-error">Gagal di HP</div>
                  <div className="up-job-main">
                    <div className="up-job-title">{it.title || it.name}</div>
                    <div className="up-job-path">{it.name} · {fmtSize(it.size)}</div>
                    {it.error && <div className="up-job-msg up-err">{it.error}</div>}
                  </div>
                  <div className="up-job-side">
                    <button className="btn subtle sm" onClick={() => removeLocal(it.id)}>
                      Buang
                    </button>
                  </div>
                </div>
              ))}
              {jobs.filter((j) => j.status === "error").map((j) => (
                <div className="up-job" key={j.id}>
                  <div className="up-badge st-error">Gagal di VPS</div>
                  <div className="up-job-main">
                    <div className="up-job-title">{j.title}</div>
                    {j.message && <div className="up-job-msg up-err">{j.message}</div>}
                  </div>
                  <div className="up-job-side" style={{ display: "flex", gap: 6 }}>
                    <button
                      className="btn primary sm"
                      onClick={() => startTransition(() => retryUpload(j.id))}
                    >
                      Retry
                    </button>
                    <button
                      className="btn subtle sm"
                      title="Menyerah pada file ini + hapus sisa staging-nya dari VPS"
                      onClick={() => startTransition(() => cancelUpload(j.id))}
                    >
                      Buang
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Recent server jobs */}
        {jobs.length > 0 && (
          <>
            <div className="up-listhead" style={{ marginTop: 16 }}>
              <h2>Antre VPS → Telegram ({serverActive + serverDone + serverFailed} total, 20 terbaru)</h2>
            </div>
            <div className="up-list">
              {jobs.slice(0, 20).map((j) => (
                <div className="up-job" key={j.id}>
                  <div className={"up-badge st-" + j.status}>{j.status}</div>
                  <div className="up-job-main">
                    <div className="up-job-title">{j.title}</div>
                    {j.status === "running" && (
                      <div className="up-bar">
                        <span style={{ width: j.progress + "%" }} />
                      </div>
                    )}
                    {j.message && <div className="up-job-msg">{j.message}</div>}
                  </div>
                  <div className="up-job-side">
                    {j.status === "running" && <div className="up-pct">{j.progress}%</div>}
                    {j.status === "error" && (
                      <button
                        className="btn primary sm"
                        onClick={() => startTransition(() => retryUpload(j.id))}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
