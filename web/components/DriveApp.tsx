"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Icon } from "@/lib/icons";
import { fmtSize, relGroup } from "@/lib/format";
import { STORAGE_GROUPS, TAG_COLORS } from "@/lib/kinds";
import type { DriveFile, Tag } from "@/lib/types";
import { Sidebar, type Counts, type Storage } from "./Sidebar";
import { FileCard, FileRow, Menu, MenuItem } from "./FileViews";
import { PreviewDrawer } from "./PreviewDrawer";
import { TagManager } from "./TagManager";
import { toggleFavorite, softDelete, restore, updateMetadata } from "@/app/actions";
import { prefetchGallery } from "@/lib/gallery-cache";

type View = "all" | "recent" | "starred" | "trash" | "tag";

// Bot deep link for download (NEXT_PUBLIC_* is available on the client).
const BOT_USERNAME = process.env.NEXT_PUBLIC_BOT_USERNAME;
const deepLink = (slug: string): string | null =>
  BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${slug}` : null;

const SORTS: Record<string, { label: string; fn: (a: DriveFile, b: DriveFile) => number }> = {
  modified: { label: "Last modified", fn: (a, b) => b.modified - a.modified },
  name: { label: "Name", fn: (a, b) => a.name.localeCompare(b.name, "en") },
  size: { label: "Size", fn: (a, b) => (b.size || 0) - (a.size || 0) },
  kind: { label: "Type", fn: (a, b) => a.kind.localeCompare(b.kind) },
};

export function DriveApp({
  files,
  tags,
  initialView = "all",
}: {
  files: DriveFile[];
  tags: Tag[];
  initialView?: View;
}) {
  const [view, setView] = useState<View>(initialView);
  const [activeTag, setActiveTag] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState("modified");
  const [groupVersions, setGroupVersions] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const [sortMenu, setSortMenu] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; item: DriveFile } | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [manageTags, setManageTags] = useState(false);
  const [isPending, startTransition] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);

  /* ---- keyboard: ⌘K focuses search ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---- background album gallery prefetch (idle)
     Warm the session cache for all multi-part albums as soon as drive data is ready,
     so album previews open instantly (not just on the second open). */
  useEffect(() => {
    const albums = files.filter((f) => f.kind === "media" && f.parts > 1);
    if (!albums.length) return;
    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    const schedule = w.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 300));
    const handle = schedule(() => albums.forEach((f) => prefetchGallery(f.id)));
    return () => {
      if (w.cancelIdleCallback) w.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [files]);

  /* ---- mutations (server actions) ---- */
  const doStar = (item: DriveFile) =>
    startTransition(() => {
      toggleFavorite(item.id, !item.starred);
    });
  const doTrash = (item: DriveFile) =>
    startTransition(() => {
      softDelete(item.id);
    });
  const doRestore = (item: DriveFile) =>
    startTransition(() => {
      restore(item.id);
    });
  const doSave = (
    item: DriveFile,
    input: { title: string; kind: DriveFile["kind"]; tags: string }
  ) =>
    startTransition(() => {
      updateMetadata(item.id, input);
    });

  /* ---- counts ---- */
  const counts: Counts = useMemo(() => {
    const live = files.filter((f) => !f.trashed);
    const now = Date.now();
    const c: Counts = {
      all: live.length,
      recent: live.filter((f) => (now - f.modified) / 86400000 < 14).length,
      starred: live.filter((f) => f.starred).length,
      trash: files.filter((f) => f.trashed).length,
      tags: {},
    };
    tags.forEach((tg) => {
      c.tags[tg.id] = live.filter((f) => f.tags.includes(tg.id)).length;
    });
    return c;
  }, [files, tags]);

  /* ---- storage meter (composition by kind) ---- */
  const storage: Storage = useMemo(() => {
    const live = files.filter((f) => !f.trashed);
    const used = live.reduce((s, f) => s + (f.size || 0), 0);
    const byGroup: Record<string, number> = {};
    STORAGE_GROUPS.forEach((g) => (byGroup[g.key] = 0));
    live.forEach((f) => {
      const g = STORAGE_GROUPS.find((x) => x.key === f.kind);
      if (g) byGroup[g.key] += f.size || 0;
    });
    const num = fmtSize(used).split(" ");
    return {
      usedLabel: { num: num[0], unit: " " + (num[1] || "B") },
      capLabel: "Telegram",
      segments: STORAGE_GROUPS.map((g) => ({
        label: g.label,
        color: g.color,
        pct: used > 0 ? (byGroup[g.key] / used) * 100 : 0,
        sizeLabel: fmtSize(byGroup[g.key]),
      })),
      legend: STORAGE_GROUPS.filter((g) => byGroup[g.key] > 0).map((g) => ({
        label: g.label,
        color: g.color,
      })),
    };
  }, [files]);

  /* ---- filtered + sorted item list ---- */
  const items = useMemo(() => {
    let list = files.filter((f) => !f.trashed);
    const q = query.trim().toLowerCase();

    if (view === "trash") list = files.filter((f) => f.trashed);
    else if (view === "starred") list = list.filter((f) => f.starred);
    else if (view === "recent")
      list = list.filter((f) => (Date.now() - f.modified) / 86400000 < 14);
    else if (view === "tag") list = list.filter((f) => f.tags.includes(activeTag!));

    if (q) list = list.filter((f) => f.name.toLowerCase().includes(q));

    const fn = SORTS[sort].fn;
    return [...list].sort(fn);
  }, [files, view, activeTag, query, sort]);

  /* ---- grouping for the "Recent" view ---- */
  const grouped = useMemo(() => {
    if (view !== "recent" || query) return null;
    const groups: Record<string, DriveFile[]> = {};
    const order = ["Today", "Yesterday", "This week", "This month", "Older"];
    items.forEach((f) => {
      const g = relGroup(f.modified);
      (groups[g] = groups[g] || []).push(f);
    });
    return order.filter((g) => groups[g]).map((g) => ({ label: g, items: groups[g] }));
  }, [items, view, query]);

  /* ---- navigation ---- */
  const go = (v: string) => {
    setView(v as View);
    setActiveTag(null);
    setQuery("");
    setNavOpen(false);
  };
  const goTag = (id: number) => {
    setView("tag");
    setActiveTag(id);
    setQuery("");
    setNavOpen(false);
  };

  const title =
    view === "all"
      ? "All files"
      : view === "recent"
        ? "Recent"
        : view === "starred"
          ? "Favorites"
          : view === "trash"
            ? "Trash"
            : tags.find((x) => x.id === activeTag)?.name || "Tags";

  // "N versions" click → show all versions in the family (via search) and disable grouping.
  const pickFamily = (family: string) => setQuery(family);
  const openPreview = (item: DriveFile) => setPreviewId(item.id);
  const previewItem = previewId != null ? files.find((f) => f.id === previewId) ?? null : null;

  // Group games by family → representative = version with the most recent upload (date_added).
  const collapseVersions = (list: DriveFile[]) => {
    const counts = new Map<string, number>();
    if (!groupVersions || query || view === "trash") return { list, counts };
    const repIdx = new Map<string, number>();
    const out: DriveFile[] = [];
    for (const f of list) {
      if (f.kind !== "game") {
        out.push(f);
        continue;
      }
      counts.set(f.familyKey, (counts.get(f.familyKey) || 0) + 1);
      const idx = repIdx.get(f.familyKey);
      if (idx == null) {
        repIdx.set(f.familyKey, out.length);
        out.push(f);
      } else if (f.added > out[idx].added) {
        out[idx] = f;
      }
    }
    out.sort(SORTS[sort].fn);
    return { list: out, counts };
  };

  // Flat ordered list of items as they appear on screen (respects grouping + version
  // collapsing). Used for prev/next navigation inside the preview drawer.
  const navList = grouped
    ? grouped.flatMap((g) => collapseVersions(g.items).list)
    : collapseVersions(items).list;
  const navIndex = previewId == null ? -1 : navList.findIndex((f) => f.id === previewId);
  const hasPrevFile = navIndex > 0;
  const hasNextFile = navIndex >= 0 && navIndex < navList.length - 1;
  const navigatePreview = (delta: number) => {
    const next = navList[navIndex + delta];
    if (next) setPreviewId(next.id);
  };

  function renderItems(list: DriveFile[]) {
    const onMenu = (item: DriveFile, anchor: HTMLElement) => setMenu({ anchor, item });
    const { list: shown, counts } = collapseVersions(list);
    if (viewMode === "grid") {
      return (
        <div className="grid">
          {shown.map((item) => (
            <FileCard
              key={item.id}
              item={item}
              tags={tags}
              onStar={doStar}
              onMenu={onMenu}
              onOpen={openPreview}
              versionCount={counts.get(item.familyKey)}
              onPickFamily={pickFamily}
            />
          ))}
        </div>
      );
    }
    return (
      <div className="list">
        <div className="list-head">
          <button onClick={() => setSort("name")}>
            Name {sort === "name" && <Icon name="chevdown" size={13} />}
          </button>
          <button className="h-mod" onClick={() => setSort("modified")}>
            Modified {sort === "modified" && <Icon name="chevdown" size={13} />}
          </button>
          <button className="h-size" onClick={() => setSort("size")}>
            Size {sort === "size" && <Icon name="chevdown" size={13} />}
          </button>
          <span className="hide-mob">Type</span>
          <span></span>
        </div>
        {shown.map((item) => (
          <FileRow
            key={item.id}
            item={item}
            tags={tags}
            onStar={doStar}
            onMenu={onMenu}
            onOpen={openPreview}
            versionCount={counts.get(item.familyKey)}
            onPickFamily={pickFamily}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={"app" + (navOpen ? " nav-open" : "")} style={{ opacity: isPending ? 0.7 : 1 }}>
      <div className="scrim-mob" onClick={() => setNavOpen(false)}></div>

      <Sidebar
        view={view}
        tag={activeTag}
        counts={counts}
        tags={tags}
        storage={storage}
        onNav={go}
        onTag={goTag}
        onManageTags={() => setManageTags(true)}
      />

      <div className="main">
        <div className="topbar">
          <button className="iconbtn ghost hamburger" onClick={() => setNavOpen(true)}>
            <Icon name="menu" size={20} />
          </button>
          <div className="crumbs">
            <span className="crumb">{title}</span>
            <span className="crumb-count">{items.length} item</span>
          </div>

          <div className="spacer"></div>

          <div className="search">
            <Icon name="search" size={17} className="ico" />
            <input
              ref={searchRef}
              value={query}
              placeholder="Search files…"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query ? (
              <span
                style={{ cursor: "pointer", color: "var(--faint)", display: "grid" }}
                onClick={() => setQuery("")}
              >
                <Icon name="close" size={15} />
              </span>
            ) : (
              <kbd>⌘K</kbd>
            )}
          </div>

          <div className="seg hide-mob">
            <button
              className={viewMode === "grid" ? "on" : ""}
              onClick={() => setViewMode("grid")}
              title="Grid"
            >
              <Icon name="grid" size={16} />
            </button>
            <button
              className={viewMode === "list" ? "on" : ""}
              onClick={() => setViewMode("list")}
              title="List"
            >
              <Icon name="rows" size={16} />
            </button>
          </div>
        </div>

        <div className="toolbar">
          {view === "tag" && (
            <span
              className="chip lg"
              style={{
                ["--c" as string]:
                  TAG_COLORS[tags.find((x) => x.id === activeTag)?.color || ""] || "#888",
              }}
            >
              <i></i>
              {title}
            </span>
          )}
          <button
            className="sortbtn"
            onClick={(e) => {
              e.stopPropagation();
              setSortMenu(e.currentTarget);
            }}
          >
            <Icon name="sort" size={16} />
            {SORTS[sort].label}
            <Icon name="chevdown" size={14} />
          </button>
          <button
            className={"sortbtn toggle" + (groupVersions ? " on" : "")}
            onClick={() => setGroupVersions((v) => !v)}
            title="Group multiple game versions into one card"
          >
            <Icon name={groupVersions ? "check" : "all"} size={15} />
            Group versions
          </button>
          <div className="spacer"></div>
        </div>

        <div className="content scroll">
          {items.length === 0 ? (
            <EmptyState view={view} query={query} />
          ) : grouped ? (
            grouped.map((g) => (
              <div key={g.label}>
                <div className="section-h">{g.label}</div>
                {renderItems(g.items)}
              </div>
            ))
          ) : (
            renderItems(items)
          )}
        </div>
      </div>

      {sortMenu && (
        <Menu anchor={sortMenu} onClose={() => setSortMenu(null)} width={210}>
          <div className="menu-label">Sort by</div>
          {Object.entries(SORTS).map(([k, s]) => (
            <MenuItem
              key={k}
              label={s.label}
              check={sort === k}
              onClick={() => {
                setSort(k);
                setSortMenu(null);
              }}
            />
          ))}
        </Menu>
      )}

      {menu && (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} width={206}>
          {menu.item.trashed ? (
            <MenuItem
              icon="restore"
              label="Restore"
              onClick={() => {
                doRestore(menu.item);
                setMenu(null);
              }}
            />
          ) : (
            <>
              <MenuItem
                icon="download"
                label="Download"
                onClick={() => {
                  const url = deepLink(menu.item.slug);
                  if (url) window.open(url, "_blank");
                  setMenu(null);
                }}
              />
              <div className="menu-sep"></div>
              <MenuItem
                icon="star"
                label={menu.item.starred ? "Remove from favorites" : "Add to favorites"}
                onClick={() => {
                  doStar(menu.item);
                  setMenu(null);
                }}
              />
              <div className="menu-sep"></div>
              <MenuItem
                icon="trash"
                label="Delete"
                danger
                onClick={() => {
                  doTrash(menu.item);
                  setMenu(null);
                }}
              />
            </>
          )}
        </Menu>
      )}

      {previewItem && (
        <PreviewDrawer
          item={previewItem}
          tags={tags}
          deepLink={deepLink(previewItem.slug)}
          hasPrevFile={hasPrevFile}
          hasNextFile={hasNextFile}
          onNavigateFile={navigatePreview}
          onClose={() => setPreviewId(null)}
          onStar={doStar}
          onTrash={(it) => {
            doTrash(it);
            setPreviewId(null);
          }}
          onRestore={(it) => {
            doRestore(it);
            setPreviewId(null);
          }}
          onSave={(it, input) => {
            doSave(it, input);
            setPreviewId(null);
          }}
        />
      )}

      {manageTags && (
        <TagManager
          tags={tags}
          counts={counts.tags}
          onClose={() => setManageTags(false)}
        />
      )}

      {isPending && (
        <div className="saving-pill">
          <span className="spinner" />
          Saving…
        </div>
      )}
    </div>
  );
}

function EmptyState({ view, query }: { view: string; query: string }) {
  const cfg = query
    ? { icon: "search", h: "No results", p: `No files match "${query}".` }
    : view === "trash"
      ? { icon: "trash", h: "Trash is empty", p: "Deleted items appear here for 7 days before being purged." }
      : view === "starred"
        ? { icon: "star", h: "No favorites yet", p: "Star files to find them here quickly." }
        : view === "recent"
          ? { icon: "recent", h: "No recent activity", p: "Recently modified files will appear here." }
          : view === "tag"
            ? { icon: "tag", h: "This tag is empty", p: "Tag files via the caption when uploading." }
            : { icon: "cloud", h: "Drive is empty", p: "Send files to your Telegram channel with the correct caption format to start filling the archive." };
  return (
    <div className="empty">
      <div className="ill">
        <Icon name={cfg.icon} size={28} stroke={1.5} />
      </div>
      <h3>{cfg.h}</h3>
      <p>{cfg.p}</p>
    </div>
  );
}
