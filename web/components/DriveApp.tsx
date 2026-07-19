"use client";

import { useCallback, useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLiveRefresh } from "@/lib/useLiveRefresh";
import { Icon } from "@/lib/icons";
import { fmtSize } from "@/lib/format";
import { TAG_COLORS } from "@/lib/kinds";
import type { DriveFile, Tag, Folder, KeptFile } from "@/lib/types";
import {
  type GroupKey,
  GROUP_OPTIONS,
  buildGroups,
  SORTS,
  fileReducer,
  folderReducer,
} from "@/lib/driveView";
import { Sidebar, type Counts, type Storage } from "./Sidebar";
import {
  FileCard,
  FileRow,
  FileTile,
  FileContent,
  FileListItem,
  FolderCard,
  FolderRow,
  FileFolderCard,
  Menu,
  MenuItem,
  SubMenuItem,
} from "./FileViews";
import { fileTypeFor } from "@/lib/fileType";
import { PreviewDrawer } from "./PreviewDrawer";
import { VideoPlayer } from "./VideoPlayer";
import { SubtitleDialog } from "./SubtitleDialog";
import { TagManager } from "./TagManager";
import { ThemeToggle } from "./ThemeToggle";
import { ViewMenu } from "./ViewMenu";
import { DetailsPane } from "./DetailsPane";
import {
  type LayoutPrefs,
  DEFAULT_PREFS,
  loadPrefs,
  savePrefs,
  LAYOUT_ICON,
} from "@/lib/layoutPrefs";
import {
  ConfirmDelete,
  ConfirmBulkDelete,
  CreateFolderModal,
  RenameFolderModal,
  MoveToFolderModal,
  UnpackModal,
  KeptFilesModal,
  FolderDetailsModal,
  EmptyState,
  ConfirmEmptyTrash,
  ConfirmRestore,
} from "./DriveDialogs";
import {
  toggleFavorite,
  softDelete,
  purgeNow,
  updateMetadata,
  unpackArchive,
  getUnpackStatus,
  getActiveUnpack,
  listKeptFiles,
  deleteKeptFile,
  extendKeptFile,
  compressKeptFile,
  createFolder,
  renameFolder,
  deleteFolder,
  restoreFolder,
  purgeFolderNow,
  emptyTrash,
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
import { useUpload } from "./UploadProvider";
import { DEFAULT_PART_MB } from "@/lib/uploadClient";

type View = "all" | "recent" | "starred" | "trash" | "tag";

/* ---- Unified selection keys ----
   Files and folders share one selection model so they behave identically (Ctrl/Shift
   range, arrow-nav, Ctrl+A, the floating toolbar). Item and folder IDs live in
   different tables and can collide, so every selected entry is tagged: `i:<id>` for a
   file, `f:<id>` for a folder. */
type SelKey = string;
const ik = (id: number): SelKey => `i:${id}`;
const fk = (id: number): SelKey => `f:${id}`;
const isItemKey = (k: SelKey) => k.charCodeAt(0) === 105; // 'i'
const keyId = (k: SelKey) => Number(k.slice(2));

/** Recursive content counts for a folder (excludes trashed items). */
export type FolderStat = {
  items: number;
  subfolders: number;
  directItems: number;
  directSubfolders: number;
};

// Bot deep link for download (NEXT_PUBLIC_* is available on the client).
const BOT_USERNAME = process.env.NEXT_PUBLIC_BOT_USERNAME;
const deepLink = (slug: string): string | null =>
  BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${slug}` : null;

export function DriveApp({
  files: baseFiles,
  tags,
  folders: baseFolders = [],
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
  // Optimistic overlays — every downstream read of `files`/`folders` sees these.
  const [files, optimizeFiles] = useOptimistic(baseFiles, fileReducer);
  const [folders, optimizeFolders] = useOptimistic(baseFolders, folderReducer);
  const [view, setView] = useState<View>(initialView);
  const [activeTag, setActiveTag] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [sortMenu, setSortMenu] = useState<HTMLElement | null>(null);

  /* ---- layout & view preferences (persisted to localStorage) ----
     Start from defaults (server + first client paint match), then hydrate the saved
     prefs after mount so there's no SSR class mismatch. */
  const [prefs, setPrefs] = useState<LayoutPrefs>(DEFAULT_PREFS);
  const [viewMenu, setViewMenu] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPrefs(loadPrefs());
  }, []);
  const updatePrefs = (patch: Partial<LayoutPrefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });

  // Sort / grouping prefs are persisted alongside the layout (loaded post-mount above).
  const sort = prefs.sort;
  const sortOrder = prefs.sortOrder;
  const groupBy = prefs.groupBy;
  const groupVersions = prefs.groupVersions;
  const setSort = (key: string) => updatePrefs({ sort: key });
  const setSortOrder = (next: "asc" | "desc" | ((o: "asc" | "desc") => "asc" | "desc")) =>
    updatePrefs({ sortOrder: typeof next === "function" ? next(prefs.sortOrder) : next });
  const setGroupBy = (key: GroupKey) => updatePrefs({ groupBy: key });
  const setGroupVersions = (next: boolean | ((v: boolean) => boolean)) =>
    updatePrefs({ groupVersions: typeof next === "function" ? next(prefs.groupVersions) : next });
  const [menu, setMenu] = useState<{ anchor: HTMLElement; item: DriveFile } | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [manageTags, setManageTags] = useState(false);

  // Folder states. `folderHistory` is the back-stack of visited folders (drives the
  // Backspace "go back" shortcut); navigation always goes through `goToFolder`.
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);

  const currentLayoutKey = view === "all" ? (currentFolderId?.toString() || "root") : view;
  const layout = prefs.folderLayouts?.[currentLayoutKey] || prefs.layout;
  const [folderHistory, setFolderHistory] = useState<(number | null)[]>([]);
  const [showCreateFolder, setShowCreateFolder] = useState(false);

  // One-click upload (global queue from UploadProvider). The Upload button picks
  // files/folder and starts uploading immediately — no form. Big files (> ~2 GB) are
  // auto-split, everything else uploads as a single media file; titles/tags are filled
  // automatically from the filename + type.
  const { addFiles: addFilesCtx, runQueue } = useUpload();
  const [uploadMenu, setUploadMenu] = useState<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  // Path of the folder currently open ("A/B/C"), so a one-click upload lands where the user
  // stands — the title prefix routes it through the server's folder resolution (upsert_item
  // splits titles on "/"), the same mechanism drive downloads use.
  const folderPathOf = (id: number | null): string => {
    const segs: string[] = [];
    let cur = id;
    while (cur != null) {
      const f = folders.find((x) => x.id === cur);
      if (!f) break;
      segs.unshift(f.name);
      cur = f.parentId;
    }
    return segs.join("/");
  };
  const startUploadFiles = (list: FileList | null, folder: boolean) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    addFilesCtx(picked, folder, {
      kind: "media",
      title: "",
      tags: "",
      partSize: DEFAULT_PART_MB,
      autoKind: true,
      folderPath: folderPathOf(currentFolderId),
    });
    runQueue();
  };
  const [showRenameFolder, setShowRenameFolder] = useState<Folder | null>(null);
  // Unified move target: any mix of items + folders (kebab → one entry; toolbar → the
  // whole selection). null = no move dialog open.
  const [moveTarget, setMoveTarget] = useState<{ itemIds: number[]; folderIds: number[] } | null>(null);
  const [unpackTarget, setUnpackTarget] = useState<DriveFile | null>(null);
  // Live unpack progress pill: {itemId} drives polling; the rest is the latest status shown.
  const [unpackTrack, setUnpackTrack] = useState<
    { itemId: number; name: string; status: string; progress: number; message: string } | null
  >(null);
  // Unpack outputs > 2 GB kept on the VPS (unpack_kept): pill → modal with download/delete-now.
  const [keptFiles, setKeptFiles] = useState<KeptFile[]>([]);
  const [showKept, setShowKept] = useState(false);
  // Kept video playing in the Plyr modal (same player as drive videos, src = /api/kept/<id>).
  const [keptPlay, setKeptPlay] = useState<{ id: number; name: string } | null>(null);
  const keptViewerRef = useRef<HTMLDivElement>(null);
  // "Add subtitle" dialog for the kept player + a bump that remounts VideoPlayer so a new track shows.
  const [keptSubsOpen, setKeptSubsOpen] = useState(false);
  const [keptSubsBump, setKeptSubsBump] = useState(0);
  const [folderMenu, setFolderMenu] = useState<{ anchor: HTMLElement; folder: Folder } | null>(null);
  // Standalone folder details popup (Alt+Enter / kebab Detail / toolbar Details).
  const [folderDetail, setFolderDetail] = useState<Folder | null>(null);

  // Private-space navigation: enter goes to the PIN-gated /private route; exit clears
  // the unlock cookie (so the PIN is required again next time) and returns to Main.
  const enterPrivate = () => router.push("/private");
  const exitPrivate = () =>
    startTransition(async () => {
      await lockPrivate();
      router.push("/");
    });

  // Multi-select states. `selected` holds tagged keys (`i:<id>` / `f:<id>`) so files and
  // folders share one selection; the id arrays below are derived for the actions.
  const [selected, setSelected] = useState<SelKey[]>([]);
  // Anchor for Shift+click range selection (last entry single-clicked / ctrl-toggled).
  const [selectAnchor, setSelectAnchor] = useState<SelKey | null>(null);
  const selectedItemIds = useMemo(() => selected.filter(isItemKey).map(keyId), [selected]);
  const selectedFolderIds = useMemo(
    () => selected.filter((k) => !isItemKey(k)).map(keyId),
    [selected]
  );
  const clearSelection = () => {
    setSelected([]);
    setSelectAnchor(null);
  };
  const [confirmBulk, setConfirmBulk] = useState<{
    itemIds: number[];
    folderIds: number[];
    mode: "trash" | "purge";
  } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<{
    itemIds: number[];
    folderIds: number[];
    itemName?: string;
  } | null>(null);
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false);

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
  // The "Saving…" pill appears only if a transition runs long enough to notice. Instant
  // optimistic actions (star/trash/move) update the UI immediately and finish in a blink,
  // so flashing a loading pill (or dimming the screen) for them just looks like lag.
  const [showSaving, setShowSaving] = useState(false);
  useEffect(() => {
    if (!isPending) {
      setShowSaving(false);
      return;
    }
    const t = window.setTimeout(() => setShowSaving(true), 600);
    return () => window.clearTimeout(t);
  }, [isPending]);

  /* ---- live updates: push via SSE, no polling ----
     Files indexed outside this tab (Bot Drop, history index, another session) land in
     Postgres directly. The server pushes a tiny signal over `/api/events` (Postgres
     NOTIFY → SSE) whenever the drive changes; we `router.refresh()` on each, which re-fetches
     the server data while preserving all client state (view/folder/selection) and rebases the
     optimistic overlay. The refresh is debounced (a bulk index emits many NOTIFYs) and skipped
     while a mutation transition is mid-flight (so it can't clobber an in-progress optimistic
     update). The connection itself is network-resilient — see lib/useLiveRefresh. */
  const pendingRef = useRef(isPending);
  pendingRef.current = isPending;
  useLiveRefresh("drive", { debounceMs: 400, canRefresh: () => !pendingRef.current });

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
  const closeViewMenu = () => {
    markMenuClosed();
    setTimeout(() => setViewMenu(null), 0);
  };
  const closeUploadMenu = () => {
    markMenuClosed();
    setTimeout(() => setUploadMenu(null), 0);
  };

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Latest-ref for the global keyboard handler: the window listener stays stable while
  // always seeing the current selection/state (assigned during render below).
  const keyNavRef = useRef<(e: KeyboardEvent) => void>(() => {});

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

  /* ---- keyboard: Esc clears the selection (when no menu/preview is open) ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (previewId != null || menu || sortMenu || viewMenu || folderMenu) return;
      if (selected.length) clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewId, menu, sortMenu, viewMenu, folderMenu, selected.length]);

  /* ---- keyboard: global arrow-key navigation + Ctrl/Cmd+A select-all ----
     Bound once on window so it works even before any file is clicked (delegates to the
     latest handler via keyNavRef). ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyNavRef.current(e);
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
    startTransition(async () => {
      optimizeFiles({ type: "star", ids: [item.id], starred: !item.starred });
      await toggleFavorite(item.id, !item.starred);
    });
  const doTrash = (item: DriveFile) =>
    startTransition(async () => {
      optimizeFiles({ type: "trash", ids: [item.id] });
      await softDelete(item.id);
    });
  const doPurge = (item: DriveFile) =>
    startTransition(async () => {
      optimizeFiles({ type: "remove", ids: [item.id] });
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
    startTransition(async () => {
      optimizeFiles({ type: "meta", id: item.id, title: input.title, kind: input.kind });
      await updateMetadata(item.id, input);
    });
  const doUnpack = (item: DriveFile, password: string) =>
    startTransition(async () => {
      const name = item.version ? item.family : item.name;
      setUnpackTarget(null);
      const r = await unpackArchive(item.id, password);
      if (r.ok) {
        setUnpackTrack({ itemId: item.id, name, status: "queued", progress: 0, message: "queued…" });
      } else {
        setToast(r.error ?? "Failed to start unpack.");
      }
    });
  // Poll the active unpack job (stops once its status turns terminal — see dep on status).
  useEffect(() => {
    const id = unpackTrack?.itemId;
    if (!id || unpackTrack.status === "done" || unpackTrack.status === "failed") return;
    let alive = true;
    const iv = setInterval(async () => {
      const s = await getUnpackStatus(id);
      if (!alive || !s) return;
      setUnpackTrack((cur) => (cur && cur.itemId === id ? { ...cur, ...s } : cur));
    }, 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [unpackTrack?.itemId, unpackTrack?.status]);
  // On a terminal unpack state: toast the outcome, then dismiss the pill.
  useEffect(() => {
    if (!unpackTrack) return;
    if (unpackTrack.status === "done")
      setToast(`“${unpackTrack.name}” unpacked — extracted files are appearing in your drive.`);
    else if (unpackTrack.status === "failed") setToast(unpackTrack.message || "Unpack failed.");
    else return;
    const t = setTimeout(() => setUnpackTrack(null), 2500);
    return () => clearTimeout(t);
  }, [unpackTrack?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Kept-on-server unpack outputs (> 2 GB): load on mount, reload when an unpack reaches a
  // terminal state (its big files may have just been kept).
  useEffect(() => {
    listKeptFiles().then(setKeptFiles).catch(() => {});
  }, [unpackTrack?.status]);

  // While the kept-files modal is open and a compress job is active, poll for its progress.
  useEffect(() => {
    if (!showKept || !keptFiles.some((f) => f.compress && ["queued", "running"].includes(f.compress.status)))
      return;
    const t = setInterval(() => {
      listKeptFiles().then(setKeptFiles).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [showKept, keptFiles]);

  // Esc closes the kept-video player; F toggles fullscreen (same keys as the drive-video viewer).
  useEffect(() => {
    if (!keptPlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else { setKeptPlay(null); setKeptSubsOpen(false); }
      } else if (e.key === "f" || e.key === "F") {
        const el = keptViewerRef.current;
        if (!el) return;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else el.requestFullscreen?.().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keptPlay]);

  // Resume the unpack pill after a navigation: the job runs server-side, but pill state is
  // client-local and dies when DriveApp unmounts (e.g. a visit to /upload).
  useEffect(() => {
    getActiveUnpack()
      .then((a) => {
        if (a)
          setUnpackTrack((cur) => cur ?? {
            itemId: a.itemId, name: a.name, status: a.status,
            progress: a.progress, message: a.message,
          });
      })
      .catch(() => {});
  }, []);

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

    if (view === "trash") {
      list = files.filter(
        (f) => f.trashed && (!f.folderId || !folders.find((fd) => fd.id === f.folderId)?.trashed)
      );
    } else if (view === "starred") list = list.filter((f) => f.starred);
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
  }, [files, folders, view, activeTag, query, sort, sortOrder, currentFolderId]);

  /* ---- folders at the current level ---- */
  const currentFolders = useMemo(() => {
    if (query) return [];
    if (view === "trash") {
      return folders.filter(
        (f) => f.trashed && (!f.parentId || !folders.find((fd) => fd.id === f.parentId)?.trashed)
      );
    }
    if (view !== "all") return [];
    return folders.filter((f) => f.parentId === currentFolderId && !f.trashed);
  }, [folders, view, currentFolderId, query]);

  /* ---- recursive content counts per folder (total items + sub-folders) ----
     Memoized bottom-up over the (acyclic) folder tree so every folder card/details
     view can show "N folders · M items" without re-walking each time. */
  const folderStats = useMemo(() => {
    const childrenMap = new Map<number, number[]>();
    for (const f of folders) {
      if (f.parentId != null) {
        const arr = childrenMap.get(f.parentId);
        if (arr) arr.push(f.id);
        else childrenMap.set(f.parentId, [f.id]);
      }
    }
    const directItems = new Map<number, number>();
    for (const f of files) {
      if (f.trashed || f.folderId == null) continue;
      directItems.set(f.folderId, (directItems.get(f.folderId) ?? 0) + 1);
    }
    const memo = new Map<number, FolderStat>();
    const compute = (id: number): FolderStat => {
      const cached = memo.get(id);
      if (cached) return cached;
      const kids = childrenMap.get(id) ?? [];
      const directItemCount = directItems.get(id) ?? 0;
      const res: FolderStat = {
        items: directItemCount,
        subfolders: kids.length,
        directItems: directItemCount,
        directSubfolders: kids.length,
      };
      memo.set(id, res); // set before recursing → safe even if the tree ever cycles
      for (const k of kids) {
        const s = compute(k);
        res.items += s.items;
        res.subfolders += s.subfolders;
      }
      return res;
    };
    for (const f of folders) compute(f.id);
    return memo;
  }, [folders, files]);
  const statOf = (id: number): FolderStat =>
    folderStats.get(id) ?? { items: 0, subfolders: 0, directItems: 0, directSubfolders: 0 };

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

  /* ---- section grouping (explicit "Group by", or the Recent view's date default) ---- */
  const grouped = useMemo(() => {
    if (query) return null; // never group while searching
    const key: GroupKey = groupBy !== "none" ? groupBy : view === "recent" ? "modified" : "none";
    return buildGroups(items, key, tags);
  }, [items, view, query, groupBy, tags]);

  /* ---- navigation ---- */
  const go = (v: string) => {
    setView(v as View);
    setActiveTag(null);
    setQuery("");
    setNavOpen(false);
    setCurrentFolderId(null);
    setFolderHistory([]);
    clearSelection();
  };
  const goTag = (id: number) => {
    setView("tag");
    setActiveTag(id);
    setQuery("");
    setNavOpen(false);
    setCurrentFolderId(null);
    setFolderHistory([]);
    clearSelection();
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
  type Collapsed = { list: DriveFile[]; counts: Map<string, number> };
  const collapseVersions = useCallback(
    (list: DriveFile[]): Collapsed => {
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
    },
    [groupVersions, query, view, sort, sortOrder]
  );

  /* ---- collapsed/ordered lists (memoized) ----
     These sort the whole library, so they're memoized on their real inputs — otherwise
     every selection click / arrow keypress (which only changes `selected`) would re-sort
     the entire list and rebuild the key index, the main source of interaction lag. */
  const collapsedItems = useMemo(() => collapseVersions(items), [collapseVersions, items]);
  const groupedCollapsed = useMemo(
    () => {
      if (!grouped) return null;
      const mapped = grouped.map((g) => ({ label: g.label, ...collapseVersions(g.items) }));
      if (layout === "xl") {
        return mapped
          .map((g) => {
            const filteredList = g.list.filter((item) => {
              const ft = fileTypeFor(item);
              return ft.id === "image" || ft.id === "video";
            });
            return { ...g, list: filteredList };
          })
          .filter((g) => g.list.length > 0);
      }
      return mapped;
    },
    [grouped, collapseVersions, layout]
  );

  // Flat ordered list of items as they appear on screen (respects grouping + version
  // collapsing). Used for prev/next navigation inside the preview drawer.
  const navList = useMemo(() => {
    const rawList = groupedCollapsed ? groupedCollapsed.flatMap((g) => g.list) : collapsedItems.list;
    if (layout === "xl") {
      return rawList.filter((item) => {
        const ft = fileTypeFor(item);
        return ft.id === "image" || ft.id === "video";
      });
    }
    return rawList;
  }, [groupedCollapsed, collapsedItems, layout]);

  const nonMediaFiles = useMemo(() => {
    if (layout !== "xl") return [];
    return collapsedItems.list.filter((item) => {
      const ft = fileTypeFor(item);
      return !(ft.id === "image" || ft.id === "video");
    });
  }, [collapsedItems.list, layout]);
  const navIndex = previewId == null ? -1 : navList.findIndex((f) => f.id === previewId);
  const hasPrevFile = navIndex > 0;
  const hasNextFile = navIndex >= 0 && navIndex < navList.length - 1;
  const navigatePreview = (delta: number) => {
    const next = navList[navIndex + delta];
    if (next) setPreviewId(next.id);
  };

  /* ---- selection helpers reachable from the content background + toolbar ---- */
  const clickThroughNow = () =>
    Date.now() - menuClosedTimeRef.current < 150 || Date.now() - previewClosedTimeRef.current < 150;

  // Clear the selection when clicking the empty content background. Items stopPropagation,
  // so this only fires for clicks that actually reach the scroll area / its containers.
  const onContentClick = () => {
    if (clickThroughNow()) return;
    if (selected.length) clearSelection();
  };

  // Every selectable entry currently on screen, in visual order: folders first (they
  // render above the items in every layout), then items in their displayed order
  // (`navList` already reflects grouping + version collapsing). Drives Ctrl+A,
  // select-all, and Shift-range (which can therefore span folders, files, and groups).
  const visibleKeys: SelKey[] = useMemo(() => {
    const foldersKeys = currentFolders.map((f) => fk(f.id));
    if (layout === "xl") {
      const nonMediaKeys = nonMediaFiles.map((i) => ik(i.id));
      const mediaKeys = navList
        .filter((item) => {
          const ft = fileTypeFor(item);
          return ft.id === "image" || ft.id === "video";
        })
        .map((i) => ik(i.id));
      return [...foldersKeys, ...nonMediaKeys, ...mediaKeys];
    }
    return [...foldersKeys, ...navList.map((i) => ik(i.id))];
  }, [currentFolders, navList, nonMediaFiles, layout]);

  // Shared selection wiring (files + folders, every layout + grouped sections).
  const toggleKey = (key: SelKey) =>
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  const selectKey = (key: SelKey, e: React.MouseEvent | React.KeyboardEvent) => {
    if (clickThroughNow()) return;
    if (e.ctrlKey || e.metaKey) {
      toggleKey(key);
      setSelectAnchor(key);
    } else if (e.shiftKey && selectAnchor != null) {
      const aIdx = visibleKeys.indexOf(selectAnchor);
      const bIdx = visibleKeys.indexOf(key);
      if (aIdx >= 0 && bIdx >= 0) {
        const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
        setSelected(visibleKeys.slice(lo, hi + 1));
      } else {
        setSelected([key]);
        setSelectAnchor(key);
      }
    } else {
      setSelected([key]);
      setSelectAnchor(key);
    }
  };

  // Item-cell handlers.
  const onMenuItem = (item: DriveFile, anchor: HTMLElement) => setMenu({ anchor, item });
  const onOpenItem = (it: DriveFile) => {
    if (clickThroughNow()) return;
    setInitialShowDetails(false);
    setInitialEditing(false);
    setDetailsOnly(false);
    openPreview(it);
  };
  const onDetailItem = (it: DriveFile) => {
    if (clickThroughNow()) return;
    setInitialEditing(false);
    setInitialShowDetails(true);
    setDetailsOnly(true);
    openPreview(it);
  };
  const onItemSelect = (it: DriveFile, e: React.MouseEvent | React.KeyboardEvent) => selectKey(ik(it.id), e);
  const onItemToggle = (it: DriveFile) => {
    toggleKey(ik(it.id));
    setSelectAnchor(ik(it.id));
  };

  /* ---- folder navigation (records a back-stack) ----
     Every folder change goes through goToFolder so Backspace can step back through the
     visited path; Alt+Up jumps to the parent of the current folder. */
  const goToFolder = (id: number | null) => {
    if (id === currentFolderId) return;
    setFolderHistory((h) => [...h, currentFolderId]);
    setCurrentFolderId(id);
    clearSelection();
  };
  const goBackFolder = () => {
    if (!folderHistory.length) return;
    const prev = folderHistory[folderHistory.length - 1];
    setFolderHistory((h) => h.slice(0, -1));
    setCurrentFolderId(prev);
    clearSelection();
  };
  const goToParentFolder = () => {
    if (currentFolderId == null) return;
    const f = folders.find((x) => x.id === currentFolderId);
    goToFolder(f ? f.parentId : null);
  };

  // Folder-cell wiring — folders share the file selection model.
  const onFolderOpen = (id: number) => {
    if (clickThroughNow()) return;
    goToFolder(id);
  };
  const folderCell = (folder: Folder) => {
    const s = statOf(folder.id);
    return {
      folder,
      onOpen: onFolderOpen,
      onMenu: (f: Folder, anchor: HTMLElement) => setFolderMenu({ anchor, folder: f }),
      onSelect: (f: Folder, e: React.MouseEvent | React.KeyboardEvent) => selectKey(fk(f.id), e),
      onDetail: (f: Folder) => {
        if (clickThroughNow()) return;
        setFolderDetail(f);
      },
      onSelectToggle: (f: Folder) => {
        toggleKey(fk(f.id));
        setSelectAnchor(fk(f.id));
      },
      selected: selected.includes(fk(folder.id)),
      itemCount: s.items,
      subfolderCount: s.subfolders,
    };
  };
  // Render a compact folders and non-media files grid (used above the files grid).
  const renderFoldersGrid = (nonMediaList: DriveFile[]) => {
    if (currentFolders.length === 0 && nonMediaList.length === 0) return null;
    return (
      <div className="grid folders" data-layout={layout}>
        {currentFolders.map((folder) => (
          <FolderCard key={`folder-${folder.id}`} {...folderCell(folder)} />
        ))}
        {nonMediaList.map((item) => (
          <FileFolderCard
            key={item.id}
            item={item}
            tags={tags}
            onStar={doStar}
            onMenu={onMenuItem}
            onOpen={onOpenItem}
            onSelect={onItemSelect}
            onDetail={onDetailItem}
            selected={selected.includes(ik(item.id))}
            onSelectToggle={onItemToggle}
            showExtensions={prefs.showExtensions}
            showDetails={prefs.showDetailItems}
          />
        ))}
      </div>
    );
  };
  const foldersGrid = renderFoldersGrid(nonMediaFiles);

  // Arrow-key navigation between focused entries (files AND folders). Uses live DOM
  // geometry so it works for every layout (grid columns, list rows, column-flow):
  // Left/Right step linearly; Up/Down pick the nearest entry on the adjacent row by
  // horizontal position.
  //   plain  → move focus + select only that entry (anchor = it)
  //   Shift  → extend the selection range from the anchor to the new entry
  //   Ctrl   → move focus only, leaving the selection untouched (toggle with Ctrl+Space)
  keyNavRef.current = (e: KeyboardEvent) => {
    const ae = document.activeElement as HTMLElement | null;
    const typing = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
    const overlayOpen = previewId != null || !!menu || !!sortMenu || !!viewMenu || !!folderMenu;

    // Folder navigation (Main view only, when not typing/no overlay):
    //   Backspace → step back through the visited folders
    //   Alt+Up    → go up one level to the parent folder
    if (!typing && !overlayOpen && view === "all" && !query) {
      if (e.key === "Backspace") {
        e.preventDefault();
        goBackFolder();
        return;
      }
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        goToParentFolder();
        return;
      }
    }

    // Ctrl/Cmd+A → select every visible folder + item.
    if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
      if (typing || overlayOpen || !visibleKeys.length) return;
      e.preventDefault();
      setSelected(visibleKeys);
      setSelectAnchor(visibleKeys[0] ?? null);
      return;
    }

    const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!arrows.includes(e.key) || typing || overlayOpen) return;
    const container = contentRef.current;
    if (!container) return;
    const nodes = Array.from(container.querySelectorAll<HTMLElement>("[data-key]"));
    if (!nodes.length) return;
    e.preventDefault();
    const keyOf = (n: HTMLElement) => n.dataset.key!;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? nodes.indexOf(active) : -1;

    // Nothing focused yet → land on the selected entry (or the first) and select it.
    if (idx === -1) {
      const start = nodes.find((n) => selected.includes(keyOf(n))) ?? nodes[0];
      start.focus();
      setSelected([keyOf(start)]);
      setSelectAnchor(keyOf(start));
      return;
    }

    // Resolve the target node for this arrow.
    let target: HTMLElement | undefined;
    if (e.key === "ArrowRight") target = nodes[idx + 1] ?? nodes[idx];
    else if (e.key === "ArrowLeft") target = nodes[idx - 1] ?? nodes[idx];
    else {
      const down = e.key === "ArrowDown";
      const cr = nodes[idx].getBoundingClientRect();
      const cand = nodes.filter((n) => {
        const t = n.getBoundingClientRect().top;
        return down ? t > cr.top + 1 : t < cr.top - 1;
      });
      if (!cand.length) return; // already on the edge row
      let rowTop: number | null = null;
      for (const n of cand) {
        const t = n.getBoundingClientRect().top;
        rowTop = rowTop == null ? t : down ? Math.min(rowTop, t) : Math.max(rowTop, t);
      }
      const rowNodes = cand.filter((n) => Math.abs(n.getBoundingClientRect().top - (rowTop as number)) < 2);
      target = rowNodes[0];
      for (const n of rowNodes) {
        if (
          Math.abs(n.getBoundingClientRect().left - cr.left) <
          Math.abs(target.getBoundingClientRect().left - cr.left)
        )
          target = n;
      }
    }
    if (!target) return;
    target.focus();
    const tkey = keyOf(target);

    if (e.shiftKey) {
      // Extend the range from the anchor (seed it from the current entry if unset).
      const anchorKey = selectAnchor ?? keyOf(nodes[idx]);
      const aIdx = nodes.findIndex((n) => keyOf(n) === anchorKey);
      const tIdx = nodes.indexOf(target);
      if (aIdx >= 0) {
        const [lo, hi] = aIdx < tIdx ? [aIdx, tIdx] : [tIdx, aIdx];
        setSelected(nodes.slice(lo, hi + 1).map(keyOf));
        setSelectAnchor(anchorKey);
      } else {
        setSelected([tkey]);
        setSelectAnchor(tkey);
      }
    } else if (e.ctrlKey || e.metaKey) {
      // Move focus only — keep the existing selection + anchor (Ctrl+Space toggles).
    } else {
      setSelected([tkey]);
      setSelectAnchor(tkey);
    }
  };

  // Toolbar download: open the bot deep link for every selected item in a new tab.
  const downloadSelected = () => {
    selectedItemIds.forEach((id) => {
      const f = files.find((x) => x.id === id);
      const url = f ? deepLink(f.slug) : null;
      if (url) window.open(url, "_blank");
    });
  };

  // Toolbar detail (single selection): open the standalone detail popup for the one
  // selected entry — item drawer or folder details popup.
  const detailSelected = () => {
    const key = selected[0];
    if (!key) return;
    if (isItemKey(key)) {
      const f = files.find((x) => x.id === keyId(key));
      if (!f) return;
      setInitialEditing(false);
      setInitialShowDetails(true);
      setDetailsOnly(true);
      openPreview(f);
    } else {
      const folder = folders.find((x) => x.id === keyId(key));
      if (folder) setFolderDetail(folder);
    }
  };

  function renderItems(collapsed: Collapsed, includeFolders = true) {
    const { list: shown, counts } = collapsed;
    const isXl = layout === "xl";
    const mediaFiles = isXl ? shown.filter(item => {
      const ft = fileTypeFor(item);
      return ft.id === "video" || ft.id === "image";
    }) : shown;
    const sectionNonMedia = isXl ? shown.filter(item => {
      const ft = fileTypeFor(item);
      return !(ft.id === "video" || ft.id === "image");
    }) : [];

    // Shared props for every file-cell component (grid card, tile, content row, list item).
    const cell = (item: DriveFile) => ({
      item,
      tags,
      onStar: doStar,
      onMenu: onMenuItem,
      onOpen: onOpenItem,
      onSelect: onItemSelect,
      onDetail: onDetailItem,
      versionCount: counts.get(item.familyKey),
      onPickFamily: pickFamily,
      selected: selected.includes(ik(item.id)),
      onSelectToggle: onItemToggle,
      showExtensions: prefs.showExtensions,
      showDetails: prefs.showDetailItems,
    });

    // Folders render as compact cards above the items in every layout except Details,
    // where they become table rows interleaved with the file rows.
    const folderBlock = includeFolders && layout !== "details" ? renderFoldersGrid(sectionNonMedia) : null;

    if (layout === "details") {
      const sortHead = (key: string, label: string, cls?: string, defOrder: "asc" | "desc" = "asc") => (
        <button
          className={cls}
          onClick={() => {
            if (sort === key) setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
            else {
              setSort(key);
              setSortOrder(defOrder);
            }
          }}
        >
          {label}{" "}
          {sort === key && (
            <Icon
              name="chevdown"
              size={13}
              style={{
                transform: sortOrder === "asc" ? "rotate(180deg)" : "none",
                transition: "transform 0.2s",
                display: "inline-block",
                marginLeft: "4px",
              }}
            />
          )}
        </button>
      );
      return (
        <div className="list">
          <div className="list-head">
            {sortHead("name", "Name", undefined, "asc")}
            {sortHead("modified", "Modified", "h-mod", "desc")}
            {sortHead("size", "Size", "h-size", "desc")}
            <span className="hide-mob">Type</span>
            <span></span>
          </div>
          {includeFolders &&
            currentFolders.map((folder) => (
              <FolderRow key={`folder-${folder.id}`} {...folderCell(folder)} />
            ))}
          {shown.map((item) => (
            <FileRow key={item.id} {...cell(item)} />
          ))}
        </div>
      );
    }

    if (layout === "list") {
      return (
        <>
          {folderBlock}
          <div className="list-flow">
            {shown.map((item) => (
              <FileListItem key={item.id} {...cell(item)} />
            ))}
          </div>
        </>
      );
    }

    if (layout === "tiles") {
      return (
        <>
          {folderBlock}
          <div className="tiles">
            {shown.map((item) => (
              <FileTile key={item.id} {...cell(item)} />
            ))}
          </div>
        </>
      );
    }

    if (layout === "content") {
      return (
        <>
          {folderBlock}
          <div className="content-rows">
            {shown.map((item) => (
              <FileContent key={item.id} {...cell(item)} />
            ))}
          </div>
        </>
      );
    }

    // Icon grids: xl / large / medium / small — same card, CSS sizes by data-layout.
    return (
      <>
        {folderBlock}
        <div className="grid" data-layout={layout}>
          {mediaFiles.map((item) => (
            <FileCard key={item.id} {...cell(item)} />
          ))}
        </div>
      </>
    );
  }

  // A single selected entry (file OR folder) drives the persistent details pane.
  const singleKey = selected.length === 1 ? selected[0] : null;
  const detailsSelected =
    singleKey && isItemKey(singleKey) ? files.find((f) => f.id === keyId(singleKey)) ?? null : null;
  const detailsFolder =
    singleKey && !isItemKey(singleKey) ? folders.find((f) => f.id === keyId(singleKey)) ?? null : null;

  const appClass = [
    "app",
    navOpen ? "nav-open" : "",
    prefs.showSidebar ? "" : "no-sidebar",
    prefs.detailsPane ? "with-details" : "",
    prefs.compact ? "compact" : "",
    prefs.showCheckboxes ? "show-checks" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={appClass}>
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
                    onClick={() => crumb.id !== currentFolderId && goToFolder(crumb.id)}
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

          <button
            className="viewbtn hide-mob"
            onClick={(e) => {
              e.stopPropagation();
              setViewMenu(e.currentTarget);
            }}
            title="Layout & view options"
          >
            <Icon name={LAYOUT_ICON[layout]} size={16} />
            <span>View</span>
            <Icon name="chevdown" size={14} />
          </button>

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

          {/* Upload Button (files / folder) — starts uploading immediately, no form.
              Main space only: the upload pipeline indexes into Main, not Private. */}
          {view === "all" && !query && !isPrivate && (
            <button
              className="sortbtn"
              onClick={(e) => {
                e.stopPropagation();
                setUploadMenu(e.currentTarget);
              }}
              title="Upload files or a folder"
            >
              <Icon name="upload" size={15} />
              Upload
              <Icon name="chevdown" size={14} />
            </button>
          )}

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

          {view === "trash" && items.length + currentFolders.length > 0 && (
            <button
              className="sortbtn danger-btn"
              style={{ color: "var(--red)", borderColor: "var(--red-dim)", background: "transparent" }}
              onClick={() => setConfirmEmptyTrash(true)}
              title="Empty Trash"
            >
              <Icon name="trash" size={15} />
              Empty Trash
            </button>
          )}

          <div className="spacer"></div>
        </div>

        <div className="content scroll" ref={contentRef} onClick={onContentClick}>
          {items.length === 0 && currentFolders.length === 0 ? (
            <EmptyState view={view} query={query} />
          ) : groupedCollapsed ? (
            <>
              {/* folders once, above the grouped sections (each section is files only) */}
              {foldersGrid}
              {groupedCollapsed.map((g) => (
                <div key={g.label}>
                  <div className="section-h">
                    {g.label} <span className="section-count">{g.list.length}</span>
                  </div>
                  {renderItems(g, false)}
                </div>
              ))}
            </>
          ) : (
            renderItems(collapsedItems)
          )}
        </div>
      </div>

      {prefs.detailsPane && (
        <DetailsPane
          item={detailsSelected}
          folder={detailsFolder}
          folderStat={detailsFolder ? statOf(detailsFolder.id) : null}
          tags={tags}
          showExtensions={prefs.showExtensions}
          onClose={() => updatePrefs({ detailsPane: false })}
        />
      )}

      {viewMenu && (
        <ViewMenu
          anchor={viewMenu}
          prefs={{ ...prefs, layout }}
          onChange={(patch) => {
            if (patch.layout) {
              updatePrefs({ folderLayouts: { ...(prefs.folderLayouts || {}), [currentLayoutKey]: patch.layout } });
            } else {
              updatePrefs(patch);
            }
          }}
          onClose={closeViewMenu}
        />
      )}

      {/* Hidden pickers for the Upload button. Selecting starts the upload immediately. */}
      <input
        ref={fileInputRef}
        type="file"
        hidden
        multiple
        onChange={(e) => {
          startUploadFiles(e.target.files, false);
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        hidden
        multiple
        // webkitdirectory/directory are non-standard but widely supported.
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => {
          startUploadFiles(e.target.files, true);
          e.currentTarget.value = "";
        }}
      />

      {uploadMenu && (
        <>
          <div className="menu-scrim" onClick={closeUploadMenu} />
          <Menu anchor={uploadMenu} onClose={closeUploadMenu} width={190}>
            <MenuItem
              icon="upload"
              label="Upload files"
              onClick={() => {
                fileInputRef.current?.click();
                closeUploadMenu();
              }}
            />
            <MenuItem
              icon="folder"
              label="Upload folder"
              onClick={() => {
                folderInputRef.current?.click();
                closeUploadMenu();
              }}
            />
          </Menu>
        </>
      )}

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
            <div className="menu-sep" />
            <SubMenuItem icon="rows" label="Group by">
              {GROUP_OPTIONS.map((g) => (
                <MenuItem
                  key={g.key}
                  label={g.label}
                  check={groupBy === g.key}
                  onClick={() => {
                    setGroupBy(g.key);
                    closeSortMenu();
                  }}
                />
              ))}
            </SubMenuItem>
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
                    setConfirmRestore({
                      itemIds: [menu.item.id],
                      folderIds: [],
                      itemName: menu.item.version ? menu.item.family : menu.item.name,
                    });
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
                    setMoveTarget({ itemIds: [menu.item.id], folderIds: [] });
                    closeMenu();
                  }}
                />
                {menu.item.kind === "archive" && (
                  <MenuItem
                    icon="download"
                    label="Unpack archive"
                    onClick={() => {
                      setUnpackTarget(menu.item);
                      closeMenu();
                    }}
                  />
                )}
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
            {folderMenu.folder.trashed ? (
              <>
                <MenuItem
                  icon="restore"
                  label="Restore"
                  onClick={() => {
                    setConfirmRestore({
                      itemIds: [],
                      folderIds: [folderMenu.folder.id],
                      itemName: folderMenu.folder.name,
                    });
                    closeFolderMenu();
                  }}
                />
                <div className="menu-sep"></div>
                <MenuItem
                  icon="trash"
                  label="Delete permanently"
                  danger
                  onClick={() => {
                    setConfirmBulk({ itemIds: [], folderIds: [folderMenu.folder.id], mode: "purge" });
                    closeFolderMenu();
                  }}
                />
              </>
            ) : (
              <>
                <MenuItem
                  icon="info"
                  label="Detail"
                  onClick={() => {
                    setFolderDetail(folderMenu.folder);
                    closeFolderMenu();
                  }}
                />
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
                    setMoveTarget({ itemIds: [], folderIds: [folderMenu.folder.id] });
                    closeFolderMenu();
                  }}
                />
                <div className="menu-sep"></div>
                <MenuItem
                  icon="trash"
                  label="Delete"
                  danger
                  onClick={() => {
                    setConfirmBulk({ itemIds: [], folderIds: [folderMenu.folder.id], mode: "trash" });
                    closeFolderMenu();
                  }}
                />
              </>
            )}
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
          itemCount={confirmBulk.itemIds.length}
          folderCount={confirmBulk.folderIds.length}
          mode={confirmBulk.mode}
          onCancel={() => setConfirmBulk(null)}
          onConfirm={() => {
            const { itemIds, folderIds, mode } = confirmBulk;
            if (mode === "purge") {
              startTransition(async () => {
                if (itemIds.length) optimizeFiles({ type: "remove", ids: itemIds });
                if (folderIds.length) optimizeFolders({ type: "remove", ids: folderIds });
                if (itemIds.length) {
                  const r = await bulkPurgeNow(itemIds);
                  if (!r.ok) setToast(r.error ?? "Failed to delete permanently.");
                }
                for (const fid of folderIds) await purgeFolderNow(fid);
                clearSelection();
              });
            } else {
              startTransition(async () => {
                if (itemIds.length) optimizeFiles({ type: "trash", ids: itemIds });
                if (folderIds.length) optimizeFolders({ type: "trash", ids: folderIds });
                if (itemIds.length) await bulkSoftDelete(itemIds);
                for (const fid of folderIds) await deleteFolder(fid);
                clearSelection();
              });
            }
            setConfirmBulk(null);
          }}
        />
      )}

      {confirmRestore && (
        <ConfirmRestore
          itemCount={confirmRestore.itemIds.length}
          folderCount={confirmRestore.folderIds.length}
          itemName={confirmRestore.itemName}
          onCancel={() => setConfirmRestore(null)}
          onConfirm={() => {
            const { itemIds, folderIds } = confirmRestore;
            startTransition(async () => {
              if (itemIds.length) {
                optimizeFiles({ type: "restore", ids: itemIds });
                await bulkRestore(itemIds);
              }
              if (folderIds.length) {
                optimizeFolders({ type: "restore", ids: folderIds });
                for (const fid of folderIds) await restoreFolder(fid);
              }
              clearSelection();
            });
            setConfirmRestore(null);
          }}
        />
      )}

      {confirmEmptyTrash && (
        <ConfirmEmptyTrash
          onCancel={() => setConfirmEmptyTrash(false)}
          onConfirm={() => {
            setConfirmEmptyTrash(false);
            startTransition(async () => {
              const r = await emptyTrash();
              if (!r.ok) setToast(r.error ?? "Failed to empty trash.");
              clearSelection();
            });
          }}
        />
      )}

      {/* Multi-select Floating Selection Toolbar — icon-only; hidden while a preview/viewer
          is open so it doesn't float over the fullscreen stage. Item-only actions
          (download/favorite) appear only when the selection contains files; move + delete
          act on the whole mix of files + folders. */}
      {selected.length > 0 && !previewItem && (
        <div className="selection-toolbar">
          <div className="sel-actions">
            {selected.length === 1 && view !== "trash" && (
              <button className="action-btn" onClick={detailSelected} title="Details" aria-label="Details">
                <Icon name="info" size={17} />
              </button>
            )}
            {view !== "trash" && selectedItemIds.length > 0 && (
              <button className="action-btn" onClick={downloadSelected} title="Download" aria-label="Download">
                <Icon name="download" size={17} />
                {selectedItemIds.length > 1 && <span className="sel-badge">{selectedItemIds.length}</span>}
              </button>
            )}
            {view !== "trash" && selectedItemIds.length > 0 && (
              <button
                className="action-btn"
                onClick={() => {
                  const allStarred = selectedItemIds.every((id) => files.find((f) => f.id === id)?.starred);
                  startTransition(async () => {
                    optimizeFiles({ type: "star", ids: selectedItemIds, starred: !allStarred });
                    await bulkToggleFavorite(selectedItemIds, !allStarred);
                  });
                }}
                title="Toggle favorite"
                aria-label="Toggle favorite"
              >
                <Icon name="star" size={16} fill={selectedItemIds.every((id) => files.find((f) => f.id === id)?.starred)} />
              </button>
            )}
            {view !== "trash" && (
              <button
                className="action-btn"
                onClick={() => setMoveTarget({ itemIds: selectedItemIds, folderIds: selectedFolderIds })}
                title="Move to folder"
                aria-label="Move to folder"
              >
                <Icon name="folder" size={16} />
              </button>
            )}
            {view === "trash" ? (
              <>
                <button
                  className="action-btn"
                  onClick={() => {
                    setConfirmRestore({
                      itemIds: selectedItemIds,
                      folderIds: selectedFolderIds,
                    });
                  }}
                  title="Restore items"
                  aria-label="Restore items"
                >
                  <Icon name="restore" size={16} />
                </button>
                <button
                  className="action-btn danger-btn"
                  onClick={() => setConfirmBulk({ itemIds: selectedItemIds, folderIds: selectedFolderIds, mode: "purge" })}
                  title="Delete permanently"
                  aria-label="Delete permanently"
                >
                  <Icon name="trash" size={16} />
                </button>
              </>
            ) : (
              <button
                className="action-btn danger-btn"
                onClick={() => setConfirmBulk({ itemIds: selectedItemIds, folderIds: selectedFolderIds, mode: "trash" })}
                title="Delete"
                aria-label="Delete"
              >
                <Icon name="trash" size={16} />
              </button>
            )}
            {selected.length !== visibleKeys.length && (
              <button
                className="action-btn"
                onClick={() => {
                  setSelected(visibleKeys);
                  setSelectAnchor(visibleKeys[0] ?? null);
                }}
                title="Select all"
                aria-label="Select all"
              >
                <Icon name="check" size={16} />
              </button>
            )}
            <button
              className="action-btn"
              style={{ borderLeft: "1px solid var(--line)", paddingLeft: "14px" }}
              onClick={clearSelection}
              title="Clear selection"
              aria-label="Clear selection"
            >
              <Icon name="close" size={16} />
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
              const now = Date.now();
              optimizeFolders({
                type: "create",
                folder: { id: -now, name, parentId: currentFolderId, createdAt: now, updatedAt: now, trashed: false, deletedAt: null },
              });
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
            const fid = showRenameFolder.id;
            startTransition(async () => {
              optimizeFolders({ type: "rename", id: fid, name });
              await renameFolder(fid, name);
            });
            setShowRenameFolder(null);
          }}
        />
      )}

      {/* Unified Move Modal — any mix of items + folders, to another folder or across
          Main ⇄ Private. Targets that would create a cycle are excluded by the modal. */}
      {moveTarget && (
        <MoveToFolderModal
          folders={folders}
          space={space}
          moveItemIds={moveTarget.itemIds}
          moveFolderIds={moveTarget.folderIds}
          onClose={() => setMoveTarget(null)}
          onMove={(targetFolderId) => {
            const { itemIds, folderIds } = moveTarget;
            startTransition(async () => {
              if (itemIds.length) optimizeFiles({ type: "move", ids: itemIds, folderId: targetFolderId });
              for (const fid of folderIds) optimizeFolders({ type: "move", id: fid, parentId: targetFolderId });
              if (itemIds.length) await moveItemsToFolder(itemIds, targetFolderId);
              for (const fid of folderIds) {
                try {
                  await moveFolderToFolder(fid, targetFolderId);
                } catch (err) {
                  setToast(err instanceof Error ? err.message : "Failed to move folder.");
                }
              }
              clearSelection();
            });
            setMoveTarget(null);
          }}
          onMoveCrossSpace={() => {
            const { itemIds, folderIds } = moveTarget;
            startTransition(async () => {
              // Moving across the Main ⇄ Private boundary removes the rows from this space.
              if (itemIds.length) optimizeFiles({ type: "remove", ids: itemIds });
              if (folderIds.length) optimizeFolders({ type: "remove", ids: folderIds });
              if (itemIds.length) await moveItemsPrivacy(itemIds, space === "main");
              for (const fid of folderIds) await moveFolderPrivacy(fid, space === "main");
              clearSelection();
            });
            setMoveTarget(null);
          }}
        />
      )}

      {/* Unpack archive → optional password → queue an unpack_jobs row (bot/unpack.py). */}
      {unpackTarget && (
        <UnpackModal
          item={{ name: unpackTarget.version ? unpackTarget.family : unpackTarget.name }}
          onClose={() => setUnpackTarget(null)}
          onUnpack={(password) => doUnpack(unpackTarget, password)}
        />
      )}

      {/* Folder Details popup (Alt+Enter / kebab Detail / toolbar Details) */}
      {folderDetail && (
        <FolderDetailsModal
          folder={folderDetail}
          stat={statOf(folderDetail.id)}
          onClose={() => setFolderDetail(null)}
          onOpen={() => {
            goToFolder(folderDetail.id);
            setFolderDetail(null);
          }}
        />
      )}

      {/* All transient pills share one top-right stack (see .pill-stack in globals.css). */}
      <div className="pill-stack">
        {showSaving && (
          <div className="saving-pill">
            <span className="spinner" />
            Saving…
          </div>
        )}

        {unpackTrack && unpackTrack.status !== "failed" && (
          <div className="saving-pill">
            <span className="spinner" />
            Unpacking {unpackTrack.name}: {unpackTrack.progress}% — {unpackTrack.message || unpackTrack.status}
          </div>
        )}

        {/* Unpack outputs > 2 GB kept on the VPS — pill opens the download/delete-now list. */}
        {keptFiles.length > 0 && !unpackTrack && (
          <button className="saving-pill" style={{ cursor: "pointer" }} onClick={() => setShowKept(true)}>
            <Icon name="archive" size={15} />
            {keptFiles.length} file{keptFiles.length > 1 ? "s" : ""} kept on server
          </button>
        )}

        {toast && (
          <div className="saving-pill err" role="alert" onClick={() => setToast(null)}>
            <Icon name="trash" size={15} />
            {toast}
          </div>
        )}
      </div>

      {showKept && (
        <KeptFilesModal
          files={keptFiles}
          onClose={() => setShowKept(false)}
          onDelete={(id) =>
            startTransition(async () => {
              const r = await deleteKeptFile(id);
              if (!r.ok) setToast(r.error ?? "Failed to delete the kept file.");
              setKeptFiles(await listKeptFiles());
            })
          }
          onExtend={(id, hours) =>
            startTransition(async () => {
              const r = await extendKeptFile(id, hours);
              if (!r.ok) setToast(r.error ?? "Failed to update the keep time.");
              setKeptFiles(await listKeptFiles());
            })
          }
          onPlay={(f) => setKeptPlay(f)}
          onCompress={(id, crf) =>
            startTransition(async () => {
              const r = await compressKeptFile(id, crf);
              if (!r.ok) setToast(r.error ?? "Failed to queue the compression.");
              setKeptFiles(await listKeptFiles());
            })
          }
        />
      )}

      {/* Kept-video player — the same full-screen immersive viewer as drive videos (top bar,
          fullscreen, Esc/F keys), fed by /api/kept (Range-capable). No filmstrip/subtitles/
          seek-preview: a kept file isn't a Telegram part, so it has no partId to key those off. */}
      {keptPlay && (
        <>
          <div className="viewer-scrim" style={{ zIndex: 340 }} />
          <div ref={keptViewerRef} className="viewer has-video-stage" style={{ zIndex: 341 }}>
            <div className="viewer-stage">
              <VideoPlayer
                key={`${keptPlay.id}:${keptSubsBump}`}
                src={`/api/kept/${keptPlay.id}`}
                subtitleBase={`/api/kept/${keptPlay.id}/subtitles`}
              />
            </div>
            <div className="viewer-top">
              <span className="viewer-name">{keptPlay.name}</span>
              <div className="viewer-tools">
                <a className="viewer-iconbtn" href={`/api/kept/${keptPlay.id}`} download={keptPlay.name} title="Download">
                  <Icon name="download" size={17} />
                </a>
                <button className="viewer-iconbtn" onClick={() => setKeptSubsOpen(true)} title="Add subtitle">
                  <Icon name="subtitles" size={17} />
                </button>
                <button
                  className="viewer-iconbtn"
                  onClick={() => {
                    const el = keptViewerRef.current;
                    if (!el) return;
                    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
                    else el.requestFullscreen?.().catch(() => {});
                  }}
                  title="Fullscreen (F)"
                >
                  <Icon name="expand" size={17} />
                </button>
                <span className="viewer-sep" />
                <button className="viewer-iconbtn" onClick={() => { setKeptPlay(null); setKeptSubsOpen(false); }} title="Close (Esc)">
                  <Icon name="close" size={17} />
                </button>
              </div>
            </div>
          </div>
          {keptSubsOpen && (
            <SubtitleDialog
              partId={0}
              subtitleBase={`/api/kept/${keptPlay.id}/subtitles`}
              localOnly
              onClose={() => setKeptSubsOpen(false)}
              onAdded={() => setKeptSubsBump((b) => b + 1)}
            />
          )}
        </>
      )}

    </div>
  );
}

