"use client";

import { useState } from "react";
import Image from "next/image";
import { Icon } from "@/lib/icons";
import { TAG_COLORS } from "@/lib/kinds";
import type { Tag } from "@/lib/types";
import { logout } from "@/app/login/actions";
import { TagLegend } from "./TagLegend";

export interface Counts {
  all: number;
  recent: number;
  starred: number;
  trash: number;
  tags: Record<number, number>;
}

export interface Storage {
  usedLabel: { num: string; unit: string };
  capLabel: string;
  segments: { label: string; color: string; pct: number; sizeLabel: string }[];
  legend: { label: string; color: string }[];
}

const NAVS = [
  { id: "all", icon: "all", label: "All files" },
  { id: "recent", icon: "recent", label: "Recent" },
  { id: "starred", icon: "star", label: "Favorites" },
  { id: "trash", icon: "trash", label: "Trash" },
] as const;

export function Sidebar({
  view,
  tag,
  counts,
  tags,
  storage,
  onNav,
  onTag,
  onManageTags,
}: {
  view: string;
  tag: number | null;
  counts: Counts;
  tags: Tag[];
  storage: Storage;
  onNav: (v: string) => void;
  onTag: (id: number) => void;
  onManageTags: () => void;
}) {
  const [mediaOpen, setMediaOpen] = useState(true);
  const [showMoreTags, setShowMoreTags] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);

  // Type tags get their own collapsible group (kept in a fixed, intuitive order).
  const SPECIAL_ORDER = ["image", "video", "archive"];
  const isSpecialTag = (name: string) => SPECIAL_ORDER.includes(name.toLowerCase());
  const mediaTags = tags
    .filter((t) => isSpecialTag(t.name))
    .sort(
      (a, b) => SPECIAL_ORDER.indexOf(a.name.toLowerCase()) - SPECIAL_ORDER.indexOf(b.name.toLowerCase())
    );
  const regularTags = tags.filter((t) => !isSpecialTag(t.name));

  // Sort regular tags by usage count (descending) — most-used first.
  const sortedRegularTags = [...regularTags]
    .sort((a, b) => (counts.tags[b.id] || 0) - (counts.tags[a.id] || 0));

  const topRegularTags = sortedRegularTags.slice(0, 5);
  const remainingTags = sortedRegularTags.slice(5);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Image src="/logo.png" alt="logo" width={52} height={33} unoptimized style={{ display: "block" }} />
        </div>
        <div>
          <div className="brand-name">Vault</div>
          <div className="brand-sub">Telegram Drive</div>
        </div>
      </div>

      <div className="side-scroll scroll">
        <div className="nav-group">
          {NAVS.map((n) => (
            <button
              key={n.id}
              className={"nav-item" + (view === n.id ? " active" : "")}
              onClick={() => onNav(n.id)}
            >
              <Icon
                name={n.icon}
                size={18}
                className="ico"
                fill={n.id === "starred" && view === n.id}
              />
              <span>{n.label}</span>
              {counts[n.id] > 0 && <span className="count">{counts[n.id]}</span>}
            </button>
          ))}
          <a className="nav-item link" href="/upload">
            <Icon name="upload" size={18} className="ico" />
            <span>Upload files</span>
          </a>
        </div>

        <div className="nav-group">
          <div className="nav-label">
            <span>Tags</span>
            <button onClick={onManageTags} title="Manage categories">
              <Icon name="plus" size={15} />
            </button>
          </div>
          {topRegularTags.map((t) => {
            const c = TAG_COLORS[t.color] || t.color;
            return (
              <button
                key={t.id}
                className={"nav-item tag-row" + (view === "tag" && tag === t.id ? " active" : "")}
                onClick={() => onTag(t.id)}
              >
                <span className="tag-dot" style={{ background: c }}></span>
                <span className="name">{t.name}</span>
                {counts.tags[t.id] > 0 && <span className="count">{counts.tags[t.id]}</span>}
              </button>
            );
          })}

          {showMoreTags && remainingTags.map((t) => {
            const c = TAG_COLORS[t.color] || t.color;
            return (
              <button
                key={t.id}
                className={"nav-item tag-row" + (view === "tag" && tag === t.id ? " active" : "")}
                onClick={() => onTag(t.id)}
              >
                <span className="tag-dot" style={{ background: c }}></span>
                <span className="name">{t.name}</span>
                {counts.tags[t.id] > 0 && <span className="count">{counts.tags[t.id]}</span>}
              </button>
            );
          })}

          {remainingTags.length > 0 && (
            <button
              className="nav-item"
              style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", color: "var(--muted)", fontSize: "13px" }}
              onClick={() => setShowMoreTags(!showMoreTags)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <Icon name={showMoreTags ? "chevdown" : "chevright"} size={14} style={{ opacity: 0.7 }} />
                <span>{showMoreTags ? "Show less" : `Show more (${remainingTags.length})`}</span>
              </div>
            </button>
          )}

          {mediaTags.length > 0 && (
            <>
              <button
                className="nav-item"
                style={{ cursor: "pointer", display: "flex", justifyContent: "space-between" }}
                onClick={() => setMediaOpen(!mediaOpen)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <Icon name="video" size={18} className="ico" />
                  <span>Type Tags</span>
                </div>
                <Icon
                  name="chevdown"
                  size={14}
                  style={{
                    transform: mediaOpen ? "none" : "rotate(-90deg)",
                    transition: "transform 0.2s",
                    opacity: 0.7,
                  }}
                />
              </button>
              {mediaOpen && (
                <div className="sub-list" style={{ paddingLeft: 12 }}>
                  {mediaTags.map((t) => {
                    const c = TAG_COLORS[t.color] || t.color;
                    return (
                      <button
                        key={t.id}
                        className={"nav-item tag-row" + (view === "tag" && tag === t.id ? " active" : "")}
                        onClick={() => onTag(t.id)}
                      >
                        <span className="tag-dot" style={{ background: c }}></span>
                        <span className="name">{t.name}</span>
                        {counts.tags[t.id] > 0 && <span className="count">{counts.tags[t.id]}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {tags.length === 0 && (
            <div style={{ padding: "6px 10px", fontSize: 12.5, color: "var(--faint)" }}>
              No tags yet.
            </div>
          )}
        </div>

        <div className="nav-group">
          <form action={logout}>
            <button type="submit" className="nav-item link" style={{ width: "100%" }}>
              <Icon name="power" size={18} className="ico" />
              <span>Sign out</span>
            </button>
          </form>
        </div>
      </div>

      <button
        className="storage"
        type="button"
        onClick={() => setStorageOpen(true)}
        title="View storage breakdown"
      >
        <div className="top">
          <div className="num">
            {storage.usedLabel.num}
            <small>{storage.usedLabel.unit}</small>
          </div>
          <div className="cap">on {storage.capLabel}</div>
        </div>
        <div className="meter">
          {storage.segments.map(
            (s, i) =>
              s.pct > 0.4 && (
                <span
                  key={i}
                  style={{ width: s.pct + "%", background: s.color }}
                  title={`${s.label}: ${s.sizeLabel}`}
                ></span>
              )
          )}
          <span style={{ flex: 1, background: "var(--line)" }}></span>
        </div>
        <TagLegend items={storage.legend} />
      </button>

      {storageOpen && <StorageDetail storage={storage} onClose={() => setStorageOpen(false)} />}
    </aside>
  );
}

function StorageDetail({ storage, onClose }: { storage: Storage; onClose: () => void }) {
  const segs = [...storage.segments].sort((a, b) => b.pct - a.pct);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog" style={{ maxWidth: 420 }}>
        <div className="dhead">
          <div>
            <h2>Storage</h2>
            <p className="sub">
              {storage.usedLabel.num} {storage.usedLabel.unit} used on {storage.capLabel}
            </p>
          </div>
          <button className="iconbtn ghost" onClick={onClose} title="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="dbody">
          <div className="meter" style={{ height: 10, marginBottom: 16 }}>
            {storage.segments.map(
              (s, i) =>
                s.pct > 0.4 && (
                  <span key={i} style={{ width: s.pct + "%", background: s.color }} title={s.label}></span>
                )
            )}
            <span style={{ flex: 1, background: "var(--line)" }}></span>
          </div>
          <div className="storage-detail">
            {segs.length === 0 && <div className="tagmgr-empty">No data yet.</div>}
            {segs.map((s, i) => (
              <div className="storage-detail-row" key={i}>
                <span className="sd-dot" style={{ background: s.color }}></span>
                <span className="sd-label">{s.label}</span>
                <span className="sd-size">{s.sizeLabel}</span>
                <span className="sd-pct">{s.pct < 0.1 ? "<0.1" : s.pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
        <div className="dfoot">
          <button className="btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
