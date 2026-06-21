"use client";

import { useEffect, useRef } from "react";
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

// Looping is remembered globally (toggled by the "P" shortcut in the viewer) so the next video
// keeps the same loop setting.
function readLoopPref(): boolean {
  try {
    return localStorage.getItem("video-loop") === "true";
  } catch {
    return false;
  }
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
}: {
  src: string;
  poster?: string;
  partId?: number;
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

    (async () => {
      const PlyrCtor = (await import("plyr")).default;
      if (destroyed || !videoRef.current) return;

      // Load generated subtitle tracks (original + EN + ID) and inject them BEFORE
      // Plyr initialises so they show up in the captions (CC) menu.
      let captionLangs: string[] = [];
      if (partId) {
        try {
          const res = await fetch(`/api/subtitles/${partId}`);
          if (!destroyed && res.ok) {
            const data = await res.json();
            captionLangs = Array.isArray(data?.langs) ? data.langs : [];
            const vid = videoRef.current;
            if (vid) {
              for (const lang of captionLangs) {
                if (vid.querySelector(`track[srclang="${lang}"]`)) continue;
                const track = document.createElement("track");
                track.kind = "captions";
                track.label = langLabel(lang);
                track.srclang = lang;
                track.src = `/api/subtitles/${partId}/${lang}`;
                vid.appendChild(track);
              }
            }
          }
        } catch {
          // No captions is fine — never block playback on subtitle loading.
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
        captions: { active: chosenLang != null, language: chosenLang ?? "auto", update: true },
        controls: [
          "play-large",
          "play",
          "progress",
          "current-time",
          "duration",
          "mute",
          "volume",
          "captions",
          "settings",
          "pip",
          "fullscreen",
        ],
        tooltips: { controls: true, seek: true },
      });

      player.on("ready", () => {
        const { volume, muted } = readSavedVolume();
        if (player) {
          if (volume !== null) player.volume = volume;
          if (muted !== null) player.muted = muted;
        }
        if (videoRef.current) videoRef.current.loop = readLoopPref();
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
    })();

    return () => {
      destroyed = true;
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
