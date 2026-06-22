"use client";

import Image from "next/image";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/lib/icons";
import { TAG_COLORS } from "@/lib/kinds";
import { fileTypeFor, displayName } from "@/lib/fileType";
import { fmtSize, fmtDate, trashDaysLeft } from "@/lib/format";
import type { DriveFile, Tag, Folder } from "@/lib/types";

/* ---- Client-only text (timestamps) ----
   Relative/localized timestamps (fmtDate/trashDaysLeft) depend on the viewer's
   clock + timezone, so the server (UTC on the VPS) and the browser render
   different strings → React hydration error #418. Render nothing on the server
   and first client paint (identical → no mismatch), then the real value after
   mount. */
function ClientText({ render }: { render: () => string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <span suppressHydrationWarning>{mounted ? render() : ""}</span>;
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

interface ItemProps {
  item: DriveFile;
  tags: Tag[];
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
  onSelectToggle?: (item: DriveFile, e: React.MouseEvent) => void;
  /** Append the file extension to the displayed name ("File name extensions" toggle). */
  showExtensions?: boolean;
  /** Show per-card detail items (size/date/tags). Off = name only. */
  showDetails?: boolean;
}

/* ---- Selection-on-click / activation-on-double-click wiring ----
   Single click (or Space) selects; double-click (or Enter) activates/opens. Native
   onClick + onDoubleClick keep the two cleanly separated — no manual timer that could
   fire a premature single-click — and tabIndex keeps each item keyboard-focusable.
   `data-key` (`i:<id>` for items, `f:<id>` for folders) lets DriveApp's arrow-key
   handler map focused DOM nodes back to the right entry — files and folders share one
   selection model. Inner buttons (kebab/star/checkbox) stopPropagation so they never
   bubble up here. */
function activation(
  item: DriveFile,
  onSelect: ItemProps["onSelect"],
  onOpen: ItemProps["onOpen"],
  onDetail: ItemProps["onDetail"]
) {
  return {
    tabIndex: 0,
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
  onDetail: FolderProps["onDetail"]
) {
  return {
    tabIndex: 0,
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

/* ---- Folder cell props (shared by FolderCard + FolderRow) ---- */
interface FolderProps {
  folder: Folder;
  onOpen: (id: number) => void;
  onMenu: (folder: Folder, anchor: HTMLElement) => void;
  /** Selection: single-click / Space (honours Ctrl/Meta toggle + Shift range). */
  onSelect?: (folder: Folder, e: React.MouseEvent | React.KeyboardEvent) => void;
  /** Open the folder's details popup (Alt+Enter). */
  onDetail?: (folder: Folder) => void;
  onSelectToggle?: (folder: Folder, e: React.MouseEvent) => void;
  selected?: boolean;
  /** Total items inside (recursive, excludes trashed). */
  itemCount?: number;
  /** Total sub-folders inside (recursive). */
  subfolderCount?: number;
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

/** Version badge (e.g. "v0.6.0") + optional "N versions" button. */
function VersionBadge({
  item,
  versionCount,
  onPickFamily,
}: Pick<ItemProps, "item" | "versionCount" | "onPickFamily">) {
  if (!item.version) return null;
  const more = (versionCount ?? 1) > 1;
  return (
    <span className="verwrap">
      <span className="ver">{item.version}</span>
      {more && onPickFamily && (
        <button
          className="vermore"
          title="Show all versions"
          onClick={(e) => {
            e.stopPropagation();
            onPickFamily(item.family);
          }}
        >
          {versionCount} versions
        </button>
      )}
    </span>
  );
}

/* ============================================================ Folder Card */
export function FolderCard({
  folder,
  onOpen,
  onMenu,
  onSelect,
  onDetail,
  selected = false,
  itemCount,
  subfolderCount,
}: FolderProps) {
  return (
    <div className={`card folder ${selected ? "sel" : ""}`} {...folderActivation(folder, onSelect, onOpen, onDetail)}>
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

/* ============================================================ Folder Row */
export function FolderRow({
  folder,
  onOpen,
  onMenu,
  onSelect,
  onDetail,
  selected = false,
  onSelectToggle,
  itemCount,
  subfolderCount,
}: FolderProps) {
  return (
    <div className={`row ${selected ? "sel" : ""}`} {...folderActivation(folder, onSelect, onOpen, onDetail)}>
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

/* ============================================================ Grid card */
export function FileCard({
  item,
  tags,
  onStar,
  onMenu,
  onOpen,
  onSelect,
  onDetail,
  versionCount,
  onPickFamily,
  selected = false,
  onSelectToggle,
  showExtensions = false,
  showDetails = true,
}: ItemProps) {
  const itemTags = item.tags.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[];
  return (
    <div className={`card ${selected ? "sel" : ""}`} {...activation(item, onSelect, onOpen, onDetail)}>
      <div className="thumb">
        {item.thumb ? (
          <Image src={item.thumb!} alt="" fill unoptimized style={{ objectFit: "cover" }} />
        ) : (
          <TypeTile item={item} size={40} />
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

/* ============================================================ List row */
export function FileRow({
  item,
  tags,
  onStar,
  onMenu,
  onOpen,
  onSelect,
  onDetail,
  versionCount,
  onPickFamily,
  selected = false,
  onSelectToggle,
  showExtensions = false,
}: ItemProps) {
  const ft = fileTypeFor(item);
  const itemTags = item.tags.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[];
  return (
    <div className={`row ${selected ? "sel" : ""}`} {...activation(item, onSelect, onOpen, onDetail)}>
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
        <div
          className="ico-wrap"
          style={{ background: `color-mix(in oklab, ${ft.tint} 12%, var(--card-2))` }}
        >
          <Icon name={ft.icon} size={19} stroke={1.5} style={{ color: ft.tint }} />
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
          {itemTags.length > 0 && (
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
export function FileTile({
  item,
  tags,
  onStar,
  onMenu,
  onOpen,
  onSelect,
  onDetail,
  selected = false,
  onSelectToggle,
  showExtensions = false,
  showDetails = true,
}: ItemProps) {
  const ft = fileTypeFor(item);
  const itemTags = item.tags.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[];
  return (
    <div className={`tile ${selected ? "sel" : ""}`} {...activation(item, onSelect, onOpen, onDetail)}>
      <div className="tile-thumb" style={{ background: `color-mix(in oklab, ${ft.tint} 10%, var(--card-2))` }}>
        {item.thumb ? (
          <Image src={item.thumb} alt="" fill unoptimized style={{ objectFit: "cover" }} />
        ) : (
          <Icon name={ft.icon} size={26} stroke={1.5} style={{ color: ft.tint }} />
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

/* ============================================================ Content (wide row) */
export function FileContent({
  item,
  tags,
  onStar,
  onMenu,
  onOpen,
  onSelect,
  onDetail,
  versionCount,
  onPickFamily,
  selected = false,
  onSelectToggle,
  showExtensions = false,
  showDetails = true,
}: ItemProps) {
  const ft = fileTypeFor(item);
  const itemTags = item.tags.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[];
  return (
    <div className={`crow ${selected ? "sel" : ""}`} {...activation(item, onSelect, onOpen, onDetail)}>
      <SelectCheck item={item} selected={selected} onSelectToggle={onSelectToggle} cls="crow-check" />
      <div className="crow-thumb">
        {item.thumb ? (
          <Image src={item.thumb} alt="" fill unoptimized style={{ objectFit: "cover" }} />
        ) : (
          <div className="crow-ico" style={{ background: `color-mix(in oklab, ${ft.tint} 12%, var(--card-2))` }}>
            <Icon name={ft.icon} size={26} stroke={1.5} style={{ color: ft.tint }} />
          </div>
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

/* ============================================================ List (compact, column-flow) */
export function FileListItem({
  item,
  onMenu,
  onOpen,
  onSelect,
  onDetail,
  selected = false,
  onSelectToggle,
  showExtensions = false,
}: ItemProps) {
  const ft = fileTypeFor(item);
  return (
    <div className={`litem ${selected ? "sel" : ""}`} {...activation(item, onSelect, onOpen, onDetail)}>
      <SelectCheck item={item} selected={selected} onSelectToggle={onSelectToggle} cls="litem-check" />
      <Icon name={ft.icon} size={18} stroke={1.5} className="litem-ico" style={{ color: ft.tint }} />
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

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
}: {
  icon?: string;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  check?: boolean;
}) {
  return (
    <button
      className={"menu-item" + (danger ? " danger" : "")}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(e);
      }}
    >
      {icon && <Icon name={icon} size={17} className="ico" />}
      <span>{label}</span>
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
    <div className="menu-item has-sub" tabIndex={0}>
      {icon && <Icon name={icon} size={17} className="ico" />}
      <span>{label}</span>
      <Icon name="chevright" size={15} className="sub-caret" />
      <div className="submenu" role="menu">
        {children}
      </div>
    </div>
  );
}
