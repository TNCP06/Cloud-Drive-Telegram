"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/lib/icons";
import type { DriveFile, Folder } from "@/lib/types";

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
  count,
  mode,
  onCancel,
  onConfirm,
}: {
  count: number;
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
                Are you sure you want to <strong>permanently delete {count} items</strong> from the
                Telegram channel and the database right now? This cannot be undone.
              </>
            ) : (
              <>
                Are you sure you want to move <strong>{count} items</strong> to Trash? They will be
                automatically removed from Telegram after 7 days.
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
  onClose,
  onMove,
}: {
  folders: Folder[];
  onClose: () => void;
  onMove: (folderId: number | null) => void;
}) {
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);

  const list = useMemo(() => {
    const folderList: { id: number | null; name: string; depth: number }[] = [
      { id: null, name: "All files (Root)", depth: 0 }
    ];

    const addChildren = (parentId: number | null, depth: number) => {
      const children = folders.filter((f) => f.parentId === parentId);
      for (const child of children) {
        folderList.push({ id: child.id, name: child.name, depth });
        addChildren(child.id, depth + 1);
      }
    };

    addChildren(null, 1);
    return folderList;
  }, [folders]);

  return (
    <div className="overlay" style={{ zIndex: 330 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ maxWidth: 400 }}>
        <div className="dhead">
          <h2>Move items to folder</h2>
        </div>
        <div className="dbody" style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, padding: "8px 0" }}>
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
