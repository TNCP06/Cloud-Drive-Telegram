"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/lib/icons";
import { fmtSize } from "@/lib/format";
import { listDir } from "@/app/fs-actions";
import type { FsListing } from "@/lib/types";

// Laptop file browser modal. Returns the ABSOLUTE PATH to the caller.
// mode "dir"  → select a folder (for games)
// mode "file" → select a single file (for media)
export function FsBrowser({
  mode,
  onPick,
  onClose,
}: {
  mode: "dir" | "file";
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback((p?: string) => {
    setLoading(true);
    listDir(p)
      .then((l) => setListing(l))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = (p: string) => {
    onPick(p);
    onClose();
  };

  return (
    <div className="fsb-overlay" onClick={onClose}>
      <div className="fsb" onClick={(e) => e.stopPropagation()}>
        <div className="fsb-head">
          <div className="fsb-title">
            <Icon name={mode === "dir" ? "folder" : "file"} size={18} />
            {mode === "dir" ? "Select a folder on the laptop" : "Select a file on the laptop"}
          </div>
          <button className="fsb-x" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="fsb-shortcuts">
          {listing?.shortcuts.map((s) => (
            <button key={s.path} className="fsb-chip" onClick={() => load(s.path)} title={s.path}>
              <Icon name={s.label.endsWith(":\\") ? "drive" : s.label === "Home" ? "home" : "folder"} size={13} />
              {s.label}
            </button>
          ))}
        </div>

        <div className="fsb-bar">
          <button className="fsb-up" disabled={!listing?.parent} onClick={() => listing?.parent && load(listing.parent)}>
            <Icon name="back" size={15} /> Up
          </button>
          <span className="fsb-cwd" title={listing?.cwd}>{listing?.cwd ?? "…"}</span>
          <button className="fsb-up" onClick={() => load(listing?.cwd)} title="Reload">
            <Icon name="restore" size={14} />
          </button>
        </div>

        <div className="fsb-list scroll">
          {loading ? (
            <div className="fsb-state"><span className="spinner" /> Loading…</div>
          ) : listing?.error ? (
            <div className="fsb-state err">{listing.error}</div>
          ) : listing && listing.entries.length === 0 ? (
            <div className="fsb-state">Empty folder.</div>
          ) : (
            listing?.entries.map((en) => (
              <div
                key={en.path}
                className={"fsb-row" + (en.isDir ? "" : " isfile")}
                onClick={() => {
                  if (en.isDir) load(en.path);
                  else if (mode === "file") pick(en.path);
                }}
                onDoubleClick={() => {
                  if (en.isDir && mode === "dir") pick(en.path);
                }}
              >
                <Icon name={en.isDir ? "folder" : "file"} size={17} className="fsb-ico" />
                <span className="fsb-name">{en.name}</span>
                {!en.isDir && <span className="fsb-size">{fmtSize(en.size)}</span>}
                {en.isDir && mode === "dir" && (
                  <button
                    className="fsb-pick"
                    onClick={(e) => {
                      e.stopPropagation();
                      pick(en.path);
                    }}
                  >
                    Select
                  </button>
                )}
                {en.isDir && <Icon name="chevright" size={15} className="fsb-chev" />}
              </div>
            ))
          )}
        </div>

        <div className="fsb-foot">
          {mode === "dir" && listing?.cwd && (
            <button className="btn primary" onClick={() => pick(listing.cwd)}>
              <Icon name="check" size={15} /> Select this folder
            </button>
          )}
          <button className="btn subtle" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
