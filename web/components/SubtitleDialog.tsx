"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Icon } from "@/lib/icons";
import { fmtSize } from "@/lib/format";
import { listDriveSubtitleFiles, type DriveSubtitleFile } from "@/app/actions";

export const SUB_LANGS: [string, string][] = [
  ["id", "Indonesian"],
  ["en", "English"],
  ["orig", "Original"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["ru", "Russian"],
  ["ar", "Arabic"],
  ["ms", "Malay"],
  ["th", "Thai"],
  ["vi", "Vietnamese"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["tr", "Turkish"],
  ["hi", "Hindi"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
];

export function langLabel(code: string): string {
  const match = SUB_LANGS.find(([c]) => c === code);
  return match ? match[1] : code.toUpperCase();
}

function guessLang(name: string): string | null {
  const m = name.toLowerCase().match(/\.([a-z]{2,3})\.[a-z0-9]+$/);
  if (!m) return null;
  const code = m[1] === "eng" ? "en" : m[1] === "ind" ? "id" : m[1];
  return SUB_LANGS.some(([c]) => c === code) ? code : null;
}

const SUB_ACCEPT = ".srt,.vtt,.ass,.ssa,.sub";

type TabMode = "tracks" | "ai" | "sync" | "add";
type SubtitleTrack = { lang: string; backed_up?: boolean };
type JobStatus = { status: string; message?: string; langs?: string[] };

export function SubtitleDialog({
  partId,
  onClose,
  onAdded,
}: {
  partId: number;
  onClose: () => void;
  onAdded: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<TabMode>("tracks");
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [langs, setLangs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  // AI Generation state
  const [genJob, setGenJob] = useState<JobStatus | null>(null);
  const [forceGen, setForceGen] = useState(false);
  const genPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Translation state
  const [tlSource, setTlSource] = useState("orig");
  const [tlTarget, setTlTarget] = useState("id");

  // Timing Sync state
  const [syncLang, setSyncLang] = useState("id");
  const [syncOffset, setSyncOffset] = useState<number>(0);

  // Add / Upload state
  const [addLang, setAddLang] = useState("id");
  const [driveSubs, setDriveSubs] = useState<DriveSubtitleFile[] | null>(null);
  const [srcPartId, setSrcPartId] = useState<number | null>(null);
  const [extract, setExtract] = useState<JobStatus | null>(null);
  const extractPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Load tracks list
  const loadTracks = useCallback(async () => {
    try {
      const res = await fetch(`/api/subtitles/${partId}`);
      if (res.ok) {
        const data = await res.json();
        const available: string[] = Array.isArray(data?.langs) ? data.langs : [];
        const rawTracks: SubtitleTrack[] = Array.isArray(data?.tracks)
          ? data.tracks
          : available.map((l) => ({ lang: l }));
        setLangs(available);
        setTracks(rawTracks);

        if (available.length > 0) {
          if (!available.includes(syncLang)) setSyncLang(available[0]);
          if (!available.includes(tlSource)) setTlSource(available[0]);
        }
      }
    } catch {
      // transient
    } finally {
      setLoading(false);
    }
  }, [partId, syncLang, tlSource]);

  useEffect(() => {
    loadTracks();
  }, [loadTracks]);

  // Load Telegram storage subtitles for "from drive" tab
  useEffect(() => {
    let alive = true;
    listDriveSubtitleFiles()
      .then((subs) => alive && setDriveSubs(subs))
      .catch(() => alive && setDriveSubs([]));
    return () => {
      alive = false;
    };
  }, []);

  // Poll active jobs on mount
  useEffect(() => {
    let alive = true;
    fetch(`/api/subtitles/${partId}/generate`)
      .then((r) => r.json())
      .then((data: JobStatus) => {
        if (!alive) return;
        if (data.status === "running") {
          setGenJob(data);
          startGenPolling();
        }
      })
      .catch(() => {});

    fetch(`/api/subtitles/${partId}/extract`)
      .then((r) => r.json())
      .then((data: JobStatus) => {
        if (!alive) return;
        if (data.status === "running") {
          setExtract(data);
          startExtractPolling();
        }
      })
      .catch(() => {});

    return () => {
      alive = false;
      if (genPollRef.current) clearInterval(genPollRef.current);
      if (extractPollRef.current) clearInterval(extractPollRef.current);
    };
  }, [partId]);

  // Keyboard navigation & Dialog Tab Trap (Invariant 11)
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const focusables = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // --- AI Generation Handlers ---
  const startGenPolling = () => {
    if (genPollRef.current) clearInterval(genPollRef.current);
    genPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/subtitles/${partId}/generate`);
        const s: JobStatus = await r.json();
        setGenJob(s);
        if (s.status !== "running") {
          if (genPollRef.current) {
            clearInterval(genPollRef.current);
            genPollRef.current = null;
          }
          if (s.status === "done") {
            setMsg({ text: s.message || "Subtitles generated successfully!" });
            loadTracks();
            onAdded();
          } else if (s.status === "error") {
            setMsg({ text: s.message || "Subtitle generation failed.", error: true });
          }
        }
      } catch {
        // keep polling
      }
    }, 2500);
  };

  const triggerGenerate = async () => {
    setBusy(true);
    setMsg(null);
    setGenJob({ status: "running", message: "Starting on-demand AI generation…" });
    try {
      const resp = await fetch(`/api/subtitles/${partId}/generate?force=${forceGen}`, {
        method: "POST",
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error ?? "Failed to trigger generation.");
      setGenJob(data);
      startGenPolling();
    } catch (err) {
      setGenJob({ status: "error", message: err instanceof Error ? err.message : "Failed." });
      setMsg({ text: err instanceof Error ? err.message : "Failed to start generation.", error: true });
    } finally {
      setBusy(false);
    }
  };

  // --- Translation Handler ---
  const triggerTranslate = async () => {
    if (!tlSource || !tlTarget || tlSource === tlTarget) {
      setMsg({ text: "Please pick two different languages for translation.", error: true });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const resp = await fetch(
        `/api/subtitles/${partId}/translate?source=${encodeURIComponent(tlSource)}&target=${encodeURIComponent(tlTarget)}`,
        { method: "POST" }
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error ?? "Translation failed.");
      setMsg({ text: `Translated successfully to ${langLabel(tlTarget)} (${tlTarget})!` });
      await loadTracks();
      onAdded();
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : "Translation failed.", error: true });
    } finally {
      setBusy(false);
    }
  };

  // --- Timing Sync Offset Handler ---
  const triggerSaveOffset = async () => {
    if (!syncLang) return;
    setBusy(true);
    setMsg(null);
    try {
      const resp = await fetch(
        `/api/subtitles/${partId}/offset?lang=${encodeURIComponent(syncLang)}&offset=${encodeURIComponent(syncOffset)}`,
        { method: "POST" }
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error ?? "Failed to save timing offset.");
      setMsg({
        text: `Offset of ${syncOffset >= 0 ? "+" : ""}${syncOffset.toFixed(2)}s saved to ${langLabel(syncLang)}!`,
      });
      setSyncOffset(0);
      await loadTracks();
      onAdded();
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : "Failed to save offset.", error: true });
    } finally {
      setBusy(false);
    }
  };

  // --- Delete Track Handler ---
  const deleteTrack = async (lang: string) => {
    if (!confirm(`Delete ${langLabel(lang)} (${lang}) subtitle track?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const resp = await fetch(`/api/subtitles/${partId}/${lang}`, { method: "DELETE" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error ?? "Delete failed.");
      setMsg({ text: `Deleted ${langLabel(lang)} track.` });
      await loadTracks();
      onAdded();
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : "Delete failed.", error: true });
    } finally {
      setBusy(false);
    }
  };

  // --- Manual Upload Handlers ---
  const uploadLocal = async (file: File) => {
    setBusy(true);
    setMsg(null);
    try {
      const ext = (file.name.split(".").pop() || "srt").toLowerCase();
      const chosen = guessLang(file.name) ?? addLang;
      const resp = await fetch(
        `/api/subtitles/${partId}/manual?lang=${encodeURIComponent(chosen)}&ext=${encodeURIComponent(ext)}`,
        { method: "POST", body: await file.arrayBuffer() }
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error ?? "Upload failed.");
      setMsg({ text: `Subtitle saved (${langLabel(data.lang)}).` });
      await loadTracks();
      onAdded();
      setTab("tracks");
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : "Upload failed.", error: true });
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
      const chosen = (picked && guessLang(picked.fileName)) ?? addLang;
      const resp = await fetch(`/api/subtitles/${partId}/from-part`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ srcPartId, lang: chosen }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error ?? "Attach failed.");
      setMsg({ text: `Subtitle attached (${langLabel(data.lang)}).` });
      await loadTracks();
      onAdded();
      setTab("tracks");
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : "Attach failed.", error: true });
    } finally {
      setBusy(false);
    }
  };

  const startExtractPolling = () => {
    if (extractPollRef.current) clearInterval(extractPollRef.current);
    extractPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/subtitles/${partId}/extract`);
        const s: JobStatus = await r.json();
        setExtract(s);
        if (s.status !== "running") {
          if (extractPollRef.current) {
            clearInterval(extractPollRef.current);
            extractPollRef.current = null;
          }
          if (s.status === "done") {
            setMsg({ text: s.message || "Embedded subtitles extracted!" });
            loadTracks();
            onAdded();
          } else if (s.status === "error") {
            setMsg({ text: s.message || "Extraction failed.", error: true });
          }
        }
      } catch {
        // keep polling
      }
    }, 3000);
  };

  const startExtract = async () => {
    setMsg(null);
    setExtract({ status: "running", message: "Starting…" });
    try {
      const resp = await fetch(`/api/subtitles/${partId}/extract`, { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error ?? "Could not start extraction.");
      setExtract(data);
      startExtractPolling();
    } catch (err) {
      setExtract({ status: "error", message: err instanceof Error ? err.message : "Failed." });
    }
  };

  const isGenerating = genJob?.status === "running";
  const isExtracting = extract?.status === "running";

  return (
    <div
      className="overlay"
      style={{ zIndex: 360 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="dialog" style={{ maxWidth: 540, width: "95%" }}>
        <div className="dhead" style={{ paddingBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="subtitles" size={20} />
            <h2 style={{ fontSize: 17 }}>Subtitle Manager</h2>
          </div>
          <button className="iconbtn ghost" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <Icon name="close" size={17} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="sub-tabs">
          <button
            className={`sub-tab ${tab === "tracks" ? "on" : ""}`}
            onClick={() => setTab("tracks")}
            type="button"
          >
            <Icon name="rows" size={14} />
            Tracks {tracks.length > 0 ? `(${tracks.length})` : ""}
          </button>
          <button
            className={`sub-tab ${tab === "ai" ? "on" : ""}`}
            onClick={() => setTab("ai")}
            type="button"
          >
            <Icon name="refresh" size={14} />
            AI Generator
          </button>
          <button
            className={`sub-tab ${tab === "sync" ? "on" : ""}`}
            onClick={() => setTab("sync")}
            type="button"
          >
            <Icon name="recent" size={14} />
            Timing Sync
          </button>
          <button
            className={`sub-tab ${tab === "add" ? "on" : ""}`}
            onClick={() => setTab("add")}
            type="button"
          >
            <Icon name="plus" size={14} />
            Add / Import
          </button>
        </div>

        {/* Tab Body */}
        <div className="dbody" tabIndex={0} style={{ display: "flex", flexDirection: "column", gap: 14, minHeight: 260 }}>
          {msg && (
            <div
              style={{
                padding: "8px 12px",
                borderRadius: "var(--r-sm)",
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: msg.error ? "color-mix(in oklab, #B23A2E 12%, var(--card))" : "color-mix(in oklab, #3C7A74 12%, var(--card))",
                color: msg.error ? "#B23A2E" : "#2F635E",
                border: `1px solid ${msg.error ? "color-mix(in oklab, #B23A2E 28%, var(--line))" : "color-mix(in oklab, #3C7A74 28%, var(--line))"}`,
              }}
            >
              <Icon name={msg.error ? "warn" : "check"} size={15} />
              <span style={{ flex: 1 }}>{msg.text}</span>
              <button
                className="iconbtn ghost sm"
                onClick={() => setMsg(null)}
                style={{ width: 20, height: 20 }}
                title="Dismiss"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          )}

          {/* TAB 1: TRACKS */}
          {tab === "tracks" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {loading ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 20, justifyContent: "center", color: "var(--muted)" }}>
                  <span className="spinner sm" />
                  <span>Loading subtitle tracks…</span>
                </div>
              ) : tracks.length === 0 ? (
                <div style={{ padding: "30px 16px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--card-2)", display: "grid", placeItems: "center", color: "var(--muted)" }}>
                    <Icon name="subtitles" size={22} />
                  </div>
                  <div>
                    <strong style={{ display: "block", fontSize: 14, color: "var(--ink)", marginBottom: 4 }}>
                      No subtitles available yet
                    </strong>
                    <span className="sub" style={{ fontSize: 13 }}>
                      You can generate automatic captions with AI or upload your own file.
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <button className="btn" onClick={() => setTab("ai")}>
                      <Icon name="refresh" size={14} />
                      Generate with AI
                    </button>
                    <button className="btn subtle" onClick={() => setTab("add")}>
                      <Icon name="plus" size={14} />
                      Add manually
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <span className="sub" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--muted)" }}>
                    AVAILABLE TRACKS ({tracks.length})
                  </span>
                  {tracks.map((t) => (
                    <div key={t.lang} className="sub-track-item">
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink)" }}>
                          {langLabel(t.lang)}
                        </span>
                        <span className="sub-badge">{t.lang}</span>
                        {t.backed_up ? (
                          <span className="sub-badge cloud" title="Backed up permanently in Telegram storage channel">
                            <Icon name="cloud" size={12} />
                            Cloud Synced
                          </span>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <a
                          href={`/api/subtitles/${partId}/${t.lang}`}
                          download={`part_${partId}.${t.lang}.vtt`}
                          className="iconbtn"
                          title="Download .vtt track"
                          aria-label={`Download ${langLabel(t.lang)} subtitle`}
                          style={{ textDecoration: "none" }}
                        >
                          <Icon name="download" size={15} />
                        </a>
                        <button
                          className="iconbtn"
                          onClick={() => {
                            setTlSource(t.lang);
                            setTab("ai");
                          }}
                          title="Translate this track"
                          aria-label={`Translate ${langLabel(t.lang)}`}
                        >
                          <Icon name="refresh" size={15} />
                        </button>
                        <button
                          className="iconbtn"
                          onClick={() => {
                            setSyncLang(t.lang);
                            setTab("sync");
                          }}
                          title="Adjust timing sync"
                          aria-label={`Sync timing for ${langLabel(t.lang)}`}
                        >
                          <Icon name="recent" size={15} />
                        </button>
                        <button
                          className="iconbtn danger"
                          onClick={() => deleteTrack(t.lang)}
                          disabled={busy}
                          title="Delete track"
                          aria-label={`Delete ${langLabel(t.lang)}`}
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: AI GENERATOR */}
          {tab === "ai" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <strong style={{ fontSize: 14, color: "var(--ink)", display: "block" }}>
                    AI Auto-Caption (CapCut Web & Whisper)
                  </strong>
                  <span className="sub" style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                    Automatically detects spoken language, transcribes with CapCut AutoCaption or Groq Whisper, and produces translated EN/ID tracks backed up to Telegram.
                  </span>
                </div>

                {isGenerating && (
                  <div style={{ padding: "10px 12px", background: "var(--card-2)", borderRadius: "var(--r-sm)", border: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
                    <span className="spinner sm" />
                    <div style={{ fontSize: 13, color: "var(--ink)" }}>
                      <strong>Processing:</strong> {genJob?.message || "Running AI transcription…"}
                    </div>
                  </div>
                )}

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", paddingTop: 4 }}>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--muted)", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={forceGen}
                      onChange={(e) => setForceGen(e.target.checked)}
                      disabled={busy || isGenerating}
                    />
                    Force re-transcribe from scratch
                  </label>
                  <button
                    className="btn"
                    onClick={triggerGenerate}
                    disabled={busy || isGenerating}
                  >
                    {isGenerating ? <span className="spinner sm" /> : <Icon name="refresh" size={14} />}
                    {isGenerating ? "Generating…" : "Generate Subtitle Now"}
                  </button>
                </div>
              </div>

              {/* Translate Existing Track */}
              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <strong style={{ fontSize: 14, color: "var(--ink)", display: "block" }}>
                    Translate Existing Track On-Demand
                  </strong>
                  <span className="sub" style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                    Quickly translate an existing track into any additional target language without re-transcribing.
                  </span>
                </div>

                {tracks.length === 0 ? (
                  <span className="sub" style={{ fontSize: 12.5 }}>
                    No tracks available to translate yet. Generate or add a track first.
                  </span>
                ) : (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 120 }}>
                      <span className="sub" style={{ fontSize: 11.5, display: "block", marginBottom: 3 }}>Source Track</span>
                      <select
                        style={{ width: "100%" }}
                        value={tlSource}
                        onChange={(e) => setTlSource(e.target.value)}
                        disabled={busy}
                      >
                        {tracks.map((t) => (
                          <option key={t.lang} value={t.lang}>
                            {langLabel(t.lang)} ({t.lang})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ flex: 1, minWidth: 120 }}>
                      <span className="sub" style={{ fontSize: 11.5, display: "block", marginBottom: 3 }}>Target Language</span>
                      <select
                        style={{ width: "100%" }}
                        value={tlTarget}
                        onChange={(e) => setTlTarget(e.target.value)}
                        disabled={busy}
                      >
                        {SUB_LANGS.filter(([c]) => c !== tlSource).map(([code, label]) => (
                          <option key={code} value={code}>
                            {label} ({code})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ alignSelf: "flex-end" }}>
                      <button
                        className="btn"
                        onClick={triggerTranslate}
                        disabled={busy || !tlSource || !tlTarget || tlSource === tlTarget}
                      >
                        Translate
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: TIMING SYNC */}
          {tab === "sync" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <strong style={{ fontSize: 14, color: "var(--ink)", display: "block" }}>
                    Subtitle Timing Synchronization
                  </strong>
                  <span className="sub" style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                    If subtitles are out of sync with spoken audio, shift their timestamps earlier or later.
                  </span>
                </div>

                {tracks.length === 0 ? (
                  <span className="sub" style={{ fontSize: 12.5 }}>
                    No subtitle tracks available to synchronize. Add or generate one first.
                  </span>
                ) : (
                  <>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span className="sub" style={{ fontSize: 12, fontWeight: 600 }}>Track to adjust:</span>
                      <select
                        value={syncLang}
                        onChange={(e) => setSyncLang(e.target.value)}
                        disabled={busy}
                      >
                        {tracks.map((t) => (
                          <option key={t.lang} value={t.lang}>
                            {langLabel(t.lang)} ({t.lang})
                          </option>
                        ))}
                      </select>
                    </label>

                    {/* Offset Quick Buttons */}
                    <div>
                      <span className="sub" style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}>
                        Quick Adjustment (Seconds):
                      </span>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {[-2.0, -1.0, -0.5, -0.1].map((val) => (
                          <button
                            key={val}
                            type="button"
                            className="sub-sync-btn"
                            onClick={() => setSyncOffset((prev) => Math.round((prev + val) * 100) / 100)}
                            disabled={busy}
                          >
                            {val}s
                          </button>
                        ))}
                        <button
                          type="button"
                          className="sub-sync-btn"
                          onClick={() => setSyncOffset(0)}
                          disabled={busy || syncOffset === 0}
                          style={{ fontWeight: 700 }}
                        >
                          Reset (0s)
                        </button>
                        {[0.1, 0.5, 1.0, 2.0].map((val) => (
                          <button
                            key={val}
                            type="button"
                            className="sub-sync-btn"
                            onClick={() => setSyncOffset((prev) => Math.round((prev + val) * 100) / 100)}
                            disabled={busy}
                          >
                            +{val}s
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Custom Input */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink)" }}>
                        <span>Total Offset:</span>
                        <input
                          type="number"
                          step="0.05"
                          value={syncOffset}
                          onChange={(e) => setSyncOffset(parseFloat(e.target.value) || 0)}
                          style={{ width: 90, padding: "5px 8px", fontVariantNumeric: "tabular-nums" }}
                          disabled={busy}
                        />
                        <span>seconds</span>
                      </label>
                      <span className="sub" style={{ fontSize: 12, color: "var(--faint)" }}>
                        {syncOffset > 0 ? "(delays subtitles later)" : syncOffset < 0 ? "(shows subtitles earlier)" : "(no shift)"}
                      </span>
                    </div>

                    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10, display: "flex", justifyContent: "flex-end" }}>
                      <button
                        className="btn"
                        onClick={triggerSaveOffset}
                        disabled={busy || syncOffset === 0}
                      >
                        <Icon name="check" size={14} />
                        Apply & Save Permanently
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: ADD / IMPORT */}
          {tab === "add" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <label className="dv-field" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="sub" style={{ fontSize: 13 }}>
                  Target Language (used unless the file name says otherwise, e.g. &quot;movie.en.srt&quot;)
                </span>
                <select value={addLang} onChange={(e) => setAddLang(e.target.value)} disabled={busy}>
                  {SUB_LANGS.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label} ({code})
                    </option>
                  ))}
                </select>
              </label>

              {/* 1 — Local file */}
              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: "12px 14px" }}>
                <span className="sub" style={{ fontSize: 13, fontWeight: 600, display: "block", marginBottom: 6 }}>
                  1. From your computer / phone
                </span>
                <button
                  className="btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy || isExtracting}
                >
                  <Icon name="upload" size={15} />
                  Choose local file (.srt, .vtt, .ass)…
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

              {/* 2 — From Telegram Drive */}
              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="sub" style={{ fontSize: 13, fontWeight: 600 }}>
                  2. From Telegram Cloud Drive
                </span>
                {driveSubs === null ? (
                  <span className="sub" style={{ fontSize: 13 }}>Loading drive subtitles…</span>
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
                      <option value="">Choose a subtitle file on drive…</option>
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

              {/* 3 — Extract embedded softsub */}
              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="sub" style={{ fontSize: 13, fontWeight: 600 }}>
                  3. Extract Embedded Softsub Streams
                </span>
                <span className="sub" style={{ fontSize: 12, lineHeight: 1.4 }}>
                  Extract internal text subtitle tracks from MKV/MP4 containers via ffmpeg on the server.
                </span>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                  <button className="btn" onClick={startExtract} disabled={busy || isExtracting}>
                    {isExtracting ? <span className="spinner sm" /> : <Icon name="subtitles" size={15} />}
                    Extract from video
                  </button>
                  {extract && (
                    <span className="sub" style={{ fontSize: 12.5 }}>
                      {extract.message || extract.status}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="dfoot" style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <button className="btn subtle" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
