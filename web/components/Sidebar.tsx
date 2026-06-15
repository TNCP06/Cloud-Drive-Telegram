"use client";

import { Icon } from "@/lib/icons";
import { TAG_COLORS } from "@/lib/kinds";
import type { Tag } from "@/lib/types";
import { logout } from "@/app/login/actions";

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
  { id: "all", icon: "all", label: "Semua file" },
  { id: "recent", icon: "recent", label: "Terbaru" },
  { id: "starred", icon: "star", label: "Favorit" },
  { id: "trash", icon: "trash", label: "Sampah" },
] as const;

export function Sidebar({
  view,
  tag,
  counts,
  tags,
  storage,
  onNav,
  onTag,
}: {
  view: string;
  tag: number | null;
  counts: Counts;
  tags: Tag[];
  storage: Storage;
  onNav: (v: string) => void;
  onTag: (id: number) => void;
}) {
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
            <span>Upload via laptop</span>
          </a>
        </div>

        <div className="nav-group">
          <div className="nav-label">
            <span>Kategori</span>
          </div>
          {tags.map((t) => {
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
          {tags.length === 0 && (
            <div style={{ padding: "6px 10px", fontSize: 12.5, color: "var(--faint)" }}>
              Belum ada kategori.
            </div>
          )}
        </div>

        <div className="nav-group">
          <form action={logout}>
            <button type="submit" className="nav-item link" style={{ width: "100%" }}>
              <Icon name="power" size={18} className="ico" />
              <span>Keluar</span>
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
          <div className="cap">di {storage.capLabel}</div>
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
        <div className="legend">
          {storage.legend.map((l) => (
            <span key={l.label}>
              <i style={{ background: l.color }}></i>
              {l.label}
            </span>
          ))}
        </div>
      </div>
    </aside>
  );
}
