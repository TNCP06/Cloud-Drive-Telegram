"use client";

import { useEffect, useRef } from "react";
// plyr 3.8.4 resolves to its untyped source here, and `tsc` and `next build` disagree over whether
// that is an error — so suppress with `@ts-ignore` (never "unused") rather than `@ts-expect-error`.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import type Plyr from "plyr";
import "plyr/dist/plyr.css";

// Volume/mute is remembered across video switches AND browser sessions so moving
// between parts/files never resets it. (Plyr's own storage is disabled; we own it.)
const VOL_KEY = "video-volume";
const MUTE_KEY = "video-muted";
function readSavedVolume(): { volume: number | null; muted: boolean | null } {
  try {
    const v = localStorage.getItem(VOL_KEY);
    const m = localStorage.getItem(MUTE_KEY);
    return {
      volume: v !== null ? Number(v) : null,
      muted: m !== null ? m === "true" : null,
    };
  } catch {
    return { volume: null, muted: null };
  }
}

// Looping is remembered globally (toggled by the loop button in the control bar, or the viewer's
// "P" shortcut) so the next video keeps the same loop setting.
function readLoopPref(): boolean {
  try {
    return localStorage.getItem("video-loop") === "true";
  } catch {
    return false;
  }
}

// Resume playback where the user left off: the last position is remembered PER PART (across
// reopens and browser sessions), so closing a video and opening it again continues from there.
// We ignore the first few seconds (nothing to resume) and the tail (a video watched to the end
// should restart, not jump to the credits).
const PROGRESS_KEY = (id: number) => `video-progress:${id}`;
const RESUME_MIN_S = 5;
const RESUME_TAIL_S = 15;
function readProgress(id?: number): number | null {
  if (id == null) return null;
  try {
    const v = localStorage.getItem(PROGRESS_KEY(id));
    return v !== null ? Number(v) : null;
  } catch {
    return null;
  }
}
function writeProgress(id: number, t: number, duration: number) {
  // Don't persist trivially-early or basically-finished positions.
  if (!(t > RESUME_MIN_S) || (duration && t >= duration - RESUME_TAIL_S)) return;
  try {
    localStorage.setItem(PROGRESS_KEY(id), String(Math.floor(t)));
  } catch {}
}
function clearProgress(id: number) {
  try {
    localStorage.removeItem(PROGRESS_KEY(id));
  } catch {}
}

// Subtitle language is remembered globally (like volume) so the next video auto-enables the
// same language. Stored value is a lang code, or "off" if the user turned captions off.
const SUB_LANG_KEY = "subtitle-lang";
function readSubPref(): string | null {
  try {
    return localStorage.getItem(SUB_LANG_KEY);
  } catch {
    return null;
  }
}
function writeSubPref(v: string) {
  try {
    localStorage.setItem(SUB_LANG_KEY, v);
  } catch {}
}
// Pick which caption language to activate for a video, given the user's saved preference and the
// languages this video actually has: preferred → Indonesian → original (a non en/id track) → first.
function pickCaptionLang(langs: string[], pref: string | null): string | null {
  if (!langs.length || pref === "off") return null;
  if (pref && langs.includes(pref)) return pref;
  if (langs.includes("id")) return "id";
  return langs.find((l) => l !== "en" && l !== "id") ?? langs[0];
}

// Human-readable labels for the captions menu. Falls back to the upper-cased code.
const LANG_NAMES: Record<string, string> = {
  en: "English", id: "Indonesian", orig: "Original", ms: "Malay", ja: "Japanese",
  ko: "Korean", zh: "Chinese", es: "Spanish", fr: "French", de: "German",
  pt: "Portuguese", ru: "Russian", ar: "Arabic", hi: "Hindi", th: "Thai",
  vi: "Vietnamese", it: "Italian", nl: "Dutch", tr: "Turkish", tl: "Tagalog",
};
function langLabel(code: string): string {
  return LANG_NAMES[code] || code.toUpperCase();
}

/**
 * Plyr-based video player for the lightbox stage.
 *
 * The player fills the whole stage from the very first frame — even while the
 * stream is still loading — instead of collapsing to the tiny intrinsic `<video>`
 * size: Plyr's wrapper/video are 100%×100% and we letterbox the frame with
 * `object-fit: contain` (see globals.css `.viewer-video`).
 *
 * Click behaviour (Plyr's own click-to-play is disabled so we can split it):
 *   • on the video frame  → play / pause
 *   • on the letterbox    → nothing (the viewer only closes via the ✕ button or Esc)
 *   • on the controls      → handled by Plyr
 * The frame vs letterbox split is computed from the displayed `object-fit:
 * contain` rectangle, falling back to the poster's aspect ratio before the
 * video's own dimensions are known (i.e. while still loading).
 */
export function VideoPlayer({
  src,
  poster,
  partId,
  onToggleFullscreen,
}: {
  src: string;
  poster?: string;
  partId?: number;
  onToggleFullscreen?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const posterDims = useRef<{ w: number; h: number } | null>(null);

  // Resolve poster dimensions (a data-URL thumbnail → loads instantly) so the
  // letterbox hit-test works even before the video reports its own size.
  useEffect(() => {
    posterDims.current = null;
    if (!poster) return;
    let alive = true;
    const img = new window.Image();
    img.onload = () => {
      if (alive && img.naturalWidth && img.naturalHeight) {
        posterDims.current = { w: img.naturalWidth, h: img.naturalHeight };
      }
    };
    img.src = poster;
    return () => {
      alive = false;
    };
  }, [poster]);

  // Create / destroy the Plyr instance. Re-runs when the source changes so each
  // part/file gets a fresh player; volume + mute are restored from storage so
  // they never reset between videos.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let player: Plyr | null = null;
    let destroyed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    // Subtitles live at the part-keyed streamer routes (list at `${base}`, one track at
    // `${base}/${lang}`).
    const subBase = partId != null ? `/api/subtitles/${partId}` : undefined;

    (async () => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — see the import at the top of the file
      const PlyrCtor = (await import("plyr")).default;
      if (destroyed || !videoRef.current) return;

      // Append a <track> for any subtitle lang we don't already have. Plyr (captions.update:true)
      // picks up tracks added AFTER init via the textTracks `addtrack` event, so this same helper
      // also loads subtitles that finish generating WHILE the video is open (see the poll below).
      // `captionLangs` is append-ordered to match Plyr's numeric currentTrack indices.
      const captionLangs: string[] = [];
      const addTracks = (langs: string[]): boolean => {
        const vid = videoRef.current;
        if (!vid) return false;
        let added = false;
        for (const lang of langs) {
          if (captionLangs.includes(lang) || vid.querySelector(`track[srclang="${lang}"]`)) continue;
          const track = document.createElement("track");
          track.kind = "captions";
          track.label = langLabel(lang);
          track.srclang = lang;
          track.src = `${subBase}/${lang}`;
          vid.appendChild(track);
          captionLangs.push(lang);
          added = true;
        }
        return added;
      };

      // Initial load (before Plyr init so the first set shows in the CC menu immediately).
      let subtitlesDone = false;
      if (subBase) {
        try {
          const res = await fetch(subBase);
          if (!destroyed && res.ok) {
            const data = await res.json();
            subtitlesDone = data?.done === true;
            addTracks(Array.isArray(data?.langs) ? data.langs : []);
          }
        } catch {
          // No captions is fine — never block playback on subtitle loading.
        }
      }
      if (destroyed || !videoRef.current) return;

      // Only enable Plyr's previewThumbnails when a VALID seek-preview VTT already exists. Plyr's
      // thumbnail parser reads `frames[0].text` unconditionally, so a VTT with zero cues — exactly
      // what the API serves for a video with no preview (too short, or not generated yet) — throws
      // "Cannot read properties of undefined (reading 'text')" and breaks the player. Gating here
      // keeps that crash off the player. Previews self-heal: a brand-new video gets them on a later
      // open, once the background sprite job (kicked off by playback) has finished.
      let previewReady = false;
      if (partId) {
        try {
          const res = await fetch(`/api/seek-preview/${partId}`);
          if (!destroyed && res.ok) {
            const vtt = await res.text();
            previewReady = vtt.includes("-->") && vtt.includes("#xywh=");
          }
        } catch {
          // No preview is fine — the player just won't show hover thumbnails.
        }
      }
      if (destroyed || !videoRef.current) return;

      // Decide which caption language to auto-activate from the saved global preference.
      const chosenLang = pickCaptionLang(captionLangs, readSubPref());

      player = new PlyrCtor(videoRef.current, {
        seekTime: 5, // ←/→ seek by 5 seconds
        clickToPlay: false, // we split frame-click (play) vs letterbox-click (close)
        keyboard: { focused: true, global: true },
        storage: { enabled: false }, // we manage volume/mute + caption-lang persistence ourselves
        fullscreen: { enabled: true, fallback: false },
        captions: { active: chosenLang != null, language: chosenLang ?? "auto", update: true },
        controls: [
          "play-large",
          "play",
          "mute",
          "volume",
          "current-time",
          "duration",
          "progress",
          "captions",
          "settings",
          "pip",
          "fullscreen",
        ],
        tooltips: { controls: true, seek: true },
        // One tooltip scheme for the whole bar: "<what it does> (<key>)", so no button is the odd
        // one out. Fullscreen deliberately reads the same in BOTH directions — we delegate Plyr's
        // toggle to the viewer (see below), so Plyr never learns it is in fullscreen and its default
        // "Enter fullscreen" label would keep claiming that while already fullscreen.
        i18n: {
          play: "Play (K)",
          pause: "Pause (K)",
          mute: "Mute (M)",
          unmute: "Unmute (M)",
          enableCaptions: "Captions (C)",
          disableCaptions: "Captions (C)",
          enterFullscreen: "Fullscreen (F)",
          exitFullscreen: "Fullscreen (F)",
          pip: "Miniplayer (I)",
          settings: "Settings",
        },
        previewThumbnails:
          previewReady && partId ? { enabled: true, src: `/api/seek-preview/${partId}` } : { enabled: false },
      });

      // Delegate Plyr's fullscreen toggle to the viewer's toggleFullscreen so topbar, filmstrip and controls stay consistent
      player.fullscreen.toggle = () => {
        onToggleFullscreen?.();
      };

      // Plyr has no loop control of its own (its `loop` settings entry is unimplemented upstream),
      // so add one to the control bar next to PIP: a toggle that lights up while looping — the
      // visual answer to "is loop on?", which the shortcut alone never gave.
      const addLoopButton = () => {
        const bar = videoRef.current?.closest(".plyr")?.querySelector(".plyr__controls");
        const vid = videoRef.current;
        if (!bar || !vid || bar.querySelector(".tcd-loop")) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "plyr__controls__item plyr__control tcd-loop";
        // A `.plyr__tooltip` span, not a `title` attribute: `title` pops the OS tooltip — black and
        // delayed, nothing like the rest of the bar. One label for both states, matching the scheme
        // in `i18n` above; the lit-up button is what says whether looping is on.
        btn.innerHTML =
          '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M3.5 12V9a3 3 0 0 1 3-3h14"/>' +
          '<path d="M7 21.5L3.5 18 7 14.5"/><path d="M20.5 12v3a3 3 0 0 1-3 3h-14"/></svg>' +
          '<span class="plyr__tooltip">Loop (P)</span>';
        const sync = () => {
          btn.classList.toggle("plyr__control--pressed", vid.loop);
          btn.setAttribute("aria-pressed", String(vid.loop));
          btn.setAttribute("aria-label", vid.loop ? "Stop loop" : "Loop");
        };
        btn.addEventListener("click", () => {
          vid.loop = !vid.loop;
          try {
            localStorage.setItem("video-loop", String(vid.loop));
          } catch {}
          sync();
        });
        sync();
        // Head of the right-hand cluster (loop → captions → settings → pip → fullscreen): it keeps
        // captions and settings adjacent, the pairing every player puts side by side.
        bar.insertBefore(
          btn,
          bar.querySelector('[data-plyr="captions"]') ??
            bar.querySelector('[data-plyr="settings"]') ??
            bar.querySelector('[data-plyr="pip"]') ??
            bar.querySelector('[data-plyr="fullscreen"]')
        );
      };

      player.on("ready", () => {
        const { volume, muted } = readSavedVolume();
        if (player) {
          if (volume !== null) player.volume = volume;
          if (muted !== null) player.muted = muted;
        }
        if (videoRef.current) videoRef.current.loop = readLoopPref();
        addLoopButton();
        videoRef.current?.focus();
      });

      // Persist any user volume/mute change for the next video and next session.
      player.on("volumechange", () => {
        try {
          if (!player) return;
          localStorage.setItem(VOL_KEY, String(player.volume));
          localStorage.setItem(MUTE_KEY, String(player.muted));
        } catch {}
      });

      // Persist the chosen caption language (or "off") so the next video matches it. Plyr's
      // currentTrack is the active caption index (-1 = off) into the tracks we appended.
      const persistCaptionLang = () => {
        if (!player) return;
        const idx = player.currentTrack;
        writeSubPref(idx != null && idx >= 0 && captionLangs[idx] ? captionLangs[idx] : "off");
      };
      player.on("languagechange", persistCaptionLang);
      player.on("captionsenabled", persistCaptionLang);
      player.on("captionsdisabled", persistCaptionLang);

      // Resume from the last watched position and keep it up to date while playing. Seek once the
      // duration is known (loadedmetadata); autoplay then continues from there instead of the start.
      if (partId != null) {
        const resume = () => {
          const saved = readProgress(partId);
          const dur = videoRef.current?.duration ?? 0;
          if (saved != null && saved > RESUME_MIN_S && (!dur || saved < dur - RESUME_TAIL_S)) {
            try {
              if (player) player.currentTime = saved;
            } catch {}
          }
        };
        player.on("loadedmetadata", resume);
        if ((videoRef.current?.readyState ?? 0) >= 1) resume(); // metadata already loaded

        let lastSave = 0;
        player.on("timeupdate", () => {
          const now = Date.now();
          if (!player || now - lastSave < 5000) return; // throttle (timeupdate fires ~4×/s)
          lastSave = now;
          writeProgress(partId, player.currentTime, videoRef.current?.duration ?? 0);
        });
        player.on("pause", () => {
          if (player) writeProgress(partId, player.currentTime, videoRef.current?.duration ?? 0);
        });
        player.on("ended", () => clearProgress(partId)); // watched to the end → next open restarts
      }

      // Live subtitle loading: a just-opened/just-uploaded video is subtitled on demand by the
      // streamer (it jumps the backfill queue — see _enqueue_priority_subtitle). Poll until the
      // part is finalised (`done`) or a safety cap, injecting new tracks live as they land — so
      // the user doesn't have to reopen the video for subtitles to appear.
      if (subBase && !subtitlesDone) {
        let polls = 0;
        const MAX_POLLS = 75; // ~10 min at 8s — generation of a prioritised video is far quicker
        pollTimer = setInterval(async () => {
          if (destroyed || !player) return;
          polls += 1;
          let stop = polls >= MAX_POLLS;
          try {
            const res = await fetch(subBase);
            if (!destroyed && res.ok) {
              const data = await res.json();
              if (data?.done === true) stop = true;
              const hadNone = captionLangs.length === 0;
              const added = addTracks(Array.isArray(data?.langs) ? data.langs : []);
              // First time captions become available, auto-activate the saved/preferred language
              // so they actually show without the user opening the CC menu (unless pref is "off").
              if (added && hadNone) {
                const chosen = pickCaptionLang(captionLangs, readSubPref());
                const idx = chosen ? captionLangs.indexOf(chosen) : -1;
                if (idx >= 0) {
                  try {
                    player.currentTrack = idx;
                  } catch {}
                }
              }
            }
          } catch {
            // Transient — try again next tick.
          }
          if (stop && pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        }, 8000);
      }
    })();

    return () => {
      destroyed = true;
      if (pollTimer) clearInterval(pollTimer);
      // Save the position on close/source-switch so reopening resumes from the exact spot.
      try {
        if (partId != null && player) {
          writeProgress(partId, player.currentTime, video?.duration ?? 0);
        }
      } catch {}
      try {
        player?.destroy();
      } catch {}
    };
  }, [src, partId]);

  const handleClick = (e: React.MouseEvent) => {
    // The player sits inside .viewer-stage (whose click closes the viewer); stop
    // here so a player click never double-fires that. We decide close vs play below.
    e.stopPropagation();
    const target = e.target as HTMLElement;
    // Plyr controls (incl. the large overlaid play button) handle their own clicks.
    if (target.closest(".plyr__controls") || target.closest(".plyr__control")) return;

    const video = videoRef.current;
    if (!video) return;

    // On touch a tap means "show me the controls", not play/pause — that is what every mobile
    // player does, and Plyr already implements it (tap shows, 3s of stillness hides). Bow out and
    // let it: pausing here instead would both stop the video AND raise the controls on one tap.
    if (matchMedia("(hover: none)").matches) return;

    let vw = video.videoWidth;
    let vh = video.videoHeight;
    if (!vw || !vh) {
      const p = posterDims.current;
      if (p) {
        vw = p.w;
        vh = p.h;
      }
    }

    // Determine whether the click landed on the displayed (contain-fitted) frame.
    let insideFrame = true;
    if (vw && vh) {
      const rect = video.getBoundingClientRect();
      const scale = Math.min(rect.width / vw, rect.height / vh);
      const dispW = vw * scale;
      const dispH = vh * scale;
      const offX = (rect.width - dispW) / 2;
      const offY = (rect.height - dispH) / 2;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      insideFrame =
        x >= offX - 0.5 && x <= offX + dispW + 0.5 && y >= offY - 0.5 && y <= offY + dispH + 0.5;
    }

    if (insideFrame) {
      // Only the frame toggles play/pause; a letterbox click is intentionally inert so the
      // viewer can only be dismissed via the ✕ button or Esc.
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }
  };

  return (
    <div className="viewer-video" onClick={handleClick}>
      <video ref={videoRef} src={src} poster={poster} autoPlay playsInline preload="metadata" />
    </div>
  );
}
