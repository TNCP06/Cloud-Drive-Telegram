"use client";

import { useEffect, useState, useTransition } from "react";
import { Icon } from "@/lib/icons";
import { TAG_COLORS } from "@/lib/kinds";
import type { Tag } from "@/lib/types";
import { createTag, renameTag, recolorTag, deleteTag } from "@/app/actions";

const PALETTE = Object.entries(TAG_COLORS);

export function TagManager({
  tags,
  counts,
  onClose,
}: {
  tags: Tag[];
  counts: Record<number, number>;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("slate");
  const [showNewSwatch, setShowNewSwatch] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Tag | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = () => {
    const n = newName.trim();
    if (!n) return;
    startTransition(() => createTag(n, newColor));
    setNewName("");
    setNewColor("slate");
    setShowNewSwatch(false);
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog">
        <div className="dhead">
          <div>
            <h2>Categories</h2>
            <p className="sub">Add, rename, recolour, or remove the labels for your archive.</p>
          </div>
          <button className="iconbtn ghost" onClick={onClose} title="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="dbody">
          {/* Create new */}
          <div className="tagmgr-new">
            <input
              className="input"
              placeholder="New category name…"
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
            <button
              type="button"
              className="iconbtn"
              style={{ width: 42, height: 42, flexShrink: 0 }}
              title="Pick colour"
              onClick={() => setShowNewSwatch((v) => !v)}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 5,
                  background: TAG_COLORS[newColor],
                  display: "block",
                }}
              ></span>
            </button>
            <button className="btn primary" style={{ height: 42 }} onClick={create} disabled={!newName.trim()}>
              <Icon name="plus" size={16} />
              Add
            </button>
          </div>

          {showNewSwatch && (
            <div className="swatches" style={{ padding: "10px 0 4px" }}>
              {PALETTE.map(([k, c]) => (
                <div
                  key={k}
                  className={"swatch" + (newColor === k ? " on" : "")}
                  style={{ background: c }}
                  title={k}
                  onClick={() => {
                    setNewColor(k);
                    setShowNewSwatch(false);
                  }}
                ></div>
              ))}
            </div>
          )}

          <div className="tagmgr-list scroll">
            {tags.map((t) => (
              <TagManagerRow
                key={t.id}
                tag={t}
                count={counts[t.id] || 0}
                onRename={(nm) => startTransition(() => renameTag(t.id, nm))}
                onRecolor={(c) => startTransition(() => recolorTag(t.id, c))}
                onDelete={() => setConfirmDel(t)}
              />
            ))}
            {tags.length === 0 && (
              <div className="tagmgr-empty">No categories yet. Create one above.</div>
            )}
          </div>
        </div>

        <div className="dfoot">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>

      {confirmDel && (
        <div
          className="overlay"
          style={{ zIndex: 310 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmDel(null);
          }}
        >
          <div className="dialog" style={{ maxWidth: 400 }}>
            <div className="dhead">
              <h2>Delete category</h2>
            </div>
            <div className="dbody">
              <p className="sub" style={{ fontSize: 14, lineHeight: 1.5 }}>
                &ldquo;{confirmDel.name}&rdquo; will be removed from all files. The files
                themselves are not deleted.
              </p>
            </div>
            <div className="dfoot">
              <button className="btn subtle" onClick={() => setConfirmDel(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  const id = confirmDel.id;
                  startTransition(() => deleteTag(id));
                  setConfirmDel(null);
                }}
              >
                <Icon name="trash" size={16} />
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TagManagerRow({
  tag,
  count,
  onRename,
  onRecolor,
  onDelete,
}: {
  tag: Tag;
  count: number;
  onRename: (name: string) => void;
  onRecolor: (color: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const [showSwatch, setShowSwatch] = useState(false);
  useEffect(() => setName(tag.name), [tag.name]);

  const commit = () => {
    const n = name.trim();
    if (n && n !== tag.name) onRename(n);
    else setName(tag.name);
    setEditing(false);
  };

  const c = TAG_COLORS[tag.color] || tag.color;

  return (
    <div>
      <div className="tagmgr-row">
        <button
          type="button"
          className="tag-dot"
          style={{ width: 14, height: 14, background: c, border: 0, cursor: "pointer", borderRadius: 5, flexShrink: 0 }}
          title="Change colour"
          onClick={() => setShowSwatch((v) => !v)}
        ></button>
        {editing ? (
          <input
            className="input"
            style={{ flex: 1, padding: "6px 9px" }}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setName(tag.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span
            className="nm"
            onClick={() => setEditing(true)}
            title="Click to rename"
            style={{ cursor: "text" }}
          >
            {tag.name}
          </span>
        )}
        <span className="ct">{count}</span>
        <button className="del" onClick={onDelete} title="Delete category">
          <Icon name="trash" size={16} />
        </button>
      </div>
      {showSwatch && (
        <div className="swatches" style={{ padding: "4px 8px 12px 35px" }}>
          {PALETTE.map(([k, cc]) => (
            <div
              key={k}
              className={"swatch" + (tag.color === k ? " on" : "")}
              style={{ background: cc }}
              title={k}
              onClick={() => {
                onRecolor(k);
                setShowSwatch(false);
              }}
            ></div>
          ))}
        </div>
      )}
    </div>
  );
}
