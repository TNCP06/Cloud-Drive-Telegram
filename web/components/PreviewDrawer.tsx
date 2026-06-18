"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/lib/icons";
import { KINDS, TAG_COLORS } from "@/lib/kinds";
import { fmtSize, fmtDate, trashDaysLeft } from "@/lib/format";
import { getCachedGallery, loadGallery } from "@/lib/gallery-cache";
import { TagPicker } from "./TagPicker";
import { reharvestThumbnail, uploadThumbnail } from "@/app/actions";
import type { DriveFile, GalleryPart, Kind, Tag } from "@/lib/types";

const THUMB_MAX_DIM = 320;
const THUMB_QUALITY = 0.85;

// Browser-playable video formats (MKV/AVI need transcoding — excluded).
const STREAMABLE_EXTS = new Set([".mp4", ".webm", ".m4v", ".mov"]);

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
  deepLink,
  hasPrevFile = false,
  hasNextFile = false,
  onNavigateFile,
  onClose,
  onStar,
  onTrash,
  onPurge,
  onRestore,
  onSave,
  initialEditing = false,
  initialShowDetails = false,
}: {
  item: DriveFile;
  tags: Tag[];
  deepLink: string | null;
  hasPrevFile?: boolean;
  hasNextFile?: boolean;
  onNavigateFile?: (delta: number) => void;
  onClose: () => void;
  onStar: (item: DriveFile) => void;
  onTrash: (item: DriveFile) => void;
  onPurge: (item: DriveFile) => void;
  onRestore: (item: DriveFile) => void;
  onSave: (item: DriveFile, input: { title: string; kind: Kind; tags: string }) => void;
  initialEditing?: boolean;
  initialShowDetails?: boolean;
}) {
  const router = useRouter();
  const meta = KINDS[item.kind] || { icon: "archive", tint: "#8A8068", label: item.kind || "Archive" };
  const itemTags = item.tags.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[];

  const [editing, setEditing] = useState(initialEditing);
  const [title, setTitle] = useState(item.name);
  const [kind, setKind] = useState<Kind>(item.kind);
  const [tagsText, setTagsText] = useState(itemTags.map((t) => t.name).join(", "));
  const [thumbBusy, setThumbBusy] = useState(false);
  const [thumbMsg, setThumbMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Initialise from cache — if the gallery was already loaded (or pre-fetched),
  // all photos appear instantly on first render without a cover flash.
  const [gallery, setGallery] = useState<GalleryPart[] | null>(() =>
    item.kind === "media" && item.parts > 1 ? getCachedGallery(item.id) ?? null : null
  );
  const [activeIdx, setActiveIdx] = useState(0);
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
  // shows instantly; the thumbnail strip appears after the fetch completes.
  useEffect(() => {
    setActiveIdx(0);
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

  const partsList: GalleryPart[] = gallery && gallery.length > 0
    ? gallery
    : item.thumb
      ? [{ partId: item.firstPartId ?? 0, fileName: item.fileName, thumb: item.thumb }]
      : [];
  const activePart = partsList[Math.min(activeIdx, partsList.length - 1)] as GalleryPart | undefined;

  // Items without images (archives/etc.) still display full-screen with a large
  // icon + title + kebab; details appear when the kebab is pressed, same as for photos.
  const multi = partsList.length > 1;
  const last = partsList.length - 1;
  // Navigation past a part boundary → jump to the neighbouring file in the list.
  const canPrev = activeIdx > 0 || hasPrevFile;
  const canNext = activeIdx < last || hasNextFile;

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

  const handleVideoKey = useCallback((key: string) => {
    const video = videoRef.current;
    if (!video) return;
    if (key === "ArrowLeft") {
      video.currentTime = Math.max(0, video.currentTime - 5);
    } else if (key === "ArrowRight") {
      const duration = video.duration;
      const targetTime = video.currentTime + 5;
      video.currentTime = isNaN(duration) ? targetTime : Math.min(duration, targetTime);
    } else if (key === "f" || key === "F") {
      if (document.fullscreenElement === video) {
        document.exitFullscreen().catch(() => {});
      } else {
        video.requestFullscreen().catch(() => {});
      }
    } else if (key === "m" || key === "M") {
      video.muted = !video.muted;
    }
  }, []);

  // Auto-focus the video element when it mounts/changes so shortcuts work instantly.
  useEffect(() => {
    if (isPartStreamableVideo(activePart, item.kind) && videoRef.current) {
      videoRef.current.focus();
      try {
        const savedVolume = localStorage.getItem("video-volume");
        if (savedVolume !== null) {
          videoRef.current.volume = Number(savedVolume);
        }
        const savedMuted = localStorage.getItem("video-muted");
        if (savedMuted !== null) {
          videoRef.current.muted = savedMuted === "true";
        }
      } catch {}
    }
  }, [activePart, item.kind, gallery]);

  // Listen to keyboard shortcuts directly on the video element (intercepting and blocking both keydown/keyup events to prevent browser's native controls from double-triggering or seeking slowly)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleNativeKey = (e: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "f", "F", "m", "M"].includes(e.key)) {
        if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.shiftKey) {
          return; // Let Shift + Arrow slide navigation bubble up
        }
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "keydown") {
          handleVideoKey(e.key);
        }
      }
    };

    video.addEventListener("keydown", handleNativeKey);
    video.addEventListener("keyup", handleNativeKey);
    return () => {
      video.removeEventListener("keydown", handleNativeKey);
      video.removeEventListener("keyup", handleNativeKey);
    };
  }, [activePart, item.kind, gallery, handleVideoKey]);

  // Keyboard: Esc closes (detail panel first if open); ←/→ navigates photos/files.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showDetails && !editing) setShowDetails(false);
        else onClose();
        return;
      }
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

      if (isPartStreamableVideo(activePart, item.kind)) {
        if (["ArrowLeft", "ArrowRight", "f", "F", "m", "M"].includes(e.key)) {
          if (e.key === "ArrowLeft" && e.shiftKey) {
            go(-1);
          } else if (e.key === "ArrowRight" && e.shiftKey) {
            go(1);
          } else {
            e.preventDefault();
            handleVideoKey(e.key);
          }
          return;
        }
      } else {
        if (e.key === "ArrowLeft") go(-1);
        else if (e.key === "ArrowRight") go(1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, showDetails, editing, go, item.kind, activePart, handleVideoKey]);

  const save = () => {
    if (!title.trim()) return;
    onSave(item, { title, kind, tags: tagsText });
  };

  // Kebab button only opens the metadata panel (read-only).
  const openDetails = () => {
    setEditing(false);
    setShowDetails(true);
  };

  // Edit button in the top bar opens the panel directly in edit mode.
  const openEdit = () => {
    setEditing(true);
    setShowDetails(true);
  };

  return (
    <>
      {/* ---- Full-screen photo layer ---- */}
      <div className="viewer-scrim" onClick={onClose}></div>
      <div className={"viewer" + (multi ? " has-strip" : "") + (canPrev || canNext ? " has-nav" : "")}>
        <div className="viewer-stage" onClick={onClose}>
          {isPartStreamableVideo(activePart, item.kind) ? (
            <video
              ref={videoRef}
              key={activePart!.partId}
              src={`/api/stream/${activePart!.partId}`}
              poster={activePart!.thumb || undefined}
              controls
              autoPlay
              preload="metadata"
              tabIndex={0}
              onClick={(e) => e.stopPropagation()}
              onVolumeChange={(e) => {
                const video = e.currentTarget;
                try {
                  localStorage.setItem("video-volume", String(video.volume));
                  localStorage.setItem("video-muted", String(video.muted));
                } catch {}
              }}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: "var(--r-sm)", cursor: "default" }}
            />
          ) : activePart?.thumb ? (
            <img src={activePart.thumb} alt={item.name} onClick={(e) => e.stopPropagation()} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: "var(--r-sm)", cursor: "default" }} />
          ) : (
            <Icon name={meta.icon} size={120} stroke={1.2} style={{ color: meta.tint }} />
          )}
        </div>

        {/* Floating controls above the photo. Close/edit/delete on the left, download/
            favorite/kebab on the right — balanced so the title stays centered.
            Kebab only opens the metadata panel. */}
        <div className="viewer-top">
          <div className="viewer-tools">
            <button className="viewer-iconbtn" onClick={onClose} title="Close">
              <Icon name="close" size={17} />
            </button>
          </div>
          <span className="viewer-name">{item.version ? item.family : item.name}</span>
          <div className="viewer-tools" style={{ width: 32 }}></div>
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

        {multi && (
          <div className="viewer-strip">
            {partsList.map((part, i) => (
              <button
                key={i}
                className={"viewer-thumb" + (i === activeIdx ? " on" : "")}
                onClick={() => setActiveIdx(i)}
                title={`Part ${i + 1}`}
              >
                {part.thumb ? (
                  <Image src={part.thumb} alt="" fill unoptimized style={{ objectFit: "cover" }} />
                ) : (
                  <div className="viewer-thumb-placeholder" style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.05)", color: "var(--fg-muted)" }}>
                    <Icon name={isPartStreamableVideo(part, item.kind) ? "video" : "file"} size={16} />
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ---- Detail panel (appears when the kebab button is pressed) ---- */}
      {showDetails && (
        <>
          <div
            className="drawer-scrim"
            onClick={() => setShowDetails(false)}
          ></div>
          <div className="drawer">
            <div className="dv-head">
              <strong>{editing ? "Edit metadata" : "Details"}</strong>
              <button
                className="iconbtn ghost"
                onClick={() => setShowDetails(false)}
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
                      <dd>{meta.label}</dd>
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
