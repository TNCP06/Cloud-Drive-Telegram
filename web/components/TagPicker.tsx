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
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (names: string[]) => onChange(names.join(", "));

  const has = (name: string) =>
    selected.some((s) => s.toLowerCase() === name.trim().toLowerCase());

  const add = (name: string) => {
    const n = name.trim();
    if (n && !has(n)) commit([...selected, n]);
    setDraft("");
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

  // Colour: reuse the stored tag's colour when it exists, else derive from name.
  const colorOf = (name: string) => {
    const t = suggestions.find((s) => s.name.toLowerCase() === name.toLowerCase());
    return TAG_COLORS[t ? t.color : tagColorKey(name)] || "#888";
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (draft.trim()) add(draft);
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
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // Delay so a click on an option registers before the menu unmounts.
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
      </div>

      {open && (matches.length > 0 || canCreate) && (
        <div className="tagpick-menu scroll">
          {matches.map((t) => (
            <button
              type="button"
              key={t.id}
              className="tagpick-opt"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(t.name)}
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
              className="tagpick-opt create"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(draft)}
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
