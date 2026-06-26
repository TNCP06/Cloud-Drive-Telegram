"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/lib/icons";
import { KINDS, TAG_COLORS } from "@/lib/kinds";
import { fileTypeFor } from "@/lib/fileType";
import { fmtSize, fmtDate, trashDaysLeft } from "@/lib/format";
import { getCachedGallery, loadGallery } from "@/lib/gallery-cache";
import { TagPicker } from "./TagPicker";
import { VideoPlayer } from "./VideoPlayer";
import { DocPreview } from "./DocPreview";
import { reharvestThumbnail, uploadThumbnail } from "@/app/actions";
import type { DriveFile, GalleryPart, Kind, Tag } from "@/lib/types";

const THUMB_MAX_DIM = 320;
const THUMB_QUALITY = 0.85;

// All video formats the streamer can serve. Non-browser-native containers (MKV, AVI, …)
// are served as-is on first play and background-transcoded to MP4 for subsequent views.
const STREAMABLE_EXTS = new Set([
  ".mp4", ".webm", ".m4v", ".mov",
  ".mkv", ".avi", ".flv", ".3gp", ".ts",
]);

function isPartStreamableVideo(part: GalleryPart | undefined, itemKind: Kind): boolean {
  if (!part || itemKind !== "media" || !part.partId || !part.fileName) return false;
  const dot = part.fileName.lastIndexOf(".");
  if (dot < 0) return false;
  return STREAMABLE_EXTS.has(part.fileName.substring(dot).toLowerCase());
}

async function resizeToJpeg(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, THUMB_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", THUMB_QUALITY));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Cannot load image.")); };
    img.src = url;
  });
}

async function videoFrameToJpeg(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.muted = true;
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      video.currentTime = video.duration > 2 ? 1 : video.duration / 2;
    };
    video.onseeked = () => {
      const vw = video.videoWidth || THUMB_MAX_DIM;
      const vh = video.videoHeight || THUMB_MAX_DIM;
      const scale = Math.min(1, THUMB_MAX_DIM / Math.max(vw, vh));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", THUMB_QUALITY));
    };
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Browser cannot decode this video format.")); };
    setTimeout(() => { URL.revokeObjectURL(url); reject(new Error("Video load timed out.")); }, 20_000);
    video.src = url;
  });
}

export function PreviewDrawer({
  item,
  tags,
  hasPrevFile = false,
  hasNextFile = false,
  onNavigateFile,
  onClose,
  onSave,
  onDownload,
  onToggleStar,
  navFiles,
  onJumpToFile,
  initialEditing = false,
  initialShowDetails = false,
  detailsOnly = false,
}: {
  item: DriveFile;
  tags: Tag[];
  hasPrevFile?: boolean;
  hasNextFile?: boolean;
  onNavigateFile?: (delta: number) => void;
  onClose: () => void;
  onSave: (item: DriveFile, input: { title: string; kind: Kind; tags: string }) => void;
  onDownload?: () => void;
  onToggleStar?: () => void;
  navFiles?: DriveFile[];
  onJumpToFile?: (file: DriveFile) => void;
  initialEditing?: boolean;
  initialShowDetails?: boolean;
  detailsOnly?: boolean;
}) {
  const router = useRouter();
  // Fine-grained file type (PDF/Word/Excel/…) derived from the part's file name.
  const ft = fileTypeFor(item);
  const itemTags = item.tags.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[];

  const [editing, setEditing] = useState(initialEditing);
  const [title, setTitle] = useState(item.name);
  const [kind, setKind] = useState<Kind>(item.kind);
  const [tagsText, setTagsText] = useState(itemTags.map((t) => t.name).join(", "));
  const [thumbBusy, setThumbBusy] = useState(false);
  const [thumbMsg, setThumbMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const activeThumbRef = useRef<HTMLButtonElement>(null);
  const closeDetails = () => setShowDetails(false);
  // Photo viewing affordances (mirror the PikPak bottom box: counter + filmstrip + rotate/fullscreen).
  const [rotation, setRotation] = useState(0);
  // The bottom box is shown by default; "collapse" hides its filmstrip (chevron or the "E" key).
  // The preference is persisted so a chosen expand/collapse survives reloads & other items.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("viewer-strip-collapsed") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("viewer-strip-collapsed", collapsed ? "1" : "0"); } catch {}
  }, [collapsed]);
  // Horizontal filmstrip scroller (ref + overflow flag drive the left/right scroll buttons).
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripOverflow, setStripOverflow] = useState(false);
  const scrollStrip = (dir: number) =>
    stripRef.current?.scrollBy({ left: dir * Math.max(240, stripRef.current.clientWidth * 0.8), behavior: "smooth" });
  // Floating chrome (title bar, control float-row, nav arrows) slides away when the cursor leaves
  // the window, and — in fullscreen — after the mouse sits idle for a few seconds.
  const [chromeHidden, setChromeHidden] = useState(false);
  // Fullscreen the WHOLE viewer (not just the media) so the title, controls and filmstrip stay
  // visible in fullscreen — otherwise an expanded strip would vanish on entering fullscreen.
  const toggleFullscreen = () => {
    const el = viewerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };
  // Toggle native looping on the current <video> (the "P" shortcut), remembered for the next video.
  const toggleVideoLoop = () => {
    const video = document.querySelector<HTMLVideoElement>(".viewer-video video");
    if (!video) return;
    video.loop = !video.loop;
    try {
      localStorage.setItem("video-loop", String(video.loop));
    } catch {}
  };
  // Initialise from cache — if the gallery was already loaded (or pre-fetched),
  // all photos appear instantly on first render without a cover flash.
  const [gallery, setGallery] = useState<GalleryPart[] | null>(() =>
    item.kind === "media" && item.parts > 1 ? getCachedGallery(item.id) ?? null : null
  );
  const [activeIdx, setActiveIdx] = useState(0);
  // Galleries for EVERY multi-part item in the nav list, so the filmstrip can show every photo as
  // its own thumb even when the open item itself has no parts. Loaded once (cached) per session.
  const [galMap, setGalMap] = useState<Record<number, GalleryPart[]>>({});
  // When a strip thumb belongs to a DIFFERENT album, remember which part to land on after the jump.
  const pendingPartRef = useRef<{ id: number; idx: number } | null>(null);
  // Detail panel is hidden behind the kebab button; photos show full-screen.
  const [showDetails, setShowDetails] = useState(initialEditing || initialShowDetails);

  // Reset form when the opened item changes (or when leaving edit mode).
  useEffect(() => {
    setEditing(initialEditing);
    setShowDetails(initialEditing || initialShowDetails);
    setTitle(item.name);
    setKind(item.kind);
    setTagsText(item.tags.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean).join(", "));
    setThumbMsg(null);
  }, [item.id, item.name, item.kind, item.tags, tags, initialEditing, initialShowDetails]);

  // A fresh photo/part always starts un-rotated.
  useEffect(() => {
    setRotation(0);
  }, [item.id, activeIdx]);

  // Keep the active thumbnail scrolled into view as the current media changes.
  useEffect(() => {
    activeThumbRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [item.id, collapsed]);

  // Auto-hide the floating chrome: hide when the cursor leaves the window; in fullscreen also hide
  // after the mouse is idle a few seconds, revealing it again on any movement.
  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | undefined;
    const clearIdle = () => { if (idle) { clearTimeout(idle); idle = undefined; } };
    const onMove = () => {
      setChromeHidden(false);
      clearIdle();
      if (document.fullscreenElement) idle = setTimeout(() => setChromeHidden(true), 1000);
    };
    const onOut = (e: MouseEvent) => { if (!e.relatedTarget) setChromeHidden(true); }; // left the window
    const onOver = () => setChromeHidden(false);
    const onFsChange = () => { clearIdle(); setChromeHidden(false); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("mouseover", onOver);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      clearIdle();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("fullscreenchange", onFsChange);
    };
  }, []);

  const onRefreshThumb = async () => {
    setThumbBusy(true);
    setThumbMsg(null);
    try {
      const r = await reharvestThumbnail(item.id);
      if (r.harvested > 0) {
        router.refresh();
        setThumbMsg(`Thumbnail fetched (${r.harvested} part${r.harvested > 1 ? "s" : ""}).`);
      } else if (!r.error) {
        setThumbMsg("Thumbnail already up-to-date.");
      } else {
        setThumbMsg(r.error);
      }
    } catch {
      setThumbMsg("Failed — check bot logs.");
    } finally {
      setThumbBusy(false);
    }
  };

  const onUploadThumb = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setThumbBusy(true);
    setThumbMsg(file.type.startsWith("video/") ? "Extracting frame…" : "Resizing…");
    try {
      const dataUrl = file.type.startsWith("video/")
        ? await videoFrameToJpeg(file)
        : await resizeToJpeg(file);
      const b64 = dataUrl.split(",")[1];
      const r = await uploadThumbnail(item.id, "image/jpeg", b64);
      if (r.ok) {
        router.refresh();
        setThumbMsg(`Saved (${r.updated} part${r.updated !== 1 ? "s" : ""}).`);
      } else {
        setThumbMsg(r.error ?? "Upload failed.");
      }
    } catch (err) {
      setThumbMsg(err instanceof Error ? err.message : "Failed to process file.");
    } finally {
      setThumbBusy(false);
      e.target.value = "";
    }
  };

  // Album gallery is loaded on-demand (only for multi-part media). The cover (item.thumb)
  // shows instantly; the thumbnail strip appears after the fetch completes. When arriving via a
  // strip thumb of a different album, land on that album's chosen part instead of the first.
  useEffect(() => {
    const pending = pendingPartRef.current;
    pendingPartRef.current = null;
    setActiveIdx(pending && pending.id === item.id ? pending.idx : 0);
    if (item.kind === "media" && item.parts > 1) {
      // Cache hit → render immediately without touching the database at all.
      const cached = getCachedGallery(item.id);
      if (cached) {
        setGallery(cached);
        return;
      }
      let alive = true;
      setGallery(null);
      loadGallery(item.id)
        .then((g) => alive && setGallery(g))
        .catch(() => alive && setGallery([]));
      return () => {
        alive = false;
      };
    }
    setGallery(null);
  }, [item.id, item.kind, item.parts]);

  // Pre-load galleries for EVERY multi-part item in the view so the strip can show each photo as a
  // thumb — even while previewing a non-parts item. Cached + de-duped, so it's a one-off per session.
  const navIdsKey = (navFiles ?? []).map((f) => f.id).join(",");
  useEffect(() => {
    const multis = (navFiles ?? []).filter((f) => f.kind === "media" && f.parts > 1);
    const seed: Record<number, GalleryPart[]> = {};
    for (const f of multis) {
      const c = getCachedGallery(f.id);
      if (c) seed[f.id] = c;
    }
    if (Object.keys(seed).length) setGalMap((m) => ({ ...m, ...seed }));
    let alive = true;
    for (const f of multis) {
      if (getCachedGallery(f.id)) continue;
      loadGallery(f.id)
        .then((g) => { if (alive) setGalMap((m) => ({ ...m, [f.id]: g })); })
        .catch(() => {});
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navIdsKey]);

  // Always ≥1 entry (the item itself when there's no multi-part gallery) so the bottom box's
  // filmstrip stays consistent — and present — even for single/thumbless media.
  const partsList: GalleryPart[] = gallery && gallery.length > 0
    ? gallery
    : [{ partId: item.firstPartId ?? 0, fileName: item.fileName, thumb: item.thumb, size: item.size }];
  const activePart = partsList[Math.min(activeIdx, partsList.length - 1)] as GalleryPart | undefined;

  // Items without images (archives/etc.) still display full-screen with a large
  // icon + title + kebab; details appear when the kebab is pressed, same as for photos.
  const last = partsList.length - 1;
  // Navigation past a part boundary → jump to the neighbouring file in the list.
  const canPrev = activeIdx > 0 || hasPrevFile;
  const canNext = activeIdx < last || hasNextFile;
  // A still image on the stage gets rotate; images, videos and docs get a fullscreen control.
  const isVideoStage = isPartStreamableVideo(activePart, item.kind);
  // Inline document preview (PDF/text/Word/Excel) — takes priority over a static cover
  // thumbnail for non-media items so the interactive preview shows instead of a flat image.
  const docPartId = activePart?.partId ?? item.firstPartId ?? 0;
  const isDocStage =
    item.kind !== "media" &&
    docPartId > 0 &&
    (ft.preview === "pdf" || ft.preview === "text" || ft.preview === "word" || ft.preview === "sheet");
  const isImageStage = !!activePart?.thumb && !isVideoStage && !isDocStage;

  // The bottom filmstrip lists the OTHER media in this view (siblings from the parent's nav list).
  // The CURRENTLY-OPEN item expands into its individual parts so an album's photos each show as a
  // clickable thumb; every other item shows a single cover thumb. Clicking a part scrubs within the
  // album; clicking another item jumps to it. Falls back to just the current item with no nav list.
  // Hover tooltip for a strip thumb: the real file name (incl. extension) + its size.
  const tipFor = (name: string | null, fallback: string, bytes: number) => {
    const n = (name && name.trim()) || fallback;
    return bytes > 0 ? `${n} — ${fmtSize(bytes)}` : n;
  };
  const stripFiles: DriveFile[] = navFiles && navFiles.length > 0 ? navFiles : [item];
  const stripThumbs = stripFiles.flatMap((f) => {
    // Prefer the freshly-loaded current gallery, else the pre-loaded map, to expand an album.
    const parts = f.id === item.id ? gallery ?? galMap[f.id] : galMap[f.id];
    if (f.parts > 1 && parts && parts.length > 1) {
      return parts.map((part, i) => ({
        key: `${f.id}:${i}`,
        thumb: part.thumb,
        title: tipFor(part.fileName, f.version ? f.family : f.name, part.size),
        active: f.id === item.id && i === activeIdx,
        icon: isPartStreamableVideo(part, f.kind) ? "video" : "image",
        isVideo: isPartStreamableVideo(part, f.kind),
        onClick:
          f.id === item.id
            ? () => setActiveIdx(i)
            : () => { pendingPartRef.current = { id: f.id, idx: i }; onJumpToFile?.(f); },
      }));
    }
    return [{
      key: `${f.id}`,
      thumb: f.thumb,
      title: tipFor(f.fileName, f.version ? f.family : f.name, f.size),
      active: f.id === item.id,
      icon: fileTypeFor(f).icon,
      isVideo: fileTypeFor(f).preview === "video",
      onClick: () => { if (f.id !== item.id) onJumpToFile?.(f); },
    }];
  });
  const activeThumbIndex = Math.max(0, stripThumbs.findIndex((t) => t.active));

  // Show the left/right scroll buttons only when the filmstrip actually overflows. Re-measured
  // when the thumb count / collapse state changes and on window resize.
  const stripCount = stripThumbs.length;
  useEffect(() => {
    if (collapsed) {
      setStripOverflow(false);
      return;
    }
    const measure = () => {
      const el = stripRef.current;
      setStripOverflow(!!el && el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [stripCount, collapsed]);

  // Move to the next/previous part; if already at the edge, jump to the next file.
  const go = useCallback((delta: number) => {
    if (delta > 0) {
      if (activeIdx < last) setActiveIdx(activeIdx + 1);
      else if (hasNextFile) onNavigateFile?.(1);
    } else {
      if (activeIdx > 0) setActiveIdx(activeIdx - 1);
      else if (hasPrevFile) onNavigateFile?.(-1);
    }
  }, [activeIdx, last, hasNextFile, hasPrevFile, onNavigateFile]);

  // Keyboard. Esc closes (detail panel first if open). For videos, Plyr owns the
  // media shortcuts (←/→ seek 5s, f fullscreen, m mute, space play) — we only add
  // Shift+←/→ to jump between parts/files. For non-video items, ←/→ navigates.
  // Uses capture phase so Shift+arrows are intercepted before Plyr's global handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.fullscreenElement) return; // let Plyr exit fullscreen first
        // Consume the Esc here (capture phase) so it never reaches the grid's
        // selection-clear handler — closing the preview must not drop the selection.
        e.stopPropagation();
        if (detailsOnly) onClose();
        else if (showDetails && !editing) closeDetails();
        else onClose();
        return;
      }
      if (detailsOnly) return;
      if (editing || showDetails) return;

      // Ignore global shortcuts if the user is typing in any input/textarea/editable
      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl && (
        activeEl.tagName === "INPUT" ||
        activeEl.tagName === "TEXTAREA" ||
        activeEl.isContentEditable
      )) {
        return;
      }

      // "E" collapses/expands the bottom box (its filmstrip) — works for photos and videos.
      if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        e.stopPropagation();
        setCollapsed((c) => !c);
        return;
      }

      // "F" fullscreens the whole viewer for images AND videos (we route video fullscreen through
      // the viewer too — Plyr's own fullscreen is disabled — so the strip/controls stay consistent).
      const onMedia = isPartStreamableVideo(activePart, item.kind) || !!activePart?.thumb || isDocStage;
      if ((e.key === "f" || e.key === "F") && onMedia) {
        e.preventDefault();
        e.stopPropagation();
        toggleFullscreen();
        return;
      }

      // "P" toggles looping on the current video.
      if ((e.key === "p" || e.key === "P") && isPartStreamableVideo(activePart, item.kind)) {
        e.preventDefault();
        e.stopPropagation();
        toggleVideoLoop();
        return;
      }

      if (isPartStreamableVideo(activePart, item.kind)) {
        // Shift+arrow → navigate parts/files; plain arrows fall through to Plyr.
        if (e.shiftKey && e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          go(-1);
        } else if (e.shiftKey && e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          go(1);
        }
        return;
      }
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, showDetails, editing, go, item.kind, activePart, detailsOnly, isDocStage]);

  const save = () => {
    if (!title.trim()) return;
    onSave(item, { title, kind, tags: tagsText });
  };

  return (
    <>
      {/* ---- Full-screen photo layer ---- */}
      {!detailsOnly && (
        <>
          {/* Backdrop is purely visual now — clicking it must NOT close the viewer. */}
          <div className="viewer-scrim"></div>
          <div ref={viewerRef} className={"viewer" + (!collapsed ? " has-bottom" : "") + (canPrev || canNext ? " has-nav" : "") + (chromeHidden ? " chrome-hidden" : "") + (isVideoStage ? " has-video-stage" : "")}>
            <div className="viewer-stage">
              {isVideoStage ? (
                <VideoPlayer
                  key={activePart!.partId}
                  src={`/api/stream/${activePart!.partId}`}
                  poster={activePart!.thumb || undefined}
                  partId={activePart!.partId}
                />
              ) : isDocStage ? (
                <DocPreview
                  key={docPartId}
                  partId={docPartId}
                  ft={ft}
                  size={item.size}
                  onDownload={onDownload}
                />
              ) : isImageStage ? (
                <Image src={activePart!.thumb!} alt={item.name} unoptimized width={0} height={0} sizes="100vw" style={{ width: "auto", height: "auto", maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 0, cursor: "default", transform: rotation ? `rotate(${rotation}deg)` : undefined, transition: "transform .2s ease" }} />
              ) : (
                <Icon name={ft.icon} size={120} stroke={1.2} style={{ color: ft.tint }} />
              )}
            </div>

            {/* Floating top bar (PikPak-style): filename on the left; download, favorite,
                details (kebab), a divider, then the ✕ close on the right. The ONLY ways to
                leave the viewer are this ✕ button or the Esc key. */}
            <div className="viewer-top">
              <span className="viewer-name">{item.version ? item.family : item.name}</span>
              <div className="viewer-tools">
                {onDownload && (
                  <button className="viewer-iconbtn" onClick={onDownload} title="Download">
                    <Icon name="download" size={17} />
                  </button>
                )}
                {onToggleStar && (
                  <button
                    className={"viewer-iconbtn" + (item.starred ? " on" : "")}
                    onClick={onToggleStar}
                    title={item.starred ? "Remove from favorites" : "Add to favorites"}
                  >
                    <Icon name="star" size={17} fill={item.starred} />
                  </button>
                )}
                <button
                  className="viewer-iconbtn"
                  onClick={() => setShowDetails(true)}
                  title="Details"
                >
                  <Icon name="kebab" size={17} />
                </button>
                {(isImageStage || isVideoStage || isDocStage) && (
                  <button
                    className="viewer-iconbtn"
                    onClick={toggleFullscreen}
                    title="Fullscreen (F)"
                  >
                    <Icon name="expand" size={17} />
                  </button>
                )}
                <span className="viewer-sep" />
                <button className="viewer-iconbtn" onClick={onClose} title="Close (Esc)">
                  <Icon name="close" size={17} />
                </button>
              </div>
            </div>

            {(canPrev || canNext) && (
              <>
                <button
                  className="viewer-nav prev"
                  onClick={() => go(-1)}
                  disabled={!canPrev}
                  title="Previous (←)"
                >
                  <Icon name="back" size={22} />
                </button>
                <button
                  className="viewer-nav next"
                  onClick={() => go(1)}
                  disabled={!canNext}
                  title="Next (→)"
                >
                  <Icon name="chevright" size={22} />
                </button>
              </>
            )}

            {/* Floating controls over the media (like the title bar), just above the bottom box:
                part counter + collapse chevron (center) and rotate/fullscreen (right). The collapse
                chevron / "E" hides the box so the media grows to fill the freed space. */}
            <div className="viewer-floatbar" style={{ bottom: isVideoStage ? (collapsed ? 48 : 91) : (collapsed ? 14 : 91) }}>
              <div />
              <div className="viewer-floatcenter">
                {stripThumbs.length > 1 && (
                  <span className="viewer-count">{activeThumbIndex + 1} / {stripThumbs.length}</span>
                )}
                <button
                  className="viewer-iconbtn"
                  onClick={() => setCollapsed((c) => !c)}
                  title={collapsed ? "Expand (E)" : "Collapse (E)"}
                >
                  <Icon name={collapsed ? "chevup" : "chevdown"} size={16} />
                </button>
              </div>
              <div className="viewer-botbtns">
                {isImageStage && (
                  <button
                    className="viewer-iconbtn"
                    onClick={() => setRotation((r) => (r + 90) % 360)}
                    title="Rotate"
                  >
                    <Icon name="rotate" size={16} />
                  </button>
                )}
              </div>
            </div>

            {/* Bottom box = a solid, full-bleed, thin filmstrip flush to the media. Always present
                (even single media) unless collapsed, where it's removed so the media fills fully. */}
            {!collapsed && (
              <div className="viewer-bottom">
                {stripOverflow && (
                  <button
                    className="viewer-strip-scroll left"
                    onClick={() => scrollStrip(-1)}
                    title="Scroll left"
                    aria-label="Scroll filmstrip left"
                  >
                    <Icon name="back" size={16} />
                  </button>
                )}
                <div className="viewer-strip" ref={stripRef}>
                  {stripThumbs.map((t) => (
                    <button
                      key={t.key}
                      ref={t.active ? activeThumbRef : undefined}
                      className={"viewer-thumb" + (t.active ? " on" : "")}
                      onClick={t.onClick}
                      title={t.title}
                    >
                      {t.thumb ? (
                        <Image src={t.thumb} alt="" fill unoptimized style={{ objectFit: "cover" }} />
                      ) : (
                        <div className="viewer-thumb-placeholder" style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.05)", color: "var(--fg-muted)" }}>
                          <Icon name={t.icon} size={18} />
                        </div>
                      )}
                      {t.isVideo && (
                        <span className="viewer-thumb-play" aria-hidden>
                          <Icon name="play" size={22} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                {stripOverflow && (
                  <button
                    className="viewer-strip-scroll right"
                    onClick={() => scrollStrip(1)}
                    title="Scroll right"
                    aria-label="Scroll filmstrip right"
                  >
                    <Icon name="chevright" size={16} />
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ---- Detail panel (appears when the kebab button is pressed) ---- */}
      {showDetails && (
        <>
          <div
            className="drawer-scrim"
            onClick={detailsOnly ? onClose : closeDetails}
          ></div>
          <div className="drawer">
            <div className="dv-head">
              <strong>{editing ? "Edit metadata" : "Details"}</strong>
              <button
                className="iconbtn ghost"
                onClick={detailsOnly ? onClose : closeDetails}
                title="Close"
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <div className="dv-body">
              {editing ? (
                <div className="dv-edit">
                  <label className="dv-field">
                    <span>Title</span>
                    <input
                      autoFocus
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Item title"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") save();
                      }}
                    />
                  </label>
                  <label className="dv-field">
                    <span>Type</span>
                    <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                      {(Object.keys(KINDS) as Kind[]).map((k) => (
                        <option key={k} value={k}>
                          {KINDS[k].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="dv-field">
                    <span>Categories</span>
                    <TagPicker
                      value={tagsText}
                      onChange={setTagsText}
                      suggestions={tags}
                      placeholder="e.g. rpg, fantasy"
                    />
                  </div>
                  {kind === "archive" && (
                    <p className="dv-hint">
                      For archives, the title also groups versions (e.g. &quot;Archive 1.0.0&quot; →
                      family &quot;Archive&quot;). Download links remain unchanged.
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <div className="dv-title">
                    {item.version ? item.family : item.name}
                    {item.version && <span className="ver">{item.version}</span>}
                  </div>

                  <div className="dv-section">
                    <h4>Details</h4>
                    <dl className="dv-meta">
                      <dt>Type</dt>
                      <dd>{ft.label}</dd>
                      <dt>Size</dt>
                      <dd>{fmtSize(item.size)}</dd>
                      {item.parts > 1 && (
                        <>
                          <dt>{item.kind === "media" ? "Contents" : "Parts"}</dt>
                          <dd>
                            {item.parts} {item.kind === "media" ? "files" : "parts"}
                          </dd>
                        </>
                      )}
                      <dt>Added</dt>
                      <dd>{fmtDate(item.added)}</dd>
                      {item.trashed && item.deletedAt != null && (
                        <>
                          <dt>Trash</dt>
                          <dd>permanently deleted in {trashDaysLeft(item.deletedAt)} days</dd>
                        </>
                      )}
                    </dl>
                  </div>

                  {itemTags.length > 0 && (
                    <div className="dv-section">
                      <h4>Tags</h4>
                      <div className="dv-tags">
                        {itemTags.map((t) => (
                          <span key={t.id} className="chip" style={{ ["--c" as string]: TAG_COLORS[t.color] }}>
                            <i></i>
                            {t.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {item.kind === "media" && !item.trashed && (
                    <div className="dv-section">
                      <h4>Thumbnail</h4>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button className="btn sm" onClick={onRefreshThumb} disabled={thumbBusy}>
                          {thumbBusy ? (
                            <span className="spinner sm" />
                          ) : (
                            <Icon name="refresh" size={14} />
                          )}
                          {item.thumb ? "Re-fetch" : "Fetch from Telegram"}
                        </button>
                        <button
                          className="btn sm"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={thumbBusy}
                        >
                          <Icon name="upload" size={14} />
                          Set thumbnail…
                        </button>
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*,video/*"
                        style={{ display: "none" }}
                        onChange={onUploadThumb}
                      />
                      {thumbMsg && (
                        <p className="dv-hint" style={{ marginTop: 6 }}>
                          {thumbMsg}
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer only shown in edit mode; other actions are in the top bar. */}
            {editing && (
              <div className="dv-actions">
                <button className="btn primary" onClick={save} disabled={!title.trim()}>
                  <Icon name="check" size={16} />
                  Save
                </button>
                <button className="btn" onClick={() => setEditing(false)}>
                  <Icon name="close" size={16} />
                  Cancel
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
