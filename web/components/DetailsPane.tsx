"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { Icon } from "@/lib/icons";
import { Chip } from "./FileViews";
import { fileTypeFor, displayName } from "@/lib/fileType";
import { fmtSize } from "@/lib/format";
import type { DriveFile, Tag } from "@/lib/types";

// Persistent right-hand details panel (Windows "Details pane"). Shows metadata for the
// single selected item without hijacking the card click (which still opens the viewer).
// 0 or >1 selected → a hint. Absolute dates render client-only to avoid a tz hydration
// mismatch (the pane is desktop-only and off by default, so it's already post-mount).

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="dp-field">
      <span className="dp-key">{label}</span>
      <span className="dp-val">{children}</span>
    </div>
  );
}

export function DetailsPane({
  item,
  tags,
  showExtensions = false,
  onClose,
}: {
  item: DriveFile | null;
  tags: Tag[];
  showExtensions?: boolean;
  onClose: () => void;
}) {
  const ft = item ? fileTypeFor(item) : null;
  const itemTags = item
    ? (item.tags.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[])
    : [];

  return (
    <aside className="details-pane">
      <div className="dp-head">
        <span>Details</span>
        <button className="dp-close" onClick={onClose} title="Hide details pane">
          <Icon name="close" size={16} />
        </button>
      </div>

      {!item || !ft ? (
        <div className="dp-empty">
          <Icon name="panelRight" size={30} stroke={1.4} />
          <p>Select a single item to see its details</p>
        </div>
      ) : (
        <div className="dp-body scroll">
          <div className="dp-preview" style={{ background: `color-mix(in oklab, ${ft.tint} 9%, var(--card-2))` }}>
            {item.thumb ? (
              <Image src={item.thumb} alt="" fill unoptimized style={{ objectFit: "cover" }} />
            ) : (
              <Icon name={ft.icon} size={56} stroke={1.4} style={{ color: ft.tint }} />
            )}
          </div>

          <div className="dp-name" title={item.name}>
            {displayName(item, showExtensions)}
          </div>
          {item.version && <div className="dp-sub">{item.version}</div>}

          <div className="dp-fields">
            <Field label="Type">{ft.label}</Field>
            <Field label="Size">{fmtSize(item.size)}</Field>
            {item.parts > 1 && <Field label="Parts">{item.parts}</Field>}
            <Field label="Modified">
              <AbsDate ts={item.modified} />
            </Field>
            <Field label="Added">
              <AbsDate ts={item.added} />
            </Field>
            {(item.starred || item.trashed) && (
              <Field label="Status">
                {item.trashed ? "In Trash" : "Favorite"}
              </Field>
            )}
            <Field label="Tags">
              {itemTags.length > 0 ? (
                <span className="dp-tags">
                  {itemTags.map((t) => (
                    <Chip key={t.id} tag={t} />
                  ))}
                </span>
              ) : (
                <span className="dp-faint">None</span>
              )}
            </Field>
          </div>
        </div>
      )}
    </aside>
  );
}
