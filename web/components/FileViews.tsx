"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/lib/icons";
import { KINDS, TAG_COLORS } from "@/lib/kinds";
import { fmtSize, fmtDate, trashDaysLeft } from "@/lib/format";
import type { DriveFile, Tag } from "@/lib/types";

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
function Star({ on, onClick, cls = "star" }: { on: boolean; onClick: () => void; cls?: string }) {
  return (
    <button
      className={cls + (on ? " on" : "")}
      title={on ? "Remove from favorites" : "Mark as favorite"}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name="star" size={16} fill={on} stroke={1.7} />
    </button>
  );
}

/* ---- Thumbnail tile (kind icon) ---- */
function TypeTile({ kind, size = 40 }: { kind: DriveFile["kind"]; size?: number }) {
  const meta = KINDS[kind];
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: `color-mix(in oklab, ${meta.tint} 9%, var(--card-2))`,
        display: "grid",
        placeItems: "center",
      }}
    >
      <Icon name={meta.icon} size={size} stroke={1.5} style={{ color: meta.tint }} />
    </div>
  );
}

interface ItemProps {
  item: DriveFile;
  tags: Tag[];
  onStar: (item: DriveFile) => void;
  onMenu: (item: DriveFile, anchor: HTMLElement) => void;
  onOpen: (item: DriveFile) => void;
  /** >1 when multiple game versions are grouped into one card. */
  versionCount?: number;
  /** Clicking the "N versions" badge → show all versions in this family. */
  onPickFamily?: (family: string) => void;
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

/* ============================================================ Grid card */
export function FileCard({ item, tags, onStar, onMenu, onOpen, versionCount, onPickFamily }: ItemProps) {
  const itemTags = item.tags.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[];
  return (
    <div className="card" onClick={() => onOpen(item)}>
      <button
        className="kebab"
        title="Actions"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(item, e.currentTarget);
        }}
      >
        <Icon name="kebab" size={15} />
      </button>
      {!item.trashed && <Star on={item.starred} onClick={() => onStar(item)} />}

      <div className="thumb">
        {item.thumb ? (
          <img src={item.thumb} alt="" loading="lazy" />
        ) : (
          <TypeTile kind={item.kind} size={40} />
        )}
      </div>
      <div className="fname" title={item.name}>
        {item.version ? item.family : item.name}
      </div>
      <div className="meta">
        {item.trashed && item.deletedAt != null
          ? `Permanently deleted in ${trashDaysLeft(item.deletedAt)} days`
          : `${fmtSize(item.size)}${item.parts > 1 ? ` · ${item.parts} parts` : ""} · ${fmtDate(item.modified)}`}
      </div>
      <VersionBadge item={item} versionCount={versionCount} onPickFamily={onPickFamily} />
      {itemTags.length > 0 && (
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
export function FileRow({ item, tags, onStar, onMenu, onOpen, versionCount, onPickFamily }: ItemProps) {
  const meta = KINDS[item.kind];
  const itemTags = item.tags.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[];
  return (
    <div className="row" onClick={() => onOpen(item)}>
      <div className="rname">
        <div
          className="ico-wrap"
          style={{ background: `color-mix(in oklab, ${meta.tint} 12%, var(--card-2))` }}
        >
          <Icon name={meta.icon} size={19} stroke={1.5} style={{ color: meta.tint }} />
        </div>
        <div className="txt">
          <div className="t" title={item.name}>
            {item.version ? item.family : item.name}
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
        {item.trashed && item.deletedAt != null
          ? `${trashDaysLeft(item.deletedAt)} days left`
          : fmtDate(item.modified)}
      </div>
      <div className="col c-size">{fmtSize(item.size)}</div>
      <div className="col c-kind hide-mob">{meta.label}</div>
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
  onClick: () => void;
  danger?: boolean;
  check?: boolean;
}) {
  return (
    <button className={"menu-item" + (danger ? " danger" : "")} onClick={onClick}>
      {icon && <Icon name={icon} size={17} className="ico" />}
      <span>{label}</span>
      {check && <Icon name="check" size={16} className="check" stroke={2} />}
    </button>
  );
}
