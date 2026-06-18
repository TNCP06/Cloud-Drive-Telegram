"use client";

import { useState } from "react";
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

  const isMediaTag = (name: string) => name.toLowerCase() === "image" || name.toLowerCase() === "video";
  const mediaTags = tags.filter((t) => isMediaTag(t.name));
  const regularTags = tags.filter((t) => !isMediaTag(t.name));

  const sortedRegularTags = [...regularTags]
    .sort((a, b) => (counts.tags[b.id] || 0) - (counts.tags[a.id] || 0));

  const topRegularTags = sortedRegularTags.slice(0, 5)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  const remainingTags = sortedRegularTags.slice(5)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Icon name="cloud" size={17} stroke={1.7} />
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
                  <span>Media Tags</span>
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

      <div className="storage">
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
      </div>
    </aside>
  );
}
