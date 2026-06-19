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
 *   • on the letterbox    → close the viewer (`onRequestClose`)
 *   • on the controls      → handled by Plyr
 * The frame vs letterbox split is computed from the displayed `object-fit:
 * contain` rectangle, falling back to the poster's aspect ratio before the
 * video's own dimensions are known (i.e. while still loading).
 */
export function VideoPlayer({
  src,
  poster,
  onRequestClose,
}: {
  src: string;
  poster?: string;
  onRequestClose: () => void;
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
      player = new PlyrCtor(videoRef.current, {
        seekTime: 5, // ←/→ seek by 5 seconds
        clickToPlay: false, // we split frame-click (play) vs letterbox-click (close)
        keyboard: { focused: true, global: true },
        storage: { enabled: false }, // we manage volume/mute persistence ourselves
        controls: [
          "play-large",
          "play",
          "progress",
          "current-time",
          "duration",
          "mute",
          "volume",
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
    })();

    return () => {
      destroyed = true;
      try {
        player?.destroy();
      } catch {}
    };
  }, [src]);

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
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    } else if (!document.fullscreenElement) {
      // Letterbox click closes — but never while fullscreen (Esc/the button exit it).
      onRequestClose();
    }
  };

  return (
    <div className="viewer-video" onClick={handleClick}>
      <video ref={videoRef} src={src} poster={poster} autoPlay playsInline preload="metadata" />
    </div>
  );
}
