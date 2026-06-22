"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/lib/icons";
import type { DriveFile, Folder } from "@/lib/types";
import type { FolderStat } from "./DriveApp";

// Presentational modals + empty state extracted from DriveApp.tsx. Each is driven
// entirely by props (no DriveApp internals), so they live here to keep the shell lean.

export function ConfirmDelete({
  item,
  mode,
  onCancel,
  onConfirm,
}: {
  item: DriveFile;
  mode: "trash" | "purge";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const name = item.version ? item.family : item.name;
  const purge = mode === "purge";

  return (
    <div
      className="overlay"
      style={{ zIndex: 320 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="dialog" style={{ maxWidth: 420 }}>
        <div className="dhead">
          <h2>{purge ? "Delete permanently" : "Move to Trash"}</h2>
        </div>
        <div className="dbody">
          <p className="sub" style={{ fontSize: 14, lineHeight: 1.5 }}>
            {purge ? (
              <>
                &ldquo;{name}&rdquo; will be <strong>permanently deleted</strong> from the
                Telegram channel and the database right now. This cannot be undone.
              </>
            ) : (
              <>
                &ldquo;{name}&rdquo; will be moved to Trash. It is removed from Telegram
                automatically after 7 days; until then you can restore it.
              </>
            )}
          </p>
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm}>
            <Icon name="trash" size={16} />
            {purge ? "Delete forever" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmBulkDelete({
  itemCount,
  folderCount = 0,
  mode,
  onCancel,
  onConfirm,
}: {
  itemCount: number;
  folderCount?: number;
  mode: "trash" | "purge";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const purge = mode === "purge";
  // "3 folders and 5 items" / "5 items" / "3 folders" — whichever the selection holds.
  const parts: string[] = [];
  if (folderCount) parts.push(`${folderCount} folder${folderCount > 1 ? "s" : ""}`);
  if (itemCount) parts.push(`${itemCount} item${itemCount > 1 ? "s" : ""}`);
  const what = parts.join(" and ") || "items";

  return (
    <div
      className="overlay"
      style={{ zIndex: 320 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="dialog" style={{ maxWidth: 420 }}>
        <div className="dhead">
          <h2>{purge ? "Delete permanently" : "Move to Trash"}</h2>
        </div>
        <div className="dbody">
          <p className="sub" style={{ fontSize: 14, lineHeight: 1.5 }}>
            {purge ? (
              <>
                Are you sure you want to <strong>permanently delete {what}</strong> from the
                Telegram channel and the database right now? This cannot be undone.
              </>
            ) : (
              <>
                Are you sure you want to move <strong>{what}</strong> to Trash?{" "}
                {folderCount > 0 && "Folders are removed and the files inside them are trashed. "}
                Trashed files are automatically removed from Telegram after 7 days.
              </>
            )}
          </p>
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm}>
            <Icon name="trash" size={16} />
            {purge ? "Delete forever" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CreateFolderModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="overlay" style={{ zIndex: 330 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ maxWidth: 360 }}>
        <div className="dhead">
          <h2>New folder</h2>
        </div>
        <div className="dbody">
          <input
            className="input"
            style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--line-2)", borderRadius: "8px", background: "var(--card-2)", color: "var(--ink)" }}
            autoFocus
            placeholder="Folder name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && onCreate(name)}
          />
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => name.trim() && onCreate(name)} disabled={!name.trim()}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

export function RenameFolderModal({
  folder,
  onClose,
  onRename,
}: {
  folder: Folder;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(folder.name);
  return (
    <div className="overlay" style={{ zIndex: 330 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ maxWidth: 360 }}>
        <div className="dhead">
          <h2>Rename folder</h2>
        </div>
        <div className="dbody">
          <input
            className="input"
            style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--line-2)", borderRadius: "8px", background: "var(--card-2)", color: "var(--ink)" }}
            autoFocus
            placeholder="Folder name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && onRename(name)}
          />
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => name.trim() && onRename(name)} disabled={!name.trim() || name.trim() === folder.name}>
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}

export function MoveToFolderModal({
  folders,
  space = "main",
  moveItemIds = [],
  moveFolderIds = [],
  onClose,
  onMove,
  onMoveCrossSpace,
}: {
  folders: Folder[];
  space?: "main" | "private";
  moveItemIds?: number[];
  moveFolderIds?: number[];
  onClose: () => void;
  onMove: (folderId: number | null) => void;
  onMoveCrossSpace: () => void;
}) {
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);

  // When folders are being moved, exclude each moving folder and all its descendants as
  // targets (a folder can't be dropped into itself or its own subtree).
  const excluded = useMemo(() => {
    const set = new Set<number>();
    const collect = (pid: number) => {
      set.add(pid);
      folders.filter((f) => f.parentId === pid).forEach((c) => collect(c.id));
    };
    moveFolderIds.forEach(collect);
    return set;
  }, [moveFolderIds, folders]);

  const list = useMemo(() => {
    const folderList: { id: number | null; name: string; depth: number }[] = [
      { id: null, name: space === "private" ? "Private (Root)" : "All files (Root)", depth: 0 },
    ];
    const addChildren = (parentId: number | null, depth: number) => {
      const children = folders.filter((f) => f.parentId === parentId);
      for (const child of children) {
        if (excluded.has(child.id)) continue;
        folderList.push({ id: child.id, name: child.name, depth });
        addChildren(child.id, depth + 1);
      }
    };
    addChildren(null, 1);
    return folderList;
  }, [folders, excluded, space]);

  const crossLabel = space === "main" ? "Move to Private" : "Move to Main drive";
  const parts: string[] = [];
  if (moveFolderIds.length) parts.push(`${moveFolderIds.length} folder${moveFolderIds.length > 1 ? "s" : ""}`);
  if (moveItemIds.length) parts.push(`${moveItemIds.length} item${moveItemIds.length > 1 ? "s" : ""}`);
  const what = parts.join(" + ") || "items";

  return (
    <div className="overlay" style={{ zIndex: 330 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ maxWidth: 400 }}>
        <div className="dhead">
          <h2>Move {what} to folder</h2>
        </div>
        <div className="dbody" style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, padding: "8px 0" }}>
          {/* Cross-space destination (Main ⇄ Private) */}
          <button
            className="btn subtle"
            style={{
              textAlign: "left", paddingLeft: 12, display: "flex", alignItems: "center", gap: 8,
              border: "1px solid var(--line-2)", borderRadius: 6, width: "100%", marginBottom: 4,
              color: "var(--accent)", fontWeight: 600,
            }}
            onClick={onMoveCrossSpace}
          >
            <Icon name={space === "main" ? "lock" : "unlock"} size={16} />
            {crossLabel}
          </button>
          {list.map((item) => (
            <button
              key={item.id === null ? "root" : item.id}
              className="btn subtle"
              style={{
                textAlign: "left",
                paddingLeft: `${item.depth * 16 + 12}px`,
                fontWeight: selectedFolderId === item.id ? 600 : 400,
                background: selectedFolderId === item.id ? "var(--accent-soft)" : "transparent",
                color: selectedFolderId === item.id ? "var(--accent)" : "var(--ink)",
                border: "1px solid transparent",
                display: "flex",
                alignItems: "center",
                gap: 8,
                borderRadius: "6px",
                width: "100%",
              }}
              onClick={() => setSelectedFolderId(item.id)}
            >
              <Icon name="folder" size={16} />
              {item.name}
            </button>
          ))}
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onMove(selectedFolderId)}>
            Move
          </button>
        </div>
      </div>
    </div>
  );
}

// Client-only absolute date (avoids a tz hydration mismatch — these modals only ever
// render post-mount, but keep it consistent with DetailsPane).
function AbsDate({ ts }: { ts: number }) {
  const [s, setS] = useState("");
  useEffect(() => {
    setS(
      new Date(ts).toLocaleString("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    );
  }, [ts]);
  return <span suppressHydrationWarning>{s || "—"}</span>;
}

// Standalone folder "Properties" popup — total items + sub-folders inside, plus dates.
export function FolderDetailsModal({
  folder,
  stat,
  onClose,
  onOpen,
}: {
  folder: Folder;
  stat: FolderStat;
  onClose: () => void;
  onOpen: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="dp-field">
      <span className="dp-key">{label}</span>
      <span className="dp-val">{value}</span>
    </div>
  );

  return (
    <div className="overlay" style={{ zIndex: 330 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ maxWidth: 380 }}>
        <div className="dhead">
          <h2>Folder details</h2>
        </div>
        <div className="dbody">
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
            <div
              style={{
                width: 48, height: 48, flex: "none", borderRadius: 11, display: "grid", placeItems: "center",
                color: "var(--accent)", background: "color-mix(in oklab, var(--accent) 12%, var(--card-2))",
              }}
            >
              <Icon name="folder" size={26} stroke={1.5} />
            </div>
            <div className="dp-name" style={{ minWidth: 0, wordBreak: "break-word" }} title={folder.name}>
              {folder.name}
            </div>
          </div>
          <div className="dp-fields">
            <Row label="Type" value="Folder" />
            <Row label="Items" value={stat.items} />
            <Row label="Subfolders" value={stat.subfolders} />
            {(stat.directItems !== stat.items || stat.directSubfolders !== stat.subfolders) && (
              <Row
                label="Direct contents"
                value={`${stat.directSubfolders} folder${stat.directSubfolders === 1 ? "" : "s"} · ${stat.directItems} item${stat.directItems === 1 ? "" : "s"}`}
              />
            )}
            <Row label="Created" value={<AbsDate ts={folder.createdAt} />} />
            <Row label="Modified" value={<AbsDate ts={folder.updatedAt} />} />
          </div>
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={onOpen}>
            <Icon name="folder" size={16} />
            Open
          </button>
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ view, query }: { view: string; query: string }) {
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
