"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/lib/icons";
import { fmtSize, relGroup } from "@/lib/format";
import { TAG_COLORS } from "@/lib/kinds";
import type { DriveFile, Tag, Folder } from "@/lib/types";
import { Sidebar, type Counts, type Storage } from "./Sidebar";
import { FileCard, FileRow, FolderCard, FolderRow, Menu, MenuItem } from "./FileViews";
import { PreviewDrawer } from "./PreviewDrawer";
import { TagManager } from "./TagManager";
import { ThemeToggle } from "./ThemeToggle";
import {
  ConfirmDelete,
  ConfirmBulkDelete,
  CreateFolderModal,
  RenameFolderModal,
  MoveToFolderModal,
  EmptyState,
} from "./DriveDialogs";
import {
  toggleFavorite,
  softDelete,
  restore,
  purgeNow,
  updateMetadata,
  createFolder,
  renameFolder,
  deleteFolder,
  moveItemsToFolder,
  moveFolderToFolder,
  moveItemsPrivacy,
  moveFolderPrivacy,
  lockPrivate,
  bulkToggleFavorite,
  bulkSoftDelete,
  bulkRestore,
  bulkPurgeNow
} from "@/app/actions";
import { prefetchGallery } from "@/lib/gallery-cache";

type View = "all" | "recent" | "starred" | "trash" | "tag";

// Bot deep link for download (NEXT_PUBLIC_* is available on the client).
const BOT_USERNAME = process.env.NEXT_PUBLIC_BOT_USERNAME;
const deepLink = (slug: string): string | null =>
  BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${slug}` : null;

const SORTS: Record<string, { label: string; fn: (a: DriveFile, b: DriveFile, order: "asc" | "desc") => number }> = {
  modified: {
    label: "Last modified",
    fn: (a, b, order) => (order === "asc" ? a.modified - b.modified : b.modified - a.modified),
  },
  name: {
    label: "Name",
    fn: (a, b, order) => (order === "asc" ? a.name.localeCompare(b.name, "en") : b.name.localeCompare(a.name, "en")),
  },
  size: {
    label: "Size",
    fn: (a, b, order) => {
      const szA = a.size || 0;
      const szB = b.size || 0;
      return order === "asc" ? szA - szB : szB - szA;
    },
  },
  kind: {
    label: "Type",
    fn: (a, b, order) => (order === "asc" ? a.kind.localeCompare(b.kind) : b.kind.localeCompare(a.kind)),
  },
};

export function DriveApp({
  files,
  tags,
  folders = [],
  initialView = "all",
  space = "main",
}: {
  files: DriveFile[];
  tags: Tag[];
  folders?: Folder[];
  initialView?: View;
  space?: "main" | "private";
}) {
  const router = useRouter();
  const isPrivate = space === "private";
  const [view, setView] = useState<View>(initialView);
  const [activeTag, setActiveTag] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState("modified");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [groupVersions, setGroupVersions] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const [sortMenu, setSortMenu] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; item: DriveFile } | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [manageTags, setManageTags] = useState(false);

  // Folder states
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [showRenameFolder, setShowRenameFolder] = useState<Folder | null>(null);
  const [moveTargetIds, setMoveTargetIds] = useState<number[]>([]);
  const [moveFolderTarget, setMoveFolderTarget] = useState<Folder | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ anchor: HTMLElement; folder: Folder } | null>(null);

  // Private-space navigation: enter goes to the PIN-gated /private route; exit clears
  // the unlock cookie (so the PIN is required again next time) and returns to Main.
  const enterPrivate = () => router.push("/private");
  const exitPrivate = () =>
    startTransition(async () => {
      await lockPrivate();
      router.push("/");
    });

  // Multi-select states
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [confirmBulk, setConfirmBulk] = useState<{ ids: number[]; mode: "trash" | "purge" } | null>(null);

  // Preview options
  const [initialShowDetails, setInitialShowDetails] = useState(false);
  const [initialEditing, setInitialEditing] = useState(false);
  const [detailsOnly, setDetailsOnly] = useState(false);

  // Destructive-action confirmation. mode "trash" = move to Trash (reversible);
  // mode "purge" = delete from Telegram + DB now (irreversible).
  const [confirm, setConfirm] = useState<{ item: DriveFile; mode: "trash" | "purge" } | null>(null);
  // Transient error notification (e.g. permanent delete failed). Auto-dismisses.
  const [toast, setToast] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const menuClosedTimeRef = useRef<number>(0);
  const previewClosedTimeRef = useRef<number>(0);
  const markMenuClosed = () => {
    menuClosedTimeRef.current = Date.now();
  };
  const closePreview = () => {
    previewClosedTimeRef.current = Date.now();
    setPreviewId(null);
    setDetailsOnly(false);
  };

  const closeMenu = () => {
    markMenuClosed();
    setTimeout(() => setMenu(null), 0);
  };
  const closeFolderMenu = () => {
    markMenuClosed();
    setTimeout(() => setFolderMenu(null), 0);
  };
  const closeSortMenu = () => {
    markMenuClosed();
    setTimeout(() => setSortMenu(null), 0);
  };

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);
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
  const doPurge = (item: DriveFile) =>
    startTransition(async () => {
      const r = await purgeNow(item.id);
      if (!r.ok) setToast(r.error ?? "Failed to delete permanently.");
    });
  // Run a confirmed destructive action, then dismiss the dialog (and the preview
  // drawer if it was showing the same item, since it may now be gone).
  const runConfirm = () => {
    if (!confirm) return;
    if (confirm.mode === "purge") doPurge(confirm.item);
    else doTrash(confirm.item);
    if (previewId === confirm.item.id) closePreview();
    setConfirm(null);
  };
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

  /* ---- storage meter (composition by tag) ---- */
  const storage: Storage = useMemo(() => {
    const live = files.filter((f) => !f.trashed);
    const used = live.reduce((s, f) => s + (f.size || 0), 0);

    // Size used per tag. A file with multiple tags contributes its full
    // size to each tag it belongs to (segments may sum to > 100%, same
    // tradeoff any multi-tag breakdown has).
    const byTag: Record<number, number> = {};
    tags.forEach((tg) => (byTag[tg.id] = 0));
    let untaggedSize = 0;
    live.forEach((f) => {
      if (f.tags.length === 0) {
        untaggedSize += f.size || 0;
        return;
      }
      f.tags.forEach((tagId) => {
        byTag[tagId] = (byTag[tagId] || 0) + (f.size || 0);
      });
    });

    const num = fmtSize(used).split(" ");
    const sortedTags = [...tags].sort((a, b) => (byTag[b.id] || 0) - (byTag[a.id] || 0));
    const tagSegments = sortedTags.map((tg) => ({
      label: tg.name,
      color: TAG_COLORS[tg.color] || "#888",
      pct: used > 0 ? (byTag[tg.id] / used) * 100 : 0,
      sizeLabel: fmtSize(byTag[tg.id]),
    }));
    const untaggedSegment = {
      label: "Untagged",
      color: "var(--line-2)",
      pct: used > 0 ? (untaggedSize / used) * 100 : 0,
      sizeLabel: fmtSize(untaggedSize),
    };
    const segments = [...tagSegments, untaggedSegment];

    return {
      usedLabel: { num: num[0], unit: " " + (num[1] || "B") },
      capLabel: "Telegram",
      segments,
      legend: segments
        .filter((s) => s.pct > 0)
        .map((s) => ({ label: s.label, color: s.color })),
    };
  }, [files, tags]);

  /* ---- filtered + sorted item list ---- */
  const items = useMemo(() => {
    let list = files.filter((f) => !f.trashed);
    const q = query.trim().toLowerCase();

    if (view === "trash") list = files.filter((f) => f.trashed);
    else if (view === "starred") list = list.filter((f) => f.starred);
    else if (view === "recent")
      list = list.filter((f) => (Date.now() - f.modified) / 86400000 < 14);
    else if (view === "tag") list = list.filter((f) => f.tags.includes(activeTag!));

    // Filter items by current folder in the main directory when search is not active
    if (view === "all" && !q) {
      list = list.filter((f) => f.folderId === currentFolderId);
    }

    if (q) list = list.filter((f) => f.name.toLowerCase().includes(q));

    const fn = SORTS[sort].fn;
    return [...list].sort((a, b) => fn(a, b, sortOrder));
  }, [files, view, activeTag, query, sort, sortOrder, currentFolderId]);

  /* ---- folders at the current level ---- */
  const currentFolders = useMemo(() => {
    if (view !== "all" || query) return [];
    return folders.filter((f) => f.parentId === currentFolderId);
  }, [folders, view, currentFolderId, query]);

  /* ---- breadcrumbs path ---- */
  const breadcrumbs = useMemo(() => {
    if (view !== "all") return null;
    const crumbs = [{ id: null as number | null, name: "All files" }];
    let currId = currentFolderId;
    const path = [];
    while (currId !== null) {
      const folder = folders.find((f) => f.id === currId);
      if (!folder) break;
      path.unshift({ id: folder.id, name: folder.name });
      currId = folder.parentId;
    }
    return [...crumbs, ...path];
  }, [view, currentFolderId, folders]);

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
    setCurrentFolderId(null);
    setSelectedIds([]);
  };
  const goTag = (id: number) => {
    setView("tag");
    setActiveTag(id);
    setQuery("");
    setNavOpen(false);
    setCurrentFolderId(null);
    setSelectedIds([]);
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

  // Group archives by family → representative = version with the most recent upload (date_added).
  const collapseVersions = (list: DriveFile[]) => {
    const counts = new Map<string, number>();
    if (!groupVersions || query || view === "trash") return { list, counts };
    const repIdx = new Map<string, number>();
    const out: DriveFile[] = [];
    for (const f of list) {
      if (f.kind !== "archive") {
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
    out.sort((a, b) => SORTS[sort].fn(a, b, sortOrder));
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
    const isClickThrough = () => {
      return (Date.now() - menuClosedTimeRef.current < 150) || (Date.now() - previewClosedTimeRef.current < 150);
    };
    if (viewMode === "grid") {
      return (
        <>
        {currentFolders.length > 0 && (
          <div className="grid folders">
            {currentFolders.map((folder) => (
              <FolderCard
                key={`folder-${folder.id}`}
                folder={folder}
                onOpen={(id) => {
                  if (isClickThrough()) return;
                  setCurrentFolderId(id);
                  setSelectedIds([]);
                }}
                onMenu={(f, anchor) => setFolderMenu({ anchor, folder: f })}
              />
            ))}
          </div>
        )}
        <div className="grid">
          {shown.map((item) => (
            <FileCard
              key={item.id}
              item={item}
              tags={tags}
              onStar={doStar}
              onMenu={onMenu}
              onOpen={(it) => {
                if (isClickThrough()) return;
                setInitialShowDetails(false);
                setInitialEditing(false);
                setDetailsOnly(false);
                openPreview(it);
              }}
              versionCount={counts.get(item.familyKey)}
              onPickFamily={pickFamily}
              selected={selectedIds.includes(item.id)}
              onSelectToggle={(it) => {
                setSelectedIds((prev) =>
                  prev.includes(it.id)
                    ? prev.filter((id) => id !== it.id)
                    : [...prev, it.id]
                );
              }}
            />
          ))}
        </div>
        </>
      );
    }
    return (
      <div className="list">
        <div className="list-head">
          <button onClick={() => {
            if (sort === "name") {
              setSortOrder(o => o === "asc" ? "desc" : "asc");
            } else {
              setSort("name");
              setSortOrder("asc");
            }
          }}>
            Name {sort === "name" && (
              <Icon
                name="chevdown"
                size={13}
                style={{
                  transform: sortOrder === "asc" ? "rotate(180deg)" : "none",
                  transition: "transform 0.2s",
                  display: "inline-block",
                  marginLeft: "4px"
                }}
              />
            )}
          </button>
          <button className="h-mod" onClick={() => {
            if (sort === "modified") {
              setSortOrder(o => o === "asc" ? "desc" : "asc");
            } else {
              setSort("modified");
              setSortOrder("desc");
            }
          }}>
            Modified {sort === "modified" && (
              <Icon
                name="chevdown"
                size={13}
                style={{
                  transform: sortOrder === "asc" ? "rotate(180deg)" : "none",
                  transition: "transform 0.2s",
                  display: "inline-block",
                  marginLeft: "4px"
                }}
              />
            )}
          </button>
          <button className="h-size" onClick={() => {
            if (sort === "size") {
              setSortOrder(o => o === "asc" ? "desc" : "asc");
            } else {
              setSort("size");
              setSortOrder("desc");
            }
          }}>
            Size {sort === "size" && (
              <Icon
                name="chevdown"
                size={13}
                style={{
                  transform: sortOrder === "asc" ? "rotate(180deg)" : "none",
                  transition: "transform 0.2s",
                  display: "inline-block",
                  marginLeft: "4px"
                }}
              />
            )}
          </button>
          <span className="hide-mob">Type</span>
          <span></span>
        </div>
        {currentFolders.map((folder) => (
          <FolderRow
            key={`folder-${folder.id}`}
            folder={folder}
            onOpen={(id) => {
              if (isClickThrough()) return;
              setCurrentFolderId(id);
              setSelectedIds([]);
            }}
            onMenu={(f, anchor) => setFolderMenu({ anchor, folder: f })}
          />
        ))}
        {shown.map((item) => (
          <FileRow
            key={item.id}
            item={item}
            tags={tags}
            onStar={doStar}
            onMenu={onMenu}
            onOpen={(it) => {
              if (isClickThrough()) return;
              setInitialShowDetails(false);
              setInitialEditing(false);
              setDetailsOnly(false);
              openPreview(it);
            }}
            versionCount={counts.get(item.familyKey)}
            onPickFamily={pickFamily}
            selected={selectedIds.includes(item.id)}
            onSelectToggle={(it) => {
              setSelectedIds((prev) =>
                prev.includes(it.id)
                  ? prev.filter((id) => id !== it.id)
                  : [...prev, it.id]
              );
            }}
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
        privateSpace={isPrivate}
        onBrandClick={isPrivate ? exitPrivate : undefined}
      />

      <div className="main">
        <div className="topbar">
          <button className="iconbtn ghost hamburger" onClick={() => setNavOpen(true)}>
            <Icon name="menu" size={20} />
          </button>
          <div className="crumbs">
            {breadcrumbs ? (
              breadcrumbs.map((crumb, idx) => (
                <span key={idx} className="crumb-item" style={{ display: "inline-flex", alignItems: "center" }}>
                  {idx > 0 && <Icon name="chevright" size={12} style={{ margin: "0 6px", color: "var(--faint)" }} />}
                  <button
                    className="crumb-btn"
                    style={{
                      border: 0,
                      background: "none",
                      padding: 0,
                      font: "inherit",
                      cursor: crumb.id === currentFolderId ? "default" : "pointer",
                      fontWeight: crumb.id === currentFolderId ? 600 : 400,
                      color: crumb.id === currentFolderId ? "var(--ink)" : "var(--muted)",
                    }}
                    onClick={() => crumb.id !== currentFolderId && setCurrentFolderId(crumb.id)}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))
            ) : (
              <>
                <span className="crumb">{title}</span>
                <span className="crumb-count">{items.length} item</span>
              </>
            )}
            {view === "all" && !query && (
              <span className="crumb-count" style={{ marginLeft: 8 }}>
                {currentFolders.length} folder, {items.length} item
              </span>
            )}
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

          <button
            className="iconbtn ghost"
            onClick={isPrivate ? exitPrivate : enterPrivate}
            title={isPrivate ? "Exit Private space" : "Open Private space"}
            aria-label={isPrivate ? "Exit Private space" : "Open Private space"}
          >
            <Icon name={isPrivate ? "unlock" : "lock"} size={19} />
          </button>

          <ThemeToggle />
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
            title="Group multiple archive versions into one card"
          >
            <Icon name={groupVersions ? "check" : "all"} size={15} />
            Group versions
          </button>

          {/* New Folder Button */}
          {view === "all" && !query && (
            <button
              className="sortbtn"
              onClick={() => setShowCreateFolder(true)}
              title="Create new folder"
            >
              <Icon name="plus" size={15} />
              New Folder
            </button>
          )}

          <div className="spacer"></div>
        </div>

        <div className="content scroll">
          {items.length === 0 && currentFolders.length === 0 ? (
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
        <>
          <div className="menu-scrim" onClick={closeSortMenu} />
          <Menu anchor={sortMenu} onClose={closeSortMenu} width={210}>
            <div className="menu-label">Sort by</div>
            {Object.entries(SORTS).map(([k, s]) => (
              <MenuItem
                key={k}
                label={s.label}
                check={sort === k}
                onClick={() => {
                  if (sort === k) {
                    setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
                  } else {
                    setSort(k);
                    setSortOrder(k === "name" || k === "kind" ? "asc" : "desc");
                  }
                  closeSortMenu();
                }}
              />
            ))}
            <div className="menu-sep" />
            <div className="menu-label">Order</div>
            <MenuItem
              label="Ascending"
              check={sortOrder === "asc"}
              onClick={() => {
                setSortOrder("asc");
                closeSortMenu();
              }}
            />
            <MenuItem
              label="Descending"
              check={sortOrder === "desc"}
              onClick={() => {
                setSortOrder("desc");
                closeSortMenu();
              }}
            />
          </Menu>
        </>
      )}

      {menu && (
        <>
          <div className="menu-scrim" onClick={closeMenu} />
          <Menu anchor={menu.anchor} onClose={closeMenu} width={206}>
            {menu.item.trashed ? (
              <>
                <MenuItem
                  icon="restore"
                  label="Restore"
                  onClick={() => {
                    doRestore(menu.item);
                    closeMenu();
                  }}
                />
                <div className="menu-sep"></div>
                <MenuItem
                  icon="trash"
                  label="Delete permanently"
                  danger
                  onClick={() => {
                    setConfirm({ item: menu.item, mode: "purge" });
                    closeMenu();
                  }}
                />
              </>
            ) : (
              <>
                <MenuItem
                  icon="edit"
                  label="Edit"
                  onClick={() => {
                    setInitialEditing(true);
                    setInitialShowDetails(true);
                    setDetailsOnly(true);
                    openPreview(menu.item);
                    closeMenu();
                  }}
                />
                <MenuItem
                  icon="kebab"
                  label="Detail"
                  onClick={() => {
                    setInitialEditing(false);
                    setInitialShowDetails(true);
                    setDetailsOnly(true);
                    openPreview(menu.item);
                    closeMenu();
                  }}
                />
                <MenuItem
                  icon="folder"
                  label="Move to..."
                  onClick={() => {
                    setMoveTargetIds([menu.item.id]);
                    closeMenu();
                  }}
                />
                <div className="menu-sep"></div>
                <MenuItem
                  icon="download"
                  label="Download"
                  onClick={() => {
                    const url = deepLink(menu.item.slug);
                    if (url) window.open(url, "_blank");
                    closeMenu();
                  }}
                />
                <MenuItem
                  icon="star"
                  label={menu.item.starred ? "Remove from favorites" : "Add to favorites"}
                  onClick={() => {
                    doStar(menu.item);
                    closeMenu();
                  }}
                />
                <div className="menu-sep"></div>
                <MenuItem
                  icon="trash"
                  label="Delete"
                  danger
                  onClick={() => {
                    setConfirm({ item: menu.item, mode: "trash" });
                    closeMenu();
                  }}
                />
              </>
            )}
          </Menu>
        </>
      )}

      {folderMenu && (
        <>
          <div className="menu-scrim" onClick={closeFolderMenu} />
          <Menu anchor={folderMenu.anchor} onClose={closeFolderMenu} width={180}>
            <MenuItem
              icon="edit"
              label="Rename"
              onClick={() => {
                setShowRenameFolder(folderMenu.folder);
                closeFolderMenu();
              }}
            />
            <MenuItem
              icon="folder"
              label="Move to..."
              onClick={() => {
                setMoveFolderTarget(folderMenu.folder);
                closeFolderMenu();
              }}
            />
            <MenuItem
              icon="trash"
              label="Delete"
              danger
              onClick={() => {
                const confirmDel = window.confirm(`Delete folder "${folderMenu.folder.name}" and soft-delete all items inside?`);
                if (confirmDel) {
                  startTransition(async () => {
                    await deleteFolder(folderMenu.folder.id);
                  });
                }
                closeFolderMenu();
              }}
            />
          </Menu>
        </>
      )}

      {previewItem && (
        <PreviewDrawer
          item={previewItem}
          tags={tags}
          hasPrevFile={hasPrevFile}
          hasNextFile={hasNextFile}
          onNavigateFile={navigatePreview}
          navFiles={navList}
          onJumpToFile={(f) => setPreviewId(f.id)}
          onClose={closePreview}
          onSave={(it, input) => {
            doSave(it, input);
            closePreview();
          }}
          onDownload={() => {
            const url = deepLink(previewItem.slug);
            if (url) window.open(url, "_blank");
          }}
          onToggleStar={() => doStar(previewItem)}
          initialEditing={initialEditing}
          initialShowDetails={initialShowDetails}
          detailsOnly={detailsOnly}
        />
      )}

      {manageTags && (
        <TagManager
          tags={tags}
          counts={counts.tags}
          onClose={() => setManageTags(false)}
        />
      )}

      {confirm && (
        <ConfirmDelete
          item={confirm.item}
          mode={confirm.mode}
          onCancel={() => setConfirm(null)}
          onConfirm={runConfirm}
        />
      )}

      {confirmBulk && (
        <ConfirmBulkDelete
          count={confirmBulk.ids.length}
          mode={confirmBulk.mode}
          onCancel={() => setConfirmBulk(null)}
          onConfirm={() => {
            if (confirmBulk.mode === "purge") {
              startTransition(async () => {
                const r = await bulkPurgeNow(confirmBulk.ids);
                if (!r.ok) setToast(r.error ?? "Failed to delete permanently.");
                setSelectedIds([]);
              });
            } else {
              startTransition(async () => {
                await bulkSoftDelete(confirmBulk.ids);
                setSelectedIds([]);
              });
            }
            setConfirmBulk(null);
          }}
        />
      )}

      {/* Multi-select Floating Selection Toolbar — hidden while a preview/viewer
          is open so it doesn't float over the fullscreen stage. */}
      {selectedIds.length > 0 && !previewItem && (
        <div className="selection-toolbar">
          <div className="sel-count">{selectedIds.length} selected</div>
          <div className="sel-actions">
            <button
              className="action-btn"
              onClick={() => {
                const allSelectedStarred = selectedIds.every((id) => files.find((f) => f.id === id)?.starred);
                startTransition(async () => {
                  await bulkToggleFavorite(selectedIds, !allSelectedStarred);
                });
              }}
              title="Toggle Favorite"
            >
              <Icon name="star" size={16} fill={selectedIds.every((id) => files.find((f) => f.id === id)?.starred)} />
              <span>Favorite</span>
            </button>
            <button
              className="action-btn"
              onClick={() => setMoveTargetIds(selectedIds)}
              title="Move to folder"
            >
              <Icon name="folder" size={16} />
              <span>Move to</span>
            </button>
            {view === "trash" ? (
              <>
                <button
                  className="action-btn"
                  onClick={() => {
                    startTransition(async () => {
                      await bulkRestore(selectedIds);
                      setSelectedIds([]);
                    });
                  }}
                  title="Restore items"
                >
                  <Icon name="restore" size={16} />
                  <span>Restore</span>
                </button>
                <button
                  className="action-btn danger-btn"
                  onClick={() => {
                    setConfirmBulk({ ids: selectedIds, mode: "purge" });
                  }}
                  title="Delete permanently"
                >
                  <Icon name="trash" size={16} />
                  <span>Delete permanently</span>
                </button>
              </>
            ) : (
              <button
                className="action-btn danger-btn"
                onClick={() => {
                  setConfirmBulk({ ids: selectedIds, mode: "trash" });
                }}
                title="Delete items"
              >
                <Icon name="trash" size={16} />
                <span>Delete</span>
              </button>
            )}
            <button
              className="action-btn"
              onClick={() => {
                if (selectedIds.length === items.length) {
                  setSelectedIds([]);
                } else {
                  setSelectedIds(items.map((item) => item.id));
                }
              }}
            >
              <Icon name={selectedIds.length === items.length ? "circle" : "check"} size={16} />
              <span>{selectedIds.length === items.length ? "Deselect all" : "Select all"}</span>
            </button>
            <button
              className="action-btn"
              style={{ borderLeft: "1px solid var(--line)", paddingLeft: "16px" }}
              onClick={() => setSelectedIds([])}
            >
              <Icon name="close" size={16} />
              <span>Clear</span>
            </button>
          </div>
        </div>
      )}

      {/* Create Folder Modal */}
      {showCreateFolder && (
        <CreateFolderModal
          onClose={() => setShowCreateFolder(false)}
          onCreate={(name) => {
            startTransition(async () => {
              await createFolder(name, currentFolderId);
            });
            setShowCreateFolder(false);
          }}
        />
      )}

      {/* Rename Folder Modal */}
      {showRenameFolder && (
        <RenameFolderModal
          folder={showRenameFolder}
          onClose={() => setShowRenameFolder(null)}
          onRename={(name) => {
            startTransition(async () => {
              await renameFolder(showRenameFolder.id, name);
            });
            setShowRenameFolder(null);
          }}
        />
      )}

      {/* Move Items to Folder Modal */}
      {moveTargetIds.length > 0 && (
        <MoveToFolderModal
          folders={folders}
          space={space}
          mode="item"
          onClose={() => setMoveTargetIds([])}
          onMove={(targetFolderId) => {
            startTransition(async () => {
              await moveItemsToFolder(moveTargetIds, targetFolderId);
              setSelectedIds([]);
            });
            setMoveTargetIds([]);
          }}
          onMoveCrossSpace={() => {
            const ids = moveTargetIds;
            startTransition(async () => {
              await moveItemsPrivacy(ids, space === "main");
              setSelectedIds([]);
            });
            setMoveTargetIds([]);
          }}
        />
      )}

      {/* Move Folder Modal (to another folder, or across Main ⇄ Private) */}
      {moveFolderTarget && (
        <MoveToFolderModal
          folders={folders}
          space={space}
          mode="folder"
          movingFolderId={moveFolderTarget.id}
          onClose={() => setMoveFolderTarget(null)}
          onMove={(targetFolderId) => {
            const fid = moveFolderTarget.id;
            startTransition(async () => {
              await moveFolderToFolder(fid, targetFolderId);
            });
            setMoveFolderTarget(null);
          }}
          onMoveCrossSpace={() => {
            const fid = moveFolderTarget.id;
            startTransition(async () => {
              await moveFolderPrivacy(fid, space === "main");
            });
            setMoveFolderTarget(null);
          }}
        />
      )}

      {isPending && (
        <div className="saving-pill">
          <span className="spinner" />
          Saving…
        </div>
      )}

      {toast && (
        <div className="saving-pill err" role="alert" onClick={() => setToast(null)}>
          <Icon name="trash" size={15} />
          {toast}
        </div>
      )}
    </div>
  );
}

