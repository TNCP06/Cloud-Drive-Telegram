"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@/lib/icons";
import { fmtSize } from "@/lib/format";
import { useUpload, type LocalItem } from "@/components/UploadProvider";

// Floating, draggable-free upload monitor shown on every page (except /upload, which
// has the full manager). Reads the global UploadProvider state so the user can see
// browser→VPS progress anywhere and expand to inspect each file. Styled to match the
// app's card/popup surfaces.
export function FloatingUploadPanel() {
  const pathname = usePathname();
  const { items, speed, runQueue, removeLocal, clearDone } = useUpload();
  const [open, setOpen] = useState(true);
  // Two tabs: "process" (in-flight + queued + failed) and "done" (handed off to Telegram).
  const [tab, setTab] = useState<"process" | "done">("process");

  // The /upload page already renders the full queue — don't double up there.
  if (pathname?.startsWith("/upload")) return null;
  if (items.length === 0) return null;

  const uploading = items.filter((i) => i.stage === "uploading");
  const active = items.filter(
    (i) => i.stage === "uploading" || i.stage === "ready" || i.stage === "finalizing"
  );
  const done = items.filter((i) => i.stage === "done");
  const errored = items.filter((i) => i.stage === "error");
  // Everything that isn't finished living under the "Process" tab.
  const processItems = items.filter((i) => i.stage !== "done");
  // Auto-fall back to the tab that actually has rows (e.g. once all uploads complete).
  const effectiveTab: "process" | "done" =
    tab === "process" && processItems.length === 0 && done.length > 0 ? "done" : tab;
  const shown = effectiveTab === "done" ? done : processItems;

  const totalBytes = uploading.reduce((s, i) => s + i.size, 0);
  const sentBytes = uploading.reduce((s, i) => s + i.sent, 0);
  const overallPct =
    uploading.length > 0 && totalBytes > 0
      ? Math.floor((sentBytes / totalBytes) * 100)
      : active.length === 0
      ? 100
      : 0;

  const headline =
    uploading.length > 0
      ? `Uploading ${active.length} file${active.length > 1 ? "s" : ""}`
      : errored.length > 0 && active.length === 0
      ? `${errored.length} upload${errored.length > 1 ? "s" : ""} failed`
      : active.length > 0
      ? `${active.length} queued`
      : "Uploads complete";

  const allDone = active.length === 0 && errored.length === 0;

  return (
    <div className={"fup" + (open ? " open" : "")}>
      <button className="fup-head" onClick={() => setOpen((v) => !v)}>
        <span className="fup-head-ic">
          {allDone ? (
            <Icon name="check" size={16} />
          ) : errored.length > 0 && uploading.length === 0 ? (
            <Icon name="warn" size={16} />
          ) : (
            <span className="spinner sm" />
          )}
        </span>
        <span className="fup-head-txt">
          <span className="fup-title">{headline}</span>
          {uploading.length > 0 && (
            <span className="fup-sub">
              {overallPct}%{speed > 0 ? ` · ${fmtSize(speed)}/s` : ""}
            </span>
          )}
          {uploading.length === 0 && done.length > 0 && (
            <span className="fup-sub">{done.length} done · queued to Telegram</span>
          )}
        </span>
        <span className="fup-chev">
          <Icon name={open ? "chevdown" : "chevup"} size={16} />
        </span>
      </button>

      {uploading.length > 0 && (
        <div className="fup-topbar">
          <span style={{ width: overallPct + "%" }} />
        </div>
      )}

      {open && (
        <>
          <div className="fup-tabs">
            <button
              className={"fup-tab" + (effectiveTab === "process" ? " on" : "")}
              onClick={() => setTab("process")}
            >
              Process{processItems.length > 0 ? ` (${processItems.length})` : ""}
            </button>
            <button
              className={"fup-tab" + (effectiveTab === "done" ? " on" : "")}
              onClick={() => setTab("done")}
            >
              Completed{done.length > 0 ? ` (${done.length})` : ""}
            </button>
          </div>
          <div className="fup-body scroll">
            {shown.length === 0 ? (
              <div className="fup-empty">
                {effectiveTab === "done" ? "No completed uploads yet." : "Nothing in progress."}
              </div>
            ) : (
              shown.map((it) => (
                <FloatingRow
                  key={it.id}
                  item={it}
                  onRetry={() => runQueue()}
                  onRemove={() => removeLocal(it.id)}
                />
              ))
            )}
            {effectiveTab === "done" && done.length > 0 && (
              <button className="fup-clear" onClick={clearDone}>
                <Icon name="check" size={14} /> Clear {done.length} completed
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FloatingRow({
  item,
  onRetry,
  onRemove,
}: {
  item: LocalItem;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const pct = item.size ? Math.floor((item.sent / item.size) * 100) : 0;
  const label =
    item.stage === "ready"
      ? "Queued"
      : item.stage === "uploading"
      ? `${pct}%`
      : item.stage === "finalizing" || item.stage === "done"
      ? "Queued → Telegram"
      : "Failed";

  return (
    <div className="fup-row">
      <span className={"fup-dot st-" + item.stage} />
      <div className="fup-row-main">
        <div className="fup-row-name" title={item.name}>
          {item.title || item.name}
        </div>
        {item.stage === "uploading" && (
          <div className="fup-row-bar">
            <span style={{ width: pct + "%" }} />
          </div>
        )}
        <div className="fup-row-meta">
          {item.stage === "uploading"
            ? `${fmtSize(item.sent)} / ${fmtSize(item.size)}`
            : `${label} · ${fmtSize(item.size)}`}
        </div>
      </div>
      {item.stage === "error" && (
        <button className="fup-row-btn" onClick={onRetry} title="Retry">
          <Icon name="upload" size={14} />
        </button>
      )}
      {(item.stage === "error" || item.stage === "done") && (
        <button className="fup-row-btn" onClick={onRemove} title="Remove">
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
