"use client";

import { useMemo, useRef, useState } from "react";
import { Icon } from "@/lib/icons";
import { TAG_COLORS, tagColorKey } from "@/lib/kinds";
import type { Tag } from "@/lib/types";

// Chip-based tag editor. Replaces the old "comma-separated" text fields:
//  - pick existing categories from an autocomplete dropdown (no retyping),
//  - or type a new name and create it on the fly,
//  - remove a chip with × (or Backspace on an empty input).
// The value is kept as a comma-separated string so it stays compatible with the
// existing server actions (updateMetadata / enqueueUpload / processBotDrop).

const parseNames = (s: string): string[] =>
  Array.from(
    new Map(
      s
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => [t.toLowerCase(), t]) // dedupe case-insensitively, keep first casing
    ).values()
  );

export function TagPicker({
  value,
  onChange,
  suggestions,
  placeholder = "Add a category…",
}: {
  value: string;
  onChange: (next: string) => void;
  suggestions: Tag[];
  placeholder?: string;
}) {
  const selected = useMemo(() => parseNames(value), [value]);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState<number>(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const commit = (names: string[]) => onChange(names.join(", "));

  const has = (name: string) =>
    selected.some((s) => s.toLowerCase() === name.trim().toLowerCase());

  const add = (name: string) => {
    const n = name.trim();
    if (n && !has(n)) commit([...selected, n]);
    setDraft("");
    setHighlightIdx(-1);
  };
  const remove = (name: string) => commit(selected.filter((s) => s !== name));

  const q = draft.trim().toLowerCase();
  const matches = suggestions.filter(
    (t) => !has(t.name) && (!q || t.name.toLowerCase().includes(q))
  );
  const canCreate =
    q.length > 0 &&
    !suggestions.some((t) => t.name.toLowerCase() === q) &&
    !has(draft);

  const totalCount = matches.length + (canCreate ? 1 : 0);

  const scrollItemIntoView = (idx: number) => {
    requestAnimationFrame(() => {
      const items = menuRef.current?.querySelectorAll<HTMLElement>(".tagpick-opt");
      items?.[idx]?.scrollIntoView({ block: "nearest" });
    });
  };

  // Colour: reuse the stored tag's colour when it exists, else derive from name.
  const colorOf = (name: string) => {
    const t = suggestions.find((s) => s.name.toLowerCase() === name.toLowerCase());
    return TAG_COLORS[t ? t.color : tagColorKey(name)] || "#888";
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      if (!open) {
        setOpen(true);
        setHighlightIdx(0);
        scrollItemIntoView(0);
        return;
      }
      if (totalCount > 0) {
        e.preventDefault();
        const next = highlightIdx < 0 ? 0 : (highlightIdx + 1) % totalCount;
        setHighlightIdx(next);
        scrollItemIntoView(next);
      }
      return;
    }

    if (e.key === "ArrowUp") {
      if (open && totalCount > 0) {
        e.preventDefault();
        const prev = highlightIdx <= 0 ? totalCount - 1 : highlightIdx - 1;
        setHighlightIdx(prev);
        scrollItemIntoView(prev);
      }
      return;
    }

    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setHighlightIdx(-1);
      }
      return;
    }

    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (open && highlightIdx >= 0 && highlightIdx < totalCount) {
        if (highlightIdx < matches.length) {
          add(matches[highlightIdx].name);
        } else if (canCreate) {
          add(draft);
        }
        setOpen(false);
      } else if (draft.trim()) {
        add(draft);
        setOpen(false);
      }
    } else if (e.key === "Backspace" && !draft && selected.length) {
      remove(selected[selected.length - 1]);
    }
  };

  return (
    <div className="tagpick">
      <div className="tagpick-box" onClick={() => inputRef.current?.focus()}>
        {selected.map((name) => (
          <span
            key={name}
            className="tagpick-chip"
            style={{ ["--c" as string]: colorOf(name) }}
          >
            <i></i>
            {name}
            <button
              type="button"
              className="x"
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                remove(name);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={draft}
          placeholder={selected.length ? "" : placeholder}
          aria-autocomplete="list"
          aria-expanded={open}
          onChange={(e) => {
            setDraft(e.target.value);
            setHighlightIdx(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // Delay so a click on an option registers before the menu unmounts.
          onBlur={() => setTimeout(() => {
            setOpen(false);
            setHighlightIdx(-1);
          }, 140)}
          onKeyDown={onKeyDown}
        />
      </div>

      {open && totalCount > 0 && (
        <div ref={menuRef} className="tagpick-menu scroll" role="listbox" tabIndex={-1}>
          {matches.map((t, idx) => (
            <button
              type="button"
              key={t.id}
              role="option"
              aria-selected={highlightIdx === idx}
              className={"tagpick-opt" + (highlightIdx === idx ? " active" : "")}
              onMouseEnter={() => setHighlightIdx(idx)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                add(t.name);
                setOpen(false);
              }}
            >
              <span
                className="tag-dot"
                style={{ background: TAG_COLORS[t.color] || t.color }}
              ></span>
              <span className="nm">{t.name}</span>
            </button>
          ))}
          {canCreate && (
            <button
              type="button"
              role="option"
              aria-selected={highlightIdx === matches.length}
              className={"tagpick-opt create" + (highlightIdx === matches.length ? " active" : "")}
              onMouseEnter={() => setHighlightIdx(matches.length)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                add(draft);
                setOpen(false);
              }}
            >
              <Icon name="plus" size={14} />
              <span>
                Create &ldquo;{draft.trim()}&rdquo;
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
