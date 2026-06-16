"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/lib/icons";
import { KINDS, TAG_COLORS } from "@/lib/kinds";
import { fmtSize, fmtDate, trashDaysLeft } from "@/lib/format";
import { getCachedGallery, loadGallery } from "@/lib/gallery-cache";
import { TagPicker } from "./TagPicker";
import type { DriveFile, Kind, Tag } from "@/lib/types";

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
  onRestore,
  onSave,
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
  onRestore: (item: DriveFile) => void;
  onSave: (item: DriveFile, input: { title: string; kind: Kind; tags: string }) => void;
}) {
  const meta = KINDS[item.kind];
  const itemTags = item.tags.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[];

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.name);
  const [kind, setKind] = useState<Kind>(item.kind);
  const [tagsText, setTagsText] = useState(itemTags.map((t) => t.name).join(", "));
  // Initialise from cache — if the gallery was already loaded (or pre-fetched),
  // all photos appear instantly on first render without a cover flash.
  const [gallery, setGallery] = useState<string[] | null>(() =>
    item.kind === "media" && item.parts > 1 ? getCachedGallery(item.id) ?? null : null
  );
  const [activeIdx, setActiveIdx] = useState(0);
  // Detail panel is hidden behind the kebab button; photos show full-screen.
  const [showDetails, setShowDetails] = useState(false);

  // Reset form when the opened item changes (or when leaving edit mode).
  useEffect(() => {
    setEditing(false);
    setShowDetails(false);
    setTitle(item.name);
    setKind(item.kind);
    setTagsText(item.tags.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean).join(", "));
  }, [item.id, item.name, item.kind, item.tags, tags]);

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

  const images = gallery && gallery.length > 0 ? gallery : item.thumb ? [item.thumb] : [];
  const active = images[Math.min(activeIdx, images.length - 1)];

  // Items without images (games/archives/etc.) still display full-screen with a large
  // icon + title + kebab; details appear when the kebab is pressed, same as for photos.
  const multi = images.length > 1;
  const last = images.length - 1;
  // Navigation past a part boundary → jump to the neighbouring file in the list.
  const canPrev = activeIdx > 0 || hasPrevFile;
  const canNext = activeIdx < last || hasNextFile;

  // Move to the next/previous part; if already at the edge, jump to the next file.
  const go = (delta: number) => {
    if (delta > 0) {
      if (activeIdx < last) setActiveIdx(activeIdx + 1);
      else if (hasNextFile) onNavigateFile?.(1);
    } else {
      if (activeIdx > 0) setActiveIdx(activeIdx - 1);
      else if (hasPrevFile) onNavigateFile?.(-1);
    }
  };

  // Keyboard: Esc closes (detail panel first if open); ←/→ navigates photos/files.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showDetails && !editing) setShowDetails(false);
        else onClose();
        return;
      }
      if (editing || showDetails) return;
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, showDetails, editing, activeIdx, last, hasPrevFile, hasNextFile]);

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
          {active ? (
            <img src={active} alt={item.name} onClick={(e) => e.stopPropagation()} />
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
            {!item.trashed && (
              <>
                <button className="viewer-iconbtn" onClick={openEdit} title="Edit metadata">
                  <Icon name="edit" size={17} />
                </button>
                <button className="viewer-iconbtn" onClick={() => onTrash(item)} title="Delete">
                  <Icon name="trash" size={17} />
                </button>
              </>
            )}
          </div>
          <span className="viewer-name">{item.version ? item.family : item.name}</span>
          <div className="viewer-tools">
            {item.trashed ? (
              <button className="viewer-iconbtn" onClick={() => onRestore(item)} title="Restore">
                <Icon name="restore" size={17} />
              </button>
            ) : (
              <>
                {deepLink && (
                  <a
                    className="viewer-iconbtn"
                    href={deepLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Download"
                  >
                    <Icon name="download" size={17} />
                  </a>
                )}
                <button
                  className={"viewer-iconbtn" + (item.starred ? " on" : "")}
                  onClick={() => onStar(item)}
                  title="Favorite"
                >
                  <Icon name="star" size={17} fill={item.starred} />
                </button>
              </>
            )}
            <button className="viewer-iconbtn" onClick={openDetails} title="Metadata details">
              <Icon name="kebab" size={17} />
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

        {multi && (
          <div className="viewer-strip">
            {images.map((src, i) => (
              <button
                key={i}
                className={"viewer-thumb" + (i === activeIdx ? " on" : "")}
                onClick={() => setActiveIdx(i)}
                title={`Part ${i + 1}`}
              >
                <img src={src} alt="" />
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
                  {kind === "game" && (
                    <p className="dv-hint">
                      For games, the title also groups versions (e.g. &quot;Eternum 0.6&quot; →
                      family &quot;Eternum&quot;). Download links remain unchanged.
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
