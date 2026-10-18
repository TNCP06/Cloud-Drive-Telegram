"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Icon } from "@/lib/icons";
import { unlockPrivate } from "@/app/actions";
import { getShortcutsGrouped } from "@/lib/shortcuts";
import type { DriveFile, Folder } from "@/lib/types";
import type { FolderStat } from "./DriveApp";

// Presentational modals + empty state extracted from DriveApp.tsx. Each is driven
// entirely by props (no DriveApp internals), so they live here to keep the shell lean.

function useDialogFocusTrap(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const focusables = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );

    if (!el.contains(document.activeElement)) {
      const auto = el.querySelector<HTMLElement>("[autofocus]") ?? focusables()[0];
      auto?.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [ref]);
}

export function ConfirmDelete({
  item,
  mode,
  onCancel,
  onConfirm,
}: {
  item: DriveFile;
  mode: "trash" | "purge";
  onCancel: () => void;
  onConfirm: (targetIds?: number[]) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef);
  const hasVariants = Boolean(item.variants && item.variants.length > 1);
  const [allVariants, setAllVariants] = useState(true);

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
      <div ref={dialogRef} className="dialog" style={{ maxWidth: 420 }}>
        <div className="dhead">
          <h2>{purge ? "Delete permanently" : "Move to trash"}</h2>
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
          {hasVariants && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 12,
                fontSize: 13,
                cursor: "pointer",
                color: "var(--fg)",
              }}
            >
              <input
                type="checkbox"
                checked={allVariants}
                onChange={(e) => setAllVariants(e.target.checked)}
              />
              <span>
                {purge ? "Delete all resolutions" : "Move all resolutions to trash"} ({item.variants!.length} files)
              </span>
            </label>
          )}
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button
            className="btn danger"
            onClick={() => {
              if (hasVariants && allVariants) {
                onConfirm(item.variants!.map((v) => v.id));
              } else {
                onConfirm([item.id]);
              }
            }}
          >
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef);

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
      <div ref={dialogRef} className="dialog" style={{ maxWidth: 420 }}>
        <div className="dhead">
          <h2>{purge ? "Delete permanently" : "Move to trash"}</h2>
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
          <button className="btn subtle" onClick={onCancel} autoFocus>
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef);

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
      <div ref={dialogRef} className="dialog" style={{ maxWidth: 420 }}>
        <div className="dhead">
          <h2>Restore from trash</h2>
        </div>
        <div className="dbody">
          <p className="sub" style={{ fontSize: 14, lineHeight: 1.5 }}>
            Are you sure you want to restore <strong>{what}</strong> from the Trash?
            {folderCount > 0 && " Folders and all the files inside them will be restored."}
          </p>
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onCancel} autoFocus>
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef);

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
      <div ref={dialogRef} className="dialog" style={{ maxWidth: 420 }}>
        <div className="dhead">
          <h2>Empty trash</h2>
        </div>
        <div className="dbody">
          <p className="sub" style={{ fontSize: 14, lineHeight: 1.5 }}>
            Are you sure you want to <strong>permanently delete all items and folders</strong> in the Trash?
            This cannot be undone.
          </p>
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm}>
            <Icon name="trash" size={16} />
            Empty trash
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef);
  const [name, setName] = useState("");
  return (
    <div className="overlay" style={{ zIndex: 330 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="dialog" style={{ maxWidth: 360 }}>
        <div className="dhead">
          <h2>New folder</h2>
        </div>
        <div className="dbody">
          <input
            className="input"
            style={{ width: "100%", padding: "9px 12px", borderRadius: "8px" }}
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef);
  const [name, setName] = useState(folder.name);
  return (
    <div className="overlay" style={{ zIndex: 330 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="dialog" style={{ maxWidth: 360 }}>
        <div className="dhead">
          <h2>Rename folder</h2>
        </div>
        <div className="dbody">
          <input
            className="input"
            style={{ width: "100%", padding: "9px 12px", borderRadius: "8px" }}
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef);
  const [password, setPassword] = useState("");
  return (
    <div className="overlay" style={{ zIndex: 330 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="dialog" style={{ maxWidth: 380 }}>
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
            style={{ width: "100%", padding: "9px 12px", borderRadius: "8px" }}
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

  const crossLabel = space === "main" ? "Move to private" : "Move to main drive";
  const parts: string[] = [];
  if (moveFolderIds.length) parts.push(`${moveFolderIds.length} folder${moveFolderIds.length > 1 ? "s" : ""}`);
  if (moveItemIds.length) parts.push(`${moveItemIds.length} item${moveItemIds.length > 1 ? "s" : ""}`);
  const what = parts.join(" + ") || "items";

  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeAheadBufferRef = useRef("");
  const typeAheadTimeRef = useRef(0);
  useDialogFocusTrap(dialogRef);

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Handle arrow keys, Home, End, Enter, and Type-Ahead within the folder list
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const curIdx = list.findIndex((item) => item.id === selectedFolderId);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % list.length;
      setSelectedFolderId(list[nextIdx].id);
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button.folder-opt");
      buttons?.[nextIdx]?.focus({ preventScroll: true });
      buttons?.[nextIdx]?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const prevIdx = curIdx <= 0 ? list.length - 1 : curIdx - 1;
      setSelectedFolderId(list[prevIdx].id);
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button.folder-opt");
      buttons?.[prevIdx]?.focus({ preventScroll: true });
      buttons?.[prevIdx]?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (e.key === "Home") {
      e.preventDefault();
      setSelectedFolderId(list[0].id);
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button.folder-opt");
      buttons?.[0]?.focus({ preventScroll: true });
      buttons?.[0]?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (e.key === "End") {
      e.preventDefault();
      const lastIdx = list.length - 1;
      setSelectedFolderId(list[lastIdx].id);
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button.folder-opt");
      buttons?.[lastIdx]?.focus({ preventScroll: true });
      buttons?.[lastIdx]?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      onMove(selectedFolderId);
      return;
    }

    // Type-ahead jump navigation (a-z, 0-9)
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && /^[a-z0-9]$/i.test(e.key)) {
      const char = e.key.toLowerCase();
      const now = Date.now();
      if (now - typeAheadTimeRef.current > 600) {
        typeAheadBufferRef.current = char;
      } else {
        typeAheadBufferRef.current += char;
      }
      typeAheadTimeRef.current = now;

      const q = typeAheadBufferRef.current;
      const isSingleCharCycle = q.length > 1 && q.split("").every((c) => c === q[0]);
      const effectiveChar = isSingleCharCycle ? q[0] : null;

      let matchIdx = -1;
      if (effectiveChar) {
        const startIdx = curIdx >= 0 ? (curIdx + 1) % list.length : 0;
        for (let i = 0; i < list.length; i++) {
          const idx = (startIdx + i) % list.length;
          if (list[idx].name.toLowerCase().startsWith(effectiveChar)) {
            matchIdx = idx;
            break;
          }
        }
      } else {
        matchIdx = list.findIndex((item) => item.name.toLowerCase().startsWith(q));
      }

      if (matchIdx !== -1) {
        e.preventDefault();
        setSelectedFolderId(list[matchIdx].id);
        const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button.folder-opt");
        buttons?.[matchIdx]?.focus({ preventScroll: true });
        buttons?.[matchIdx]?.scrollIntoView({ block: "nearest" });
      }
    }
  };

  return (
    <div className="overlay" style={{ zIndex: 330 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="dialog" style={{ maxWidth: 400 }}>
        <div className="dhead">
          <h2>Move {what} to folder</h2>
        </div>
        <div
          ref={listRef}
          className="dbody scroll"
          tabIndex={-1}
          role="region"
          aria-label="Folder destinations"
          onKeyDown={onListKeyDown}
          style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, padding: "8px 0", outline: "none" }}
        >
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
              className="btn subtle folder-opt"
              tabIndex={selectedFolderId === item.id ? 0 : -1}
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

// Compact PIN prompt for cross-space moves started from Main while Private is locked.
// Same 6-digit auto-submit keypad as PrivateLock; a correct PIN sets the unlock cookie
// server-side and fires onUnlock so the queued move can proceed without a page reload.
export function PinPromptModal({
  title,
  onClose,
  onUnlock,
}: {
  title: string;
  onClose: () => void;
  onUnlock: () => void;
}) {
  const PIN_LENGTH = 6;
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  const pinRef = useRef("");
  pinRef.current = pin;

  const submit = (value: string) => {
    if (value.length !== PIN_LENGTH || pending) return;
    startTransition(async () => {
      const res = await unlockPrivate(value);
      if (res.ok) onUnlock();
      else {
        setError(true);
        setPin("");
        pinRef.current = "";
        setTimeout(() => setError(false), 600);
      }
    });
  };

  const press = (d: string) => {
    if (pending || pinRef.current.length >= PIN_LENGTH) return;
    setError(false);
    const next = pinRef.current + d;
    pinRef.current = next;
    setPin(next);
    if (next.length === PIN_LENGTH) submit(next);
  };
  const back = () => {
    const next = pinRef.current.slice(0, -1);
    pinRef.current = next;
    setPin(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") {
        e.preventDefault();
        press(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        back();
      } else if (e.key === "Enter") {
        e.preventDefault();
        submit(pinRef.current);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="overlay" style={{ zIndex: 340 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ maxWidth: 300 }}>
        <div className="dhead">
          <h2>{title}</h2>
        </div>
        <div className="dbody" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <Icon name="lock" size={22} />
          <div className="pin-dots" style={{ margin: 0 }}>
            {Array.from({ length: PIN_LENGTH }).map((_, i) => (
              <span key={i} className={"pin-dot" + (i < pin.length ? " filled" : "")} />
            ))}
          </div>
          <div className="pin-pad">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => (
              <button key={k} type="button" className="pin-key" onClick={() => press(k)} disabled={pending}>
                {k}
              </button>
            ))}
            <button type="button" className="pin-key ghost" onClick={back} disabled={pending} aria-label="Delete">
              <Icon name="backspace" size={22} />
            </button>
            <button type="button" className="pin-key" onClick={() => press("0")} disabled={pending}>
              0
            </button>
            <button
              type="button"
              className="pin-key accent"
              onClick={() => submit(pin)}
              disabled={pending || pin.length !== PIN_LENGTH}
              aria-label="Unlock"
            >
              <Icon name="check" size={22} />
            </button>
          </div>
          {error && <div className="pin-error">Incorrect PIN</div>}
        </div>
        <div className="dfoot">
          <button className="btn subtle" onClick={onClose}>
            Cancel
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

export function KeyboardShortcutsModal({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const body = scrollRef.current;
      if (!body) return;

      // Enable keyboard scrolling through shortcuts list
      if (e.key === "PageDown") {
        e.preventDefault();
        body.scrollBy({ top: body.clientHeight * 0.8, behavior: "smooth" });
      } else if (e.key === "PageUp") {
        e.preventDefault();
        body.scrollBy({ top: -body.clientHeight * 0.8, behavior: "smooth" });
      } else if (e.key === "Home" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        body.scrollTo({ top: 0, behavior: "smooth" });
      } else if (e.key === "End" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        body.scrollBy({ top: 40, behavior: "smooth" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        body.scrollBy({ top: -40, behavior: "smooth" });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shortcuts = useMemo(() => getShortcutsGrouped(), []);

  return (
    <div className="overlay" onClick={onClose}>
      <div ref={dialogRef} className="dialog scroll" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="dhead">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="command" size={18} style={{ color: "var(--accent)" }} />
            <h3 style={{ margin: 0 }}>Keyboard shortcuts</h3>
          </div>
          <button className="iconbtn ghost" style={{ cursor: "pointer" }} onClick={onClose} title="Close (Esc)">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div
          ref={scrollRef}
          tabIndex={0}
          role="region"
          aria-label="Keyboard shortcuts list"
          autoFocus
          className="dbody scroll"
          style={{ padding: "14px 20px 20px", outline: "none" }}
        >
          {shortcuts.map((sec) => (
            <div key={sec.category} style={{ marginBottom: 18 }}>
              <h4 style={{ margin: "0 0 10px", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--faint)" }}>
                {sec.category}
              </h4>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sec.list.map((item) => (
                  <div key={item.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 13, flexWrap: "wrap" }}>
                    <span style={{ color: "var(--muted)", flex: 1, minWidth: 160 }}>{item.desc}</span>
                    <kbd
                      style={{
                        background: "var(--card-2)",
                        border: "1px solid var(--line-2)",
                        borderRadius: 5,
                        padding: "2px 7px",
                        fontSize: 11.5,
                        fontFamily: "var(--ui)",
                        fontWeight: 600,
                        color: "var(--ink)",
                        boxShadow: "0 1px 1px rgba(0,0,0,0.06)",
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {item.key}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
