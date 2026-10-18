"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/lib/icons";
import { fmtSize } from "@/lib/format";
import { listDir } from "@/app/actions/filesystem";
import type { FsListing } from "@/lib/types";

// Laptop file browser modal. Returns the ABSOLUTE PATH to the caller.
// mode "dir"  → select a folder (for archives)
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
  const [focusedIdx, setFocusedIdx] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);
  const typeAheadBufferRef = useRef("");
  const typeAheadTimeRef = useRef(0);

  const load = useCallback((p?: string) => {
    setLoading(true);
    listDir(p)
      .then((l) => {
        setListing(l);
        setFocusedIdx(0);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pick = useCallback((p: string) => {
    onPick(p);
    onClose();
  }, [onPick, onClose]);

  const scrollItemIntoView = (idx: number) => {
    requestAnimationFrame(() => {
      const items = listRef.current?.querySelectorAll<HTMLElement>(".fsb-row");
      items?.[idx]?.scrollIntoView({ block: "nearest" });
      items?.[idx]?.focus({ preventScroll: true });
    });
  };

  // Keyboard navigation
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }

    if ((e.key === "Backspace" || (e.key === "ArrowUp" && e.altKey)) && listing?.parent) {
      e.preventDefault();
      load(listing.parent);
      return;
    }

    const entries = listing?.entries || [];
    if (!entries.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextIdx = (focusedIdx + 1) % entries.length;
      setFocusedIdx(nextIdx);
      scrollItemIntoView(nextIdx);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const prevIdx = focusedIdx <= 0 ? entries.length - 1 : focusedIdx - 1;
      setFocusedIdx(prevIdx);
      scrollItemIntoView(prevIdx);
      return;
    }

    if (e.key === "Home") {
      e.preventDefault();
      setFocusedIdx(0);
      scrollItemIntoView(0);
      return;
    }

    if (e.key === "End") {
      e.preventDefault();
      const lastIdx = entries.length - 1;
      setFocusedIdx(lastIdx);
      scrollItemIntoView(lastIdx);
      return;
    }

    if (e.key === "Enter") {
      const en = entries[focusedIdx];
      if (en) {
        e.preventDefault();
        if (en.isDir) {
          load(en.path);
        } else if (mode === "file") {
          pick(en.path);
        }
      }
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
        const startIdx = (focusedIdx + 1) % entries.length;
        for (let i = 0; i < entries.length; i++) {
          const idx = (startIdx + i) % entries.length;
          if (entries[idx].name.toLowerCase().startsWith(effectiveChar)) {
            matchIdx = idx;
            break;
          }
        }
      } else {
        matchIdx = entries.findIndex((en) => en.name.toLowerCase().startsWith(q));
      }

      if (matchIdx !== -1) {
        e.preventDefault();
        setFocusedIdx(matchIdx);
        scrollItemIntoView(matchIdx);
      }
    }
  };

  return (
    <div className="fsb-overlay" onClick={onClose} onKeyDown={onKeyDown}>
      <div className="fsb" onClick={(e) => e.stopPropagation()}>
        <div className="fsb-head">
          <div className="fsb-title">
            <Icon name={mode === "dir" ? "folder" : "file"} size={18} />
            {mode === "dir" ? "Select a folder on the laptop" : "Select a file on the laptop"}
          </div>
          <button className="fsb-x" onClick={onClose} aria-label="Close" title="Close (Esc)">
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
          <button className="fsb-up" disabled={!listing?.parent} onClick={() => listing?.parent && load(listing.parent)} title="Up one level (Alt+Up or Backspace)">
            <Icon name="back" size={15} /> Up
          </button>
          <span className="fsb-cwd" title={listing?.cwd}>{listing?.cwd ?? "…"}</span>
          <button className="fsb-up" onClick={() => load(listing?.cwd)} title="Reload">
            <Icon name="restore" size={14} />
          </button>
        </div>

        <div
          ref={listRef}
          className="fsb-list scroll"
          role="listbox"
          aria-label="Files and folders"
          tabIndex={0}
        >
          {loading ? (
            <div className="fsb-state"><span className="spinner" /> Loading…</div>
          ) : listing?.error ? (
            <div className="fsb-state err">{listing.error}</div>
          ) : listing && listing.entries.length === 0 ? (
            <div className="fsb-state">Empty folder.</div>
          ) : (
            listing?.entries.map((en, idx) => (
              <div
                key={en.path}
                role="option"
                aria-selected={focusedIdx === idx}
                tabIndex={focusedIdx === idx ? 0 : -1}
                className={"fsb-row" + (en.isDir ? "" : " isfile") + (focusedIdx === idx ? " active" : "")}
                onClick={() => {
                  setFocusedIdx(idx);
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
