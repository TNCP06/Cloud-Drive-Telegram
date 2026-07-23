"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/lib/icons";
import { fmtSize } from "@/lib/format";
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

export function ConfirmRestore({
  itemCount,
  folderCount = 0,
  itemName,
  onCancel,
  onConfirm,
}: {
  itemCount: number;
  folderCount?: number;
  itemName?: string;
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

  let what = "";
  if (itemName) {
    what = `"${itemName}"`;
  } else {
    const parts: string[] = [];
    if (folderCount) parts.push(`${folderCount} folder${folderCount > 1 ? "s" : ""}`);
    if (itemCount) parts.push(`${itemCount} item${itemCount > 1 ? "s" : ""}`);
    what = parts.join(" and ") || "items";
  }

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
          <h2>Restore from Trash</h2>
        </div>
        <div className="dbody">
          <p className="sub" style={{ fontSize: 14, lineHeight: 1.5 }}>
            Are you sure you want to restore <strong>{what}</strong> from the Trash?
            {folderCount > 0 && " Folders and all the files inside them will be restored."}
          </p>
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={onConfirm}>
            <Icon name="restore" size={16} />
            Restore
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmEmptyTrash({
  onCancel,
  onConfirm,
}: {
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
          <h2>Empty Trash</h2>
        </div>
        <div className="dbody">
          <p className="sub" style={{ fontSize: 14, lineHeight: 1.5 }}>
            Are you sure you want to <strong>permanently delete all items and folders</strong> in the Trash?
            This cannot be undone.
          </p>
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm}>
            <Icon name="trash" size={16} />
            Empty Trash
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

export function UnpackModal({
  item,
  onClose,
  onUnpack,
}: {
  item: { name: string };
  onClose: () => void;
  onUnpack: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  return (
    <div className="overlay" style={{ zIndex: 330 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ maxWidth: 380 }}>
        <div className="dhead">
          <h2>Unpack archive</h2>
        </div>
        <div className="dbody">
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--ink-2)" }}>
            Extract “{item.name}” on the server and add its contents to your drive — videos become
            streamable. The original archive is kept.
          </p>
          <input
            className="input"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--line-2)", borderRadius: "8px", background: "var(--card-2)", color: "var(--ink)" }}
            autoFocus
            placeholder="Password (leave blank if none)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onUnpack(password)}
          />
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onUnpack(password)}>
            Unpack
          </button>
        </div>
      </div>
    </div>
  );
}

// Unpack outputs over the Telegram cap are kept on the VPS instead of re-uploaded. This lists
// them with play (Plyr modal) / download / keep-longer / manual-compress / delete-now controls;
// the unpack worker auto-deletes each file at its expiry.
const KEPT_VIDEO_RE = /\.(mp4|m4v|webm|mkv|mov)$/i;
const KEPT_IMAGE_RE = /\.(jpe?g|png|gif|webp)$/i;
const COMPRESS_PRESETS: { crf: number; label: string; desc: string }[] = [
  { crf: 20, label: "CRF 20 — archive quality", desc: "visually identical to the original; saves ~20–40%" },
  { crf: 23, label: "CRF 23 — balanced (recommended)", desc: "differences are near-impossible to spot in normal viewing; saves ~40–60%" },
  { crf: 26, label: "CRF 26 — small", desc: "fine detail (skin, grain, grass) softens slightly; saves ~55–70%" },
  { crf: 28, label: "CRF 28 — smallest", desc: "visibly softer, may block up in fast motion; saves ~65–80%" },
];

export function KeptFilesModal({
  files,
  onClose,
  onDelete,
  onExtend,
  onPlay,
  onCompress,
  onUploadToTelegram,
}: {
  files: {
    id: number; name: string; size: number; expiresAt: string;
    compress: { status: string; message: string; crf: number } | null;
  }[];
  onClose: () => void;
  onDelete: (id: number) => void;
  onExtend: (id: number, hours: number | null) => void;
  onPlay: (f: { id: number; name: string }) => void;
  onCompress: (id: number, crf: number) => void;
  onUploadToTelegram?: (id: number) => void;
}) {
  return (
    <div className="overlay" style={{ zIndex: 330 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ maxWidth: 480 }}>
        <div className="dhead">
          <h2>Files kept on server</h2>
        </div>
        <div className="dbody">
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--ink-2)" }}>
            Unpacked or downloaded files over 2 GB are stored on the server. Once compressed or if under 2 GB,
            you can upload them directly to Telegram to index them on the drive.
          </p>
          {files.length === 0 && (
            <p style={{ margin: 0, fontSize: 13, color: "var(--faint)" }}>Nothing kept right now.</p>
          )}
          {files.map((f) => {
            const busy = f.compress && ["queued", "running"].includes(f.compress.status);
            const canUpload = f.size <= 2000 * 1024 * 1024 && !busy;
            return (
              <div key={f.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line-2)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.name}>
                      {f.name}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--faint)" }}>
                      {fmtSize(f.size)} ·{" "}
                      {f.expiresAt.startsWith("9999")
                        ? "kept until you delete it"
                        : `expires ${f.expiresAt} UTC`}
                    </div>
                  </div>
                  <select
                    className="input"
                    style={{ width: 104, padding: "4px 6px", fontSize: 12 }}
                    value=""
                    title="Keep this file longer"
                    onChange={(e) => {
                      const v = e.target.value;
                      e.target.value = "";
                      if (v) onExtend(f.id, v === "inf" ? null : Number(v));
                    }}
                  >
                    <option value="">Keep for…</option>
                    <option value="72">3 more days</option>
                    <option value="168">7 more days</option>
                    <option value="720">30 more days</option>
                    <option value="inf">Until I delete it</option>
                  </select>
                  {canUpload && onUploadToTelegram && (
                    <button
                      className="btn subtle"
                      style={{ color: "var(--accent)" }}
                      title="Upload to Telegram Drive & index on website"
                      onClick={() => onUploadToTelegram(f.id)}
                    >
                      <Icon name="upload" size={15} />
                    </button>
                  )}
                  {KEPT_VIDEO_RE.test(f.name) && (
                    <button className="btn subtle" title="Play" onClick={() => onPlay(f)}>
                      <Icon name="video" size={15} />
                    </button>
                  )}
                  {KEPT_IMAGE_RE.test(f.name) && (
                    <a className="btn subtle" title="Open" href={`/api/kept/${f.id}`} target="_blank" rel="noopener noreferrer">
                      <Icon name="video" size={15} />
                    </a>
                  )}
                  <a className="btn subtle" title="Download" href={`/api/kept/${f.id}`} download={f.name}>
                    <Icon name="download" size={15} />
                  </a>
                  <button className="btn subtle" title="Delete from server now" onClick={() => onDelete(f.id)}>
                    <Icon name="trash" size={15} />
                  </button>
                </div>
                {KEPT_VIDEO_RE.test(f.name) && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                    {busy ? (
                      <span style={{ fontSize: 12, color: "var(--accent)" }}>
                        <span className="spinner sm" style={{ verticalAlign: -2, marginRight: 6 }} />
                        {f.compress?.message || "compressing…"}
                      </span>
                    ) : (
                      <>
                        <select
                          className="input"
                          style={{ width: 230, padding: "4px 6px", fontSize: 12 }}
                          value=""
                          title="Re-encode this file on the server to shrink it"
                          onChange={(e) => {
                            const v = e.target.value;
                            e.target.value = "";
                            if (v) onCompress(f.id, Number(v));
                          }}
                        >
                          <option value="">Compress…</option>
                          {COMPRESS_PRESETS.map((p) => (
                            <option key={p.crf} value={p.crf}>{p.label}</option>
                          ))}
                        </select>
                        {f.compress && (
                          <span style={{ fontSize: 12, color: f.compress.status === "failed" ? "var(--red, #d03b3b)" : "var(--faint)" }}>
                            {f.compress.message}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <details style={{ marginTop: 12, fontSize: 12, color: "var(--faint)" }}>
            <summary style={{ cursor: "pointer" }}>What do the compress presets mean?</summary>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
              {COMPRESS_PRESETS.map((p) => (
                <li key={p.crf}><b>{p.label}</b>: {p.desc}</li>
              ))}
            </ul>
            <p style={{ margin: "8px 0 0" }}>
              Compression runs on the server CPU (roughly 0.5–1× the video&apos;s duration), replaces
              the file in place, and keeps the original only if the result isn&apos;t smaller.
            </p>
          </details>
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onClose}>
            Close
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
      const children = folders.filter((f) => f.parentId === parentId && !f.trashed);
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
