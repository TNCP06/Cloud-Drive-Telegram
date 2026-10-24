"use client";

import Image from "next/image";
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/lib/icons";
import { TAG_COLORS } from "@/lib/kinds";
import { fileTypeFor, displayName } from "@/lib/fileType";
import { fmtSize, fmtDate, trashDaysLeft } from "@/lib/format";
import type { DriveFile, Tag, Folder } from "@/lib/types";

/* ---- Client-only text (timestamps) ----
   suppressHydrationWarning silences timezone differences between VPS SSR (UTC)
   and browser client local time without allocating thousands of useState/useEffect
   lifecycles across the file list. */
function ClientText({ render }: { render: () => string }) {
  return <span suppressHydrationWarning>{render()}</span>;
}

/* ---- Tag chip ---- */
export function Chip({ tag, big }: { tag: Tag | undefined; big?: boolean }) {
  if (!tag) return null;
  const c = TAG_COLORS[tag.color] || tag.color;
  return (
    <span className={"chip" + (big ? " lg" : "")} style={{ ["--c" as string]: c }}>
      <i></i>
      {tag.name}
    </span>
  );
}

/* ---- Star (interactive) ---- */
function Star({ on, onClick, cls = "star", style }: { on: boolean; onClick: () => void; cls?: string; style?: React.CSSProperties }) {
  return (
    <button
      className={cls + (on ? " on" : "")}
      title={on ? "Remove from favorites" : "Mark as favorite"}
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name="star" size={16} fill={on} stroke={1.7} />
    </button>
  );
}

/* ---- Thumbnail tile (file-type icon + extension badge) ---- */
function TypeTile({ item, size = 40 }: { item: DriveFile; size?: number }) {
  const ft = fileTypeFor(item);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: `color-mix(in oklab, ${ft.tint} 9%, var(--card-2))`,
        display: "grid",
        placeItems: "center",
      }}
    >
      <Icon name={ft.icon} size={size} stroke={1.5} style={{ color: ft.tint }} />
      {ft.badge && (
        <span className="type-badge" style={{ ["--c" as string]: ft.tint }}>
          {ft.badge}
        </span>
      )}
    </div>
  );
}

export interface ItemProps {
  item: DriveFile;
  tags?: Tag[];
  tagMap?: Map<number, Tag>;
  onStar: (item: DriveFile) => void;
  onMenu: (item: DriveFile, anchor: HTMLElement) => void;
  /** Activation: open the item (double-click / Enter). */
  onOpen: (item: DriveFile) => void;
  /** Selection: single-click / Space (honours Ctrl/Meta toggle + Shift range). */
  onSelect?: (item: DriveFile, e: React.MouseEvent | React.KeyboardEvent) => void;
  /** Open the detail popup (Alt+Enter). */
  onDetail?: (item: DriveFile) => void;
  /** >1 when multiple archive versions are grouped into one card. */
  versionCount?: number;
  /** Clicking the "N versions" badge → show all versions in this family. */
  onPickFamily?: (family: string) => void;
  selected?: boolean;
  focused?: boolean;
  onSelectToggle?: (item: DriveFile, e: React.MouseEvent) => void;
  /** Append the file extension to the displayed name ("File name extensions" toggle). */
  showExtensions?: boolean;
  /** Show per-card detail items (size/date/tags). Off = name only. */
  showDetails?: boolean;
}

export interface FolderProps {
  folder: Folder;
  onOpen: (id: number) => void;
  onMenu: (folder: Folder, anchor: HTMLElement) => void;
  /** Selection: single-click / Space (honours Ctrl/Meta toggle + Shift range). */
  onSelect?: (folder: Folder, e: React.MouseEvent | React.KeyboardEvent) => void;
  /** Open the folder's details popup (Alt+Enter). */
  onDetail?: (folder: Folder) => void;
  onSelectToggle?: (folder: Folder, e: React.MouseEvent) => void;
  selected?: boolean;
  focused?: boolean;
  itemCount?: number;
  subfolderCount?: number;
}

function areFolderPropsEqual(prev: FolderProps, next: FolderProps): boolean {
  return (
    prev.folder === next.folder &&
    prev.selected === next.selected &&
    prev.focused === next.focused &&
    prev.itemCount === next.itemCount &&
    prev.subfolderCount === next.subfolderCount
  );
}

function areItemPropsEqual(prev: ItemProps, next: ItemProps): boolean {
  return (
    prev.item === next.item &&
    prev.selected === next.selected &&
    prev.focused === next.focused &&
    prev.versionCount === next.versionCount &&
    prev.showExtensions === next.showExtensions &&
    prev.showDetails === next.showDetails &&
    prev.tags === next.tags &&
    prev.tagMap === next.tagMap
  );
}

/* ---- Selection-on-click / activation-on-double-click wiring ----
   Single click (or Space) selects; double-click (or Enter) activates/opens. Native
   onClick + onDoubleClick keep the two cleanly separated — no manual timer that could
   fire a premature single-click — and roving tabIndex keeps each item keyboard-focusable
   without trapping the user in a Tab loop.
   `data-key` (`i:<id>` for items, `f:<id>` for folders) lets DriveApp's arrow-key
   handler map focused DOM nodes back to the right entry — files and folders share one
   selection model. Inner buttons (kebab/star/checkbox) stopPropagation so they never
   bubble up here. */
function activation(
  item: DriveFile,
  onSelect: ItemProps["onSelect"],
  onOpen: ItemProps["onOpen"],
  onDetail: ItemProps["onDetail"],
  focused?: boolean
) {
  return {
    tabIndex: focused ? 0 : -1,
    role: "button" as const,
    "data-key": `i:${item.id}`,
    // stopPropagation so the click doesn't bubble to the content background (which
    // clears the selection on empty-area clicks).
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect?.(item, e);
    },
    onDoubleClick: () => onOpen(item),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // Alt+Enter → details popup (Windows "Properties"); plain Enter → open.
        if (e.altKey) onDetail?.(item);
        else onOpen(item);
      } else if (e.key === " ") {
        e.preventDefault();
        onSelect?.(item, e);
      }
    },
  };
}

/* ---- Folder activation: mirrors `activation` so folders behave like files — single
   click (or Space) selects (Ctrl/Shift honoured by DriveApp), double-click (or Enter)
   opens/enters the folder, Alt+Enter opens its details popup. ---- */
function folderActivation(
  folder: Folder,
  onSelect: FolderProps["onSelect"],
  onOpen: (id: number) => void,
  onDetail: FolderProps["onDetail"],
  focused?: boolean
) {
  return {
    tabIndex: focused ? 0 : -1,
    role: "button" as const,
    "data-key": `f:${folder.id}`,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect?.(folder, e);
    },
    onDoubleClick: () => onOpen(folder.id),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.altKey) onDetail?.(folder);
        else onOpen(folder.id);
      } else if (e.key === " ") {
        e.preventDefault();
        onSelect?.(folder, e);
      }
    },
  };
}


/** Compact "3 folders · 12 items" summary line for a folder (or "Empty folder"). */
function folderMeta(itemCount?: number, subfolderCount?: number): string {
  const i = itemCount ?? 0;
  const s = subfolderCount ?? 0;
  if (!i && !s) return "Empty folder";
  const parts: string[] = [];
  if (s) parts.push(`${s} folder${s > 1 ? "s" : ""}`);
  if (i) parts.push(`${i} item${i > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

/** Version badge (e.g. "v0.6.0" or "1080p") + optional "N versions / N qualities" button. */
function VersionBadge({
  item,
  versionCount,
  onPickFamily,
}: Pick<ItemProps, "item" | "versionCount" | "onPickFamily">) {
  if (!item.version) return null;
  const more = (versionCount ?? 1) > 1;
  const isMedia = item.kind === "media";
  const unit = isMedia ? "qualities" : "versions";
  return (
    <span className="verwrap">
      <span className="ver">{item.version}</span>
      {more && onPickFamily && (
        <button
          className="vermore"
          title={isMedia ? "Show all qualities" : "Show all versions"}
          onClick={(e) => {
            e.stopPropagation();
            onPickFamily(item.family);
          }}
        >
          {versionCount} {unit}
        </button>
      )}
    </span>
  );
}

/* ============================================================ Folder Card */
function FolderCardComponent({
  folder,
  onOpen,
  onMenu,
  onSelect,
  onDetail,
  selected = false,
  focused = false,
  itemCount,
  subfolderCount,
}: FolderProps) {
  return (
    <div className={`card folder ${selected ? "sel" : ""}`} {...folderActivation(folder, onSelect, onOpen, onDetail, focused)}>
      <div className="folder-ico">
        <Icon name="folder" size={20} stroke={1.6} />
      </div>
      <div className="folder-info">
        <div className="fname" title={folder.name}>
          {folder.name}
        </div>
        <div className="meta">{folderMeta(itemCount, subfolderCount)}</div>
      </div>
      <button
        className="folder-kebab"
        title="Actions"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(folder, e.currentTarget);
        }}
      >
        <Icon name="kebab" size={15} />
      </button>
    </div>
  );
}
export const FolderCard = memo(FolderCardComponent, areFolderPropsEqual);

/* ============================================================ File Folder Card */
function FileFolderCardComponent({
  item,
  onMenu,
  onOpen,
  onSelect,
  onDetail,
  selected = false,
  focused = false,
  showExtensions = false,
}: ItemProps) {
  const ft = fileTypeFor(item);
  return (
    <div
      className={`card folder ${selected ? "sel" : ""}`}
      {...activation(item, onSelect, onOpen, onDetail, focused)}
    >
      <div
        className="folder-ico"
        style={{
          color: ft.tint,
          background: `color-mix(in oklab, ${ft.tint} 12%, var(--card-2))`,
        }}
      >
        <Icon name={ft.icon} size={20} stroke={1.6} />
      </div>
      <div className="folder-info">
        <div className="fname" title={item.name}>
          {displayName(item, showExtensions)}
        </div>
        <div className="meta">
          {fmtSize(item.size)} · <ClientText render={() => fmtDate(item.modified)} />
        </div>
      </div>
      <button
        className="folder-kebab"
        title="Actions"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(item, e.currentTarget);
        }}
      >
        <Icon name="kebab" size={15} />
      </button>
    </div>
  );
}
export const FileFolderCard = memo(FileFolderCardComponent, areItemPropsEqual);


/* ============================================================ Folder Row */
function FolderRowComponent({
  folder,
  onOpen,
  onMenu,
  onSelect,
  onDetail,
  selected = false,
  focused = false,
  onSelectToggle,
  itemCount,
  subfolderCount,
}: FolderProps) {
  return (
    <div className={`row ${selected ? "sel" : ""}`} {...folderActivation(folder, onSelect, onOpen, onDetail, focused)}>
      <div className="rname">
        {onSelectToggle && (
          <button
            className={`row-check ${selected ? "on" : ""}`}
            style={{ border: 0, background: "none", display: "grid", placeItems: "center", cursor: "pointer", padding: 0 }}
            onClick={(e) => {
              e.stopPropagation();
              onSelectToggle(folder, e);
            }}
          >
            <Icon name={selected ? "check" : "circle"} size={16} fill={selected} stroke={1.5} />
          </button>
        )}
        <div
          className="ico-wrap"
          style={{ background: "color-mix(in oklab, var(--accent) 12%, var(--card-2))" }}
        >
          <Icon name="folder" size={19} stroke={1.5} style={{ color: "var(--accent)" }} />
        </div>
        <div className="txt">
          <div className="t" title={folder.name}>
            {folder.name}
          </div>
        </div>
      </div>
      <div className="col c-mod">—</div>
      <div className="col c-size">{folderMeta(itemCount, subfolderCount)}</div>
      <div className="col c-kind hide-mob">Folder</div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 2 }}>
        <button
          className="rstar rkebab"
          onClick={(e) => {
            e.stopPropagation();
            onMenu(folder, e.currentTarget);
          }}
        >
          <Icon name="kebab" size={15} />
        </button>
      </div>
    </div>
  );
}
export const FolderRow = memo(FolderRowComponent, areFolderPropsEqual);

/* ============================================================ Grid card */
function FileCardComponent({
  item,
  tags,
  tagMap,
  onStar,
  onMenu,
  onOpen,
  onSelect,
  onDetail,
  versionCount,
  onPickFamily,
  selected = false,
  focused = false,
  onSelectToggle,
  showExtensions = false,
  showDetails = true,
}: ItemProps) {
  const itemTags = tagMap
    ? (item.tags.map((id) => tagMap.get(id)).filter(Boolean) as Tag[])
    : (item.tags.map((id) => tags?.find((t) => t.id === id)).filter(Boolean) as Tag[]);
  return (
    <div className={`card ${selected ? "sel" : ""}`} {...activation(item, onSelect, onOpen, onDetail, focused)}>
      <div style={{ position: "relative" }}>
        {/* Thumb fit comes from CSS (`contain` — nothing cropped), not from an inline `objectFit`,
            which would override it in every layout. */}
        <div className="thumb">
          {item.thumb ? (
            <Image src={item.thumb!} alt="" fill unoptimized />
          ) : (
            <TypeTile item={item} size={40} />
          )}
        </div>
        {item.thumb && fileTypeFor(item).preview === "video" && (
          <span className="video-thumb-play-overlay">
            <Icon name="playSimple" />
          </span>
        )}
      </div>

      {onSelectToggle && (
        <button
          className={`card-check ${selected ? "on" : ""}`}
          title={selected ? "Deselect" : "Select"}
          onClick={(e) => {
            e.stopPropagation();
            onSelectToggle(item, e);
          }}
        >
          <Icon name={selected ? "check" : "circle"} size={16} fill={selected} stroke={1.5} />
        </button>
      )}

      <button
        className="kebab"
        title="Actions"
        style={{ left: "auto", right: "9px" }}
        onClick={(e) => {
          e.stopPropagation();
          onMenu(item, e.currentTarget);
        }}
      >
        <Icon name="kebab" size={15} />
      </button>
      {!item.trashed && (
        <Star
          on={item.starred}
          onClick={() => onStar(item)}
          style={{ right: "42px" }}
        />
      )}

      <div className="fname" title={item.name}>
        {displayName(item, showExtensions)}
      </div>
      {showDetails && (
        <div className="meta">
          {item.trashed && item.deletedAt != null ? (
            <ClientText render={() => `Permanently deleted in ${trashDaysLeft(item.deletedAt!)} days`} />
          ) : (
            <>
              {`${fmtSize(item.size)}${item.parts > 1 ? ` · ${item.parts} parts` : ""} · `}
              <ClientText render={() => fmtDate(item.modified)} />
            </>
          )}
        </div>
      )}
      <VersionBadge item={item} versionCount={versionCount} onPickFamily={onPickFamily} />
      {showDetails && itemTags.length > 0 && (
        <div className="tagline">
          {itemTags.slice(0, 2).map((t) => (
            <Chip key={t.id} tag={t} />
          ))}
          {itemTags.length > 2 && (
            <span className="chip" style={{ ["--c" as string]: "#9a948a" }}>
              +{itemTags.length - 2}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
export const FileCard = memo(FileCardComponent, areItemPropsEqual);

/* ============================================================ List row */
function FileRowComponent({
  item,
  tags,
  tagMap,
  onStar,
  onMenu,
  onOpen,
  onSelect,
  onDetail,
  versionCount,
  onPickFamily,
  selected = false,
  focused = false,
  onSelectToggle,
  showExtensions = false,
  showDetails = true,
}: ItemProps) {
  const ft = fileTypeFor(item);
  const itemTags = tagMap
    ? (item.tags.map((id) => tagMap.get(id)).filter(Boolean) as Tag[])
    : (item.tags.map((id) => tags?.find((t) => t.id === id)).filter(Boolean) as Tag[]);
  return (
    <div className={`row ${selected ? "sel" : ""}`} {...activation(item, onSelect, onOpen, onDetail, focused)}>
      <div className="rname">
        {onSelectToggle && (
          <button
            className={`row-check ${selected ? "on" : ""}`}
            style={{ border: 0, background: "none", display: "grid", placeItems: "center", cursor: "pointer", padding: 0 }}
            onClick={(e) => {
              e.stopPropagation();
              onSelectToggle(item, e);
            }}
          >
            <Icon name={selected ? "check" : "circle"} size={16} fill={selected} stroke={1.5} />
          </button>
        )}
        <div style={{ position: "relative", flex: "none" }}>
          <div
            className="ico-wrap"
            style={item.thumb ? { position: "relative", overflow: "hidden" } : { background: `color-mix(in oklab, ${ft.tint} 12%, var(--card-2))` }}
          >
            {item.thumb ? (
              <Image src={item.thumb} alt="" fill unoptimized style={{ objectFit: "cover" }} />
            ) : (
              <Icon name={ft.icon} size={19} stroke={1.5} style={{ color: ft.tint }} />
            )}
          </div>
          {item.thumb && ft.preview === "video" && (
            <span className="video-thumb-play-overlay">
              <Icon name="playSimple" />
            </span>
          )}
        </div>
        <div className="txt">
          <div className="t" title={item.name}>
            {displayName(item, showExtensions)}
            {item.version && <span className="ver" style={{ marginLeft: 8 }}>{item.version}</span>}
            {(versionCount ?? 1) > 1 && onPickFamily && (
              <button
                className="vermore"
                style={{ marginLeft: 6 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onPickFamily(item.family);
                }}
              >
                {versionCount} versions
              </button>
            )}
          </div>
          {showDetails && itemTags.length > 0 && (
            <div className="tags">
              {itemTags.slice(0, 3).map((t) => (
                <Chip key={t.id} tag={t} />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="col c-mod">
        <ClientText
          render={() =>
            item.trashed && item.deletedAt != null
              ? `${trashDaysLeft(item.deletedAt)} days left`
              : fmtDate(item.modified)
          }
        />
      </div>
      <div className="col c-size">{fmtSize(item.size)}</div>
      <div className="col c-kind hide-mob">{ft.label}</div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 2 }}>
        {!item.trashed && <Star on={item.starred} onClick={() => onStar(item)} cls="rstar" />}
        <button
          className="rstar rkebab"
          onClick={(e) => {
            e.stopPropagation();
            onMenu(item, e.currentTarget);
          }}
        >
          <Icon name="kebab" size={15} />
        </button>
      </div>
    </div>
  );
}
export const FileRow = memo(FileRowComponent, areItemPropsEqual);

/* ============================================================ Shared bits */
/** Star + kebab cluster used by the tile/content layouts. */
function RowActions({
  item,
  onStar,
  onMenu,
}: Pick<ItemProps, "item" | "onStar" | "onMenu">) {
  return (
    <div className="ract">
      {!item.trashed && <Star on={item.starred} onClick={() => onStar(item)} cls="rstar" />}
      <button
        className="rstar rkebab"
        title="Actions"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(item, e.currentTarget);
        }}
      >
        <Icon name="kebab" size={15} />
      </button>
    </div>
  );
}

function SelectCheck({
  item,
  selected,
  onSelectToggle,
  cls,
}: Pick<ItemProps, "item" | "selected" | "onSelectToggle"> & { cls: string }) {
  if (!onSelectToggle) return null;
  return (
    <button
      className={`${cls} ${selected ? "on" : ""}`}
      title={selected ? "Deselect" : "Select"}
      onClick={(e) => {
        e.stopPropagation();
        onSelectToggle(item, e);
      }}
    >
      <Icon name={selected ? "check" : "circle"} size={16} fill={selected} stroke={1.5} />
    </button>
  );
}

/* ============================================================ Tile (horizontal) */
function FileTileComponent({
  item,
  tags,
  tagMap,
  onStar,
  onMenu,
  onOpen,
  onSelect,
  onDetail,
  selected = false,
  focused = false,
  onSelectToggle,
  showExtensions = false,
  showDetails = true,
}: ItemProps) {
  const ft = fileTypeFor(item);
  const itemTags = tagMap
    ? (item.tags.map((id) => tagMap.get(id)).filter(Boolean) as Tag[])
    : (item.tags.map((id) => tags?.find((t) => t.id === id)).filter(Boolean) as Tag[]);
  return (
    <div className={`tile ${selected ? "sel" : ""}`} {...activation(item, onSelect, onOpen, onDetail, focused)}>
      <div style={{ position: "relative", flex: "none" }}>
        <div className="tile-thumb" style={{ background: `color-mix(in oklab, ${ft.tint} 10%, var(--card-2))` }}>
          {item.thumb ? (
            <Image src={item.thumb} alt="" fill unoptimized style={{ objectFit: "cover" }} />
          ) : (
            <Icon name={ft.icon} size={26} stroke={1.5} style={{ color: ft.tint }} />
          )}
        </div>
        {item.thumb && ft.preview === "video" && (
          <span className="video-thumb-play-overlay">
            <Icon name="playSimple" />
          </span>
        )}
      </div>
      <div className="tile-info">
        <div className="fname" title={item.name}>
          {displayName(item, showExtensions)}
        </div>
        {showDetails && (
          <div className="meta">
            {ft.label}
            {item.size ? ` · ${fmtSize(item.size)}` : ""}
            {item.version ? ` · ${item.version}` : ""}
          </div>
        )}
        {showDetails && itemTags.length > 0 && (
          <div className="tags">
            {itemTags.slice(0, 2).map((t) => (
              <Chip key={t.id} tag={t} />
            ))}
          </div>
        )}
      </div>
      <SelectCheck item={item} selected={selected} onSelectToggle={onSelectToggle} cls="tile-check" />
      <RowActions item={item} onStar={onStar} onMenu={onMenu} />
    </div>
  );
}
export const FileTile = memo(FileTileComponent, areItemPropsEqual);

/* ============================================================ Content (wide row) */
function FileContentComponent({
  item,
  tags,
  tagMap,
  onStar,
  onMenu,
  onOpen,
  onSelect,
  onDetail,
  versionCount,
  onPickFamily,
  selected = false,
  focused = false,
  onSelectToggle,
  showExtensions = false,
  showDetails = true,
}: ItemProps) {
  const ft = fileTypeFor(item);
  const itemTags = tagMap
    ? (item.tags.map((id) => tagMap.get(id)).filter(Boolean) as Tag[])
    : (item.tags.map((id) => tags?.find((t) => t.id === id)).filter(Boolean) as Tag[]);
  return (
    <div className={`crow ${selected ? "sel" : ""}`} {...activation(item, onSelect, onOpen, onDetail, focused)}>
      <SelectCheck item={item} selected={selected} onSelectToggle={onSelectToggle} cls="crow-check" />
      <div style={{ position: "relative", flex: "none" }}>
        <div className="crow-thumb">
          {item.thumb ? (
            <Image src={item.thumb} alt="" fill unoptimized style={{ objectFit: "cover" }} />
          ) : (
            <div className="crow-ico" style={{ background: `color-mix(in oklab, ${ft.tint} 12%, var(--card-2))` }}>
              <Icon name={ft.icon} size={26} stroke={1.5} style={{ color: ft.tint }} />
            </div>
          )}
        </div>
        {item.thumb && ft.preview === "video" && (
          <span className="video-thumb-play-overlay">
            <Icon name="playSimple" />
          </span>
        )}
      </div>
      <div className="crow-main">
        <div className="fname" title={item.name}>
          {displayName(item, showExtensions)}
          {item.version && <span className="ver" style={{ marginLeft: 8 }}>{item.version}</span>}
          {(versionCount ?? 1) > 1 && onPickFamily && (
            <button
              className="vermore"
              style={{ marginLeft: 6 }}
              onClick={(e) => {
                e.stopPropagation();
                onPickFamily(item.family);
              }}
            >
              {versionCount} versions
            </button>
          )}
        </div>
        {showDetails && (
          <div className="meta">
            {ft.label} · {fmtSize(item.size)}
            {item.parts > 1 ? ` · ${item.parts} parts` : ""} ·{" "}
            <ClientText render={() => fmtDate(item.modified)} />
          </div>
        )}
        {showDetails && itemTags.length > 0 && (
          <div className="tags">
            {itemTags.slice(0, 4).map((t) => (
              <Chip key={t.id} tag={t} />
            ))}
          </div>
        )}
      </div>
      <RowActions item={item} onStar={onStar} onMenu={onMenu} />
    </div>
  );
}
export const FileContent = memo(FileContentComponent, areItemPropsEqual);

/* ============================================================ List (compact, column-flow) */
function FileListItemComponent({
  item,
  onMenu,
  onOpen,
  onSelect,
  onDetail,
  selected = false,
  focused = false,
  onSelectToggle,
  showExtensions = false,
}: ItemProps) {
  const ft = fileTypeFor(item);
  return (
    <div className={`litem ${selected ? "sel" : ""}`} {...activation(item, onSelect, onOpen, onDetail, focused)}>
      <SelectCheck item={item} selected={selected} onSelectToggle={onSelectToggle} cls="litem-check" />
      {item.thumb ? (
        <span className="litem-ico" style={{ position: "relative", width: 20, height: 20, borderRadius: 4, overflow: "hidden", display: "inline-block", flex: "none" }}>
          <Image src={item.thumb} alt="" fill unoptimized style={{ objectFit: "cover" }} />
        </span>
      ) : (
        <Icon name={ft.icon} size={18} stroke={1.5} className="litem-ico" style={{ color: ft.tint }} />
      )}
      <span className="litem-name" title={item.name}>
        {displayName(item, showExtensions)}
      </span>
      <button
        className="litem-kebab"
        title="Actions"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(item, e.currentTarget);
        }}
      >
        <Icon name="kebab" size={14} />
      </button>
    </div>
  );
}
export const FileListItem = memo(FileListItemComponent, areItemPropsEqual);

/* ============================================================ Dropdown menu */
export function Menu({
  anchor,
  onClose,
  children,
  align = "left",
  width,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right";
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  // Type-ahead buffer inside the menu (600ms timeout)
  const typeAheadBufferRef = useRef("");
  const typeAheadTimeRef = useRef(0);

  const getItems = () =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>(".menu-item:not([disabled])") || []).filter(
      (el) => el.offsetParent !== null
    );

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const el = ref.current;
    const mw = el ? el.offsetWidth : width || 200;
    const mh = el ? el.offsetHeight : 200;
    let left = align === "right" ? r.right - mw : r.left;
    let top = r.bottom + 6;
    if (left + mw > window.innerWidth - 10) left = window.innerWidth - mw - 10;
    if (left < 10) left = 10;
    if (top + mh > window.innerHeight - 10) top = Math.max(10, r.top - mh - 6);
    setPos({ left, top });
  }, [anchor, align, width]);

  // Auto-focus on open: prioritize the active checked item (e.g. current sort/group/layout), otherwise the first item
  useEffect(() => {
    const timer = setTimeout(() => {
      const items = getItems();
      if (!items.length) return;
      const checked = items.find((el) => el.querySelector(".check") != null || el.getAttribute("aria-checked") === "true");
      const target = checked || items[0];
      target.focus({ preventScroll: true });
    }, 20);
    return () => clearTimeout(timer);
  }, []);

  // Restore focus to anchor on dismiss
  useEffect(() => {
    return () => {
      if (anchorRef.current && document.contains(anchorRef.current)) {
        anchorRef.current.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "Tab") {
        onClose();
        return;
      }

      const items = getItems();
      if (!items.length) return;

      const activeEl = document.activeElement as HTMLElement | null;
      const curIdx = activeEl ? items.indexOf(activeEl) : -1;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % items.length;
        items[nextIdx]?.focus({ preventScroll: true });
        items[nextIdx]?.scrollIntoView({ block: "nearest" });
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevIdx = curIdx <= 0 ? items.length - 1 : curIdx - 1;
        items[prevIdx]?.focus({ preventScroll: true });
        items[prevIdx]?.scrollIntoView({ block: "nearest" });
        return;
      }

      if (e.key === "Home") {
        e.preventDefault();
        items[0]?.focus({ preventScroll: true });
        items[0]?.scrollIntoView({ block: "nearest" });
        return;
      }

      if (e.key === "End") {
        e.preventDefault();
        items[items.length - 1]?.focus({ preventScroll: true });
        items[items.length - 1]?.scrollIntoView({ block: "nearest" });
        return;
      }

      // Submenu handling
      if (e.key === "ArrowRight") {
        if (activeEl?.classList.contains("has-sub")) {
          const subItem = activeEl.querySelector<HTMLElement>(".submenu .menu-item");
          if (subItem) {
            e.preventDefault();
            subItem.focus({ preventScroll: true });
            return;
          }
        }
      }

      if (e.key === "ArrowLeft") {
        const parentSub = activeEl?.closest(".submenu")?.closest<HTMLElement>(".has-sub");
        if (parentSub) {
          e.preventDefault();
          parentSub.focus({ preventScroll: true });
          return;
        }
      }

      // Type-ahead jump navigation inside menu (a-z, 0-9)
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && /^[a-z0-9]$/i.test(e.key)) {
        const char = e.key.toLowerCase();
        const now = Date.now();
        const isConsecutive = now - typeAheadTimeRef.current < 600;
        typeAheadTimeRef.current = now;

        const isCycle =
          isConsecutive &&
          typeAheadBufferRef.current.length > 0 &&
          typeAheadBufferRef.current.split("").every((c) => c === char);
        const query = isCycle ? char : isConsecutive ? typeAheadBufferRef.current + char : char;
        typeAheadBufferRef.current = query;

        const getItemText = (el: HTMLElement) => el.innerText.trim().toLowerCase();

        let target: HTMLElement | null = null;
        if (isCycle && curIdx >= 0) {
          for (let i = 1; i <= items.length; i++) {
            const idx = (curIdx + i) % items.length;
            if (getItemText(items[idx]).startsWith(char)) {
              target = items[idx];
              break;
            }
          }
        } else {
          target = items.find((el) => getItemText(el).startsWith(query)) ?? null;
        }

        if (target) {
          e.preventDefault();
          target.focus({ preventScroll: true });
          target.scrollIntoView({ block: "nearest" });
        }
      }
    };

    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="menu"
      ref={ref}
      role="menu"
      tabIndex={-1}
      style={{ ...(pos || { left: -9999, top: -9999 }), minWidth: width }}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  onClick,
  danger,
  check,
  shortcut,
}: {
  icon?: string;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  check?: boolean;
  shortcut?: string;
}) {
  return (
    <button
      className={"menu-item" + (danger ? " danger" : "")}
      role={check !== undefined ? "menuitemcheckbox" : "menuitem"}
      aria-checked={check}
      tabIndex={-1}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(e);
      }}
    >
      {icon && <Icon name={icon} size={17} className="ico" />}
      <span>{label}</span>
      {shortcut && <kbd className="menu-kbd">{shortcut}</kbd>}
      {check && <Icon name="check" size={16} className="check" stroke={2} />}
    </button>
  );
}

/** Menu row that expands a side flyout on hover/focus (Windows-Explorer "Group by ›"). */
export function SubMenuItem({
  icon,
  label,
  children,
}: {
  icon?: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="menu-item has-sub" tabIndex={-1} role="menuitem" aria-haspopup="menu">
      {icon && <Icon name={icon} size={17} className="ico" />}
      <span>{label}</span>
      <Icon name="chevright" size={15} className="sub-caret" />
      <div className="submenu" role="menu">
        {children}
      </div>
    </div>
  );
}
