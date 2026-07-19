import Link from "next/link";
import { statfsSync } from "fs";
import { db } from "@/lib/db";
import { fmtSize } from "@/lib/format";

// Live "graphify" page: system map + drive statistics straight from Postgres + the disk.
// Server component, re-queried per request; auth comes from the global middleware.
export const dynamic = "force-dynamic";

async function getStats() {
  const [kinds, parts, tags, dl, dlSrc, unp, ups, kept, trash] = await Promise.all([
    db.execute(
      "SELECT kind, count(*) AS n, coalesce(sum(total_size),0) AS bytes FROM items " +
        "WHERE deleted_at IS NULL GROUP BY kind"
    ),
    db.execute("SELECT count(*) AS n, coalesce(sum(file_size),0) AS bytes FROM parts"),
    db.execute(
      "SELECT t.name, count(*) AS n FROM item_tags it JOIN tags t ON t.id=it.tag_id " +
        "JOIN items i ON i.id=it.item_id WHERE i.deleted_at IS NULL " +
        "GROUP BY t.name ORDER BY n DESC LIMIT 8"
    ),
    db.execute("SELECT status, count(*) AS n FROM download_jobs GROUP BY status"),
    db.execute(
      "SELECT source, count(*) AS n, coalesce(sum(size),0) AS bytes FROM download_jobs " +
        "WHERE status='done' GROUP BY source ORDER BY bytes DESC"
    ),
    db.execute("SELECT status, count(*) AS n FROM unpack_jobs GROUP BY status"),
    db.execute("SELECT status, count(*) AS n FROM upload_jobs GROUP BY status"),
    db.execute("SELECT count(*) AS n, coalesce(sum(size),0) AS bytes FROM unpack_kept"),
    db.execute("SELECT count(*) AS n FROM items WHERE deleted_at IS NOT NULL"),
  ]);

  let disk = { total: 0, free: 0 };
  try {
    const s = statfsSync(process.env.UPLOAD_STAGING_DIR || "/staging");
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    /* non-Linux dev machine — leave zeros */
  }

  const byStatus = (rs: { rows: Record<string, unknown>[] }) =>
    Object.fromEntries(rs.rows.map((r) => [String(r.status), Number(r.n)]));

  const kind = Object.fromEntries(
    kinds.rows.map((r) => [String(r.kind), { n: Number(r.n), bytes: Number(r.bytes) }])
  ) as Record<string, { n: number; bytes: number }>;

  return {
    media: kind.media ?? { n: 0, bytes: 0 },
    archive: kind.archive ?? { n: 0, bytes: 0 },
    parts: { n: Number(parts.rows[0]?.n ?? 0), bytes: Number(parts.rows[0]?.bytes ?? 0) },
    tags: tags.rows.map((r) => ({ name: String(r.name), n: Number(r.n) })),
    dl: byStatus(dl),
    dlSrc: dlSrc.rows.map((r) => ({
      source: String(r.source), n: Number(r.n), bytes: Number(r.bytes),
    })),
    unpack: byStatus(unp),
    uploads: byStatus(ups),
    kept: { n: Number(kept.rows[0]?.n ?? 0), bytes: Number(kept.rows[0]?.bytes ?? 0) },
    trash: Number(trash.rows[0]?.n ?? 0),
    disk,
  };
}

const FLOW = [
  {
    label: "Store",
    hops: ["Browser / Bot Drop", "staging volume", "watcher (split + Bot API)", "Telegram channel"],
  },
  {
    label: "Pull",
    hops: ["Baidu · PikPak", "OpenList / rclone", "staging volume", "watcher", "Telegram channel"],
  },
  {
    label: "Unpack",
    hops: ["Telegram channel", "concat + 7z (watcher)", "≤2 GB → re-upload · >2 GB → _keep 72h"],
  },
  {
    label: "Watch",
    hops: ["Telegram channel", "streamer (cache + transcode)", "browser player"],
  },
];

export default async function StatsPage() {
  const s = await getStats();
  const usedPct = s.disk.total ? Math.round(((s.disk.total - s.disk.free) / s.disk.total) * 100) : 0;
  const mediaPct = s.parts.bytes
    ? Math.round((s.media.bytes / (s.media.bytes + s.archive.bytes)) * 100)
    : 0;
  const maxTag = Math.max(1, ...s.tags.map((t) => t.n));

  const chip = (label: string, n: number | undefined, tone: string) =>
    n ? (
      <span className={`st-chip st-${tone}`} key={label}>
        {label} <b>{n}</b>
      </span>
    ) : null;

  return (
    <div className="stats-wrap scroll">
      <style>{`
        .stats-wrap { padding: 28px 20px 60px; overflow-y: auto; height: 100dvh; }
        .stats-inner { max-width: 980px; margin: 0 auto; }
        .stats-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
        .stats-head h1 { font-size: 22px; margin: 0 12px 0 0; letter-spacing: -.02em; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 18px; }
        .stats-card { background: var(--card); border: 1px solid var(--line-2); border-radius: 12px; padding: 16px 18px; }
        .stats-card .k { font-size: 11.5px; color: var(--faint); text-transform: uppercase; letter-spacing: .07em; }
        .stats-card .v { font-size: 26px; font-weight: 700; margin: 3px 0 1px; }
        .stats-card .d { font-size: 12.5px; color: var(--muted); }
        .stats-sec { margin-top: 26px; }
        .stats-sec h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--faint); margin: 0 0 10px; }
        .meter { height: 22px; border-radius: 6px; overflow: hidden; display: flex; gap: 2px; background: var(--card-2); }
        .meter span { height: 100%; }
        .lg { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; font-size: 12.5px; color: var(--muted); }
        .lg i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
        .flow-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px dashed var(--line-2); font-size: 13px; }
        .flow-row .fl { width: 64px; font-weight: 650; color: var(--ink); flex-shrink: 0; }
        .hop { background: var(--card-2); border: 1px solid var(--line-2); border-radius: 7px; padding: 3px 9px; color: var(--ink-2); }
        .arr { color: var(--faint); }
        .tag-row { display: grid; grid-template-columns: minmax(90px, max-content) 1fr max-content; gap: 6px 12px; align-items: center; }
        .tag-row .tn { font-size: 13px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tag-row .tb { background: var(--card-2); border-radius: 4px; height: 13px; }
        .tag-row .tb span { display: block; height: 100%; border-radius: 4px; background: var(--accent); }
        .tag-row .tv { font-size: 12px; color: var(--faint); font-variant-numeric: tabular-nums; }
        .st-chip { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--line-2); border-radius: 99px; padding: 3px 11px; font-size: 12.5px; color: var(--ink-2); margin: 0 6px 6px 0; }
        .st-chip b { font-variant-numeric: tabular-nums; }
        .st-chip.st-ok b { color: var(--ok, #0ca30c); }
        .st-chip.st-bad b { color: var(--red, #d03b3b); }
        .st-chip.st-run b { color: var(--accent); }
      `}</style>
      <div className="stats-inner">
        <div className="stats-head">
          <h1>System map &amp; stats</h1>
          <Link className="btn subtle" href="/">← Back to drive</Link>
        </div>

        <div className="stats-grid">
          <div className="stats-card">
            <div className="k">Stored in Telegram</div>
            <div className="v">{fmtSize(s.parts.bytes)}</div>
            <div className="d">{s.parts.n} parts — the real storage</div>
          </div>
          <div className="stats-card">
            <div className="k">Items</div>
            <div className="v">{s.media.n + s.archive.n}</div>
            <div className="d">{s.media.n} media · {s.archive.n} archives · {s.trash} in trash</div>
          </div>
          <div className="stats-card">
            <div className="k">VPS disk free</div>
            <div className="v">{fmtSize(s.disk.free)}</div>
            <div className="d">of {fmtSize(s.disk.total)} ({usedPct}% used)</div>
          </div>
          <div className="stats-card">
            <div className="k">Kept on server</div>
            <div className="v">{s.kept.n ? fmtSize(s.kept.bytes) : "—"}</div>
            <div className="d">{s.kept.n} file(s) &gt; 2 GB awaiting download</div>
          </div>
        </div>

        <div className="stats-sec">
          <h2>How data moves</h2>
          <div className="stats-card">
            {FLOW.map((f) => (
              <div className="flow-row" key={f.label}>
                <span className="fl">{f.label}</span>
                {f.hops.map((h, i) => (
                  <span key={h} style={{ display: "contents" }}>
                    {i > 0 && <span className="arr">→</span>}
                    <span className="hop">{h}</span>
                  </span>
                ))}
              </div>
            ))}
            <div className="lg" style={{ marginTop: 10 }}>
              Processes only talk through Postgres job queues (upload · download · unpack).
            </div>
          </div>
        </div>

        <div className="stats-sec">
          <h2>Stored bytes by kind</h2>
          <div className="stats-card">
            <div className="meter" role="img" aria-label="media vs archive bytes">
              <span style={{ width: `${mediaPct}%`, background: "var(--accent)" }} />
              <span style={{ width: `${100 - mediaPct}%`, background: "var(--ok, #1baf7a)" }} />
            </div>
            <div className="lg">
              <span><i style={{ background: "var(--accent)" }} />Media · {s.media.n} items · {fmtSize(s.media.bytes)}</span>
              <span><i style={{ background: "var(--ok, #1baf7a)" }} />Archives · {s.archive.n} items · {fmtSize(s.archive.bytes)}</span>
            </div>
          </div>
        </div>

        <div className="stats-sec">
          <h2>Top tags</h2>
          <div className="stats-card">
            <div className="tag-row">
              {s.tags.map((t) => (
                <span key={t.name} style={{ display: "contents" }}>
                  <span className="tn">{t.name}</span>
                  <span className="tb"><span style={{ width: `${(t.n / maxTag) * 100}%` }} /></span>
                  <span className="tv">{t.n}</span>
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="stats-sec">
          <h2>Jobs</h2>
          <div className="stats-grid" style={{ marginTop: 0 }}>
            <div className="stats-card">
              <div className="k" style={{ marginBottom: 8 }}>Remote downloads</div>
              {chip("done", s.dl.done, "ok")}
              {chip("failed", s.dl.failed, "bad")}
              {chip("active", (s.dl.queued ?? 0) + (s.dl.downloading ?? 0) + (s.dl.uploading ?? 0) + (s.dl.downloaded ?? 0), "run")}
              {chip("paused", s.dl.paused, "run")}
              <div className="d" style={{ marginTop: 6 }}>
                {s.dlSrc.map((d) => `${d.source}: ${d.n} · ${fmtSize(d.bytes)}`).join(" — ") || "no pulls yet"}
              </div>
            </div>
            <div className="stats-card">
              <div className="k" style={{ marginBottom: 8 }}>Uploads → Telegram</div>
              {chip("done", s.uploads.done, "ok")}
              {chip("running", s.uploads.running, "run")}
              {chip("queued", (s.uploads.queued ?? 0) + (s.uploads.pending ?? 0), "run")}
              {chip("error", s.uploads.error, "bad")}
            </div>
            <div className="stats-card">
              <div className="k" style={{ marginBottom: 8 }}>Archive unpacks</div>
              {chip("done", s.unpack.done, "ok")}
              {chip("active", (s.unpack.queued ?? 0) + (s.unpack.running ?? 0), "run")}
              {chip("failed", s.unpack.failed, "bad")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
