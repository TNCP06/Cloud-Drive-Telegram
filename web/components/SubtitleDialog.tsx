"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/lib/icons";
import { fmtSize } from "@/lib/format";
import { listDriveSubtitleFiles, type DriveSubtitleFile } from "@/app/actions";

// Language choices for a manually added track (must match the /api/subtitles
// [a-z]{2,8} route validation). "orig" = the video's original language.
const LANGS: [string, string][] = [
  ["id", "Indonesian"],
  ["en", "English"],
  ["orig", "Original"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["ms", "Malay"],
  ["ar", "Arabic"],
];

// Guess the language from a subtitle file name like "Movie.id.srt" / "Movie.en.vtt".
function guessLang(name: string): string | null {
  const m = name.toLowerCase().match(/\.([a-z]{2,3})\.[a-z0-9]+$/);
  if (!m) return null;
  const code = m[1] === "eng" ? "en" : m[1] === "ind" ? "id" : m[1];
  return LANGS.some(([c]) => c === code) ? code : null;
}

const SUB_ACCEPT = ".srt,.vtt,.ass,.ssa,.sub";

type ExtractStatus = { status: string; message?: string; langs?: string[] };

/**
 * "Add subtitle" dialog for a video part. Three sources:
 *   1. a subtitle file from the local device (SRT/VTT/ASS/…),
 *   2. a subtitle file already stored on the drive (Telegram storage),
 *   3. extraction of the video's own embedded (softsub) text streams.
 * All three land as WebVTT tracks on the streamer's /subtitles volume; `onAdded`
 * remounts the player so the new track shows up in the CC menu immediately.
 */
export function SubtitleDialog({
  partId,
  onClose,
  onAdded,
  subtitleBase,
  localOnly = false,
}: {
  partId: number;
  onClose: () => void;
  onAdded: () => void;
  // Subtitle API base (defaults to the part-keyed routes). Kept-on-server files pass their own.
  subtitleBase?: string;
  // Kept files only support a local file upload — hide the from-drive and softsub-extract sources.
  localOnly?: boolean;
}) {
  const base = subtitleBase ?? `/api/subtitles/${partId}`;
  const [lang, setLang] = useState("id");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // From-drive picker state.
  const [driveSubs, setDriveSubs] = useState<DriveSubtitleFile[] | null>(null);
  const [srcPartId, setSrcPartId] = useState<number | null>(null);

  // Extraction job state (poll while running).
  const [extract, setExtract] = useState<ExtractStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (localOnly) return; // kept files: no from-drive picker
    let alive = true;
    listDriveSubtitleFiles()
      .then((subs) => alive && setDriveSubs(subs))
      .catch(() => alive && setDriveSubs([]));
    return () => {
      alive = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [localOnly]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const uploadLocal = async (file: File) => {
    setBusy(true);
    setMsg(null);
    try {
      const ext = (file.name.split(".").pop() || "srt").toLowerCase();
      const chosen = guessLang(file.name) ?? lang;
      const resp = await fetch(
        `${base}/manual?lang=${encodeURIComponent(chosen)}&ext=${encodeURIComponent(ext)}`,
        { method: "POST", body: await file.arrayBuffer() }
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error ?? "Upload failed.");
      setMsg(`Subtitle saved (${data.lang}).`);
      onAdded();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const attachFromDrive = async () => {
    if (srcPartId == null) return;
    setBusy(true);
    setMsg(null);
    try {
      const picked = driveSubs?.find((s) => s.partId === srcPartId);
      const chosen = (picked && guessLang(picked.fileName)) ?? lang;
      const resp = await fetch(`/api/subtitles/${partId}/from-part`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ srcPartId, lang: chosen }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error ?? "Attach failed.");
      setMsg(`Subtitle attached (${data.lang}).`);
      onAdded();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Attach failed.");
    } finally {
      setBusy(false);
    }
  };

  const startExtract = async () => {
    setMsg(null);
    setExtract({ status: "running", message: "Starting…" });
    try {
      const resp = await fetch(`${base}/extract`, { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error ?? "Could not start extraction.");
      setExtract(data);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/subtitles/${partId}/extract`);
          const s: ExtractStatus = await r.json();
          setExtract(s);
          if (s.status !== "running" && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            if (s.status === "done") onAdded();
          }
        } catch {
          // transient — keep polling
        }
      }, 3000);
    } catch (err) {
      setExtract({ status: "error", message: err instanceof Error ? err.message : "Failed." });
    }
  };

  const extracting = extract?.status === "running";

  return (
    <div
      className="overlay"
      style={{ zIndex: 360 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog" style={{ maxWidth: 460 }}>
        <div className="dhead">
          <h2>Add subtitle</h2>
        </div>
        <div className="dbody" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label className="dv-field" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="sub" style={{ fontSize: 13 }}>
              Language (used unless the file name says otherwise, e.g. &quot;movie.en.srt&quot;)
            </span>
            <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={busy}>
              {LANGS.map(([code, label]) => (
                <option key={code} value={code}>
                  {label} ({code})
                </option>
              ))}
            </select>
          </label>

          {/* 1 — local device */}
          <div>
            <button
              className="btn"
              onClick={() => fileRef.current?.click()}
              disabled={busy || extracting}
            >
              <Icon name="upload" size={15} />
              Upload from this device…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={SUB_ACCEPT}
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadLocal(f);
                e.target.value = "";
              }}
            />
          </div>

          {/* 2 — from Telegram storage */}
          {!localOnly && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="sub" style={{ fontSize: 13 }}>From Telegram storage</span>
            {driveSubs === null ? (
              <span className="sub" style={{ fontSize: 13 }}>Loading…</span>
            ) : driveSubs.length === 0 ? (
              <span className="sub" style={{ fontSize: 13 }}>
                No subtitle files (.srt/.vtt/.ass) on the drive yet.
              </span>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  style={{ flex: 1, minWidth: 0 }}
                  value={srcPartId ?? ""}
                  onChange={(e) => setSrcPartId(e.target.value ? Number(e.target.value) : null)}
                  disabled={busy}
                >
                  <option value="">Choose a subtitle file…</option>
                  {driveSubs.map((s) => (
                    <option key={s.partId} value={s.partId}>
                      {s.fileName} — {fmtSize(s.size)}
                    </option>
                  ))}
                </select>
                <button
                  className="btn"
                  onClick={attachFromDrive}
                  disabled={busy || srcPartId == null}
                >
                  Attach
                </button>
              </div>
            )}
          </div>
          )}

          {/* 3 — extract embedded (softsub) */}
          {!localOnly && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="sub" style={{ fontSize: 13 }}>
              Extract embedded subtitles from the video itself (softsub). Downloads the
              original from Telegram in the background — may take a while for big files.
            </span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn" onClick={startExtract} disabled={busy || extracting}>
                {extracting ? <span className="spinner sm" /> : <Icon name="subtitles" size={15} />}
                Extract from video
              </button>
              {extract && (
                <span className="sub" style={{ fontSize: 13 }}>
                  {extract.message || extract.status}
                </span>
              )}
            </div>
          </div>
          )}

          {msg && (
            <p className="sub" style={{ fontSize: 13, margin: 0 }}>
              {msg}
            </p>
          )}
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
