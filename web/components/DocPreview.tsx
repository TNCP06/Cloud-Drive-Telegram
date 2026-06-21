"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/lib/icons";
import type { FileType } from "@/lib/fileType";
import { fmtSize } from "@/lib/format";

// Inline document preview for single-part files. PDFs render in a native <iframe>;
// text/code is fetched and shown as <pre>; Word (.docx) is converted to HTML with
// mammoth and spreadsheets (.xlsx/.csv/…) to HTML tables with SheetJS — both libs are
// dynamically imported so they are only downloaded when a matching file is opened.

// Don't auto-fetch huge files into memory. PDFs stream natively (no cap needed).
const MAX_TEXT_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_OFFICE_BYTES = 30 * 1024 * 1024; // 30 MB

// Range bytes=0- forces the streamer to return the WHOLE file in both serving modes
// (a plain GET returns only the first chunk in Telethon-fallback mode).
async function fetchPart(partId: number): Promise<Response> {
  const resp = await fetch(`/api/stream/${partId}`, {
    headers: { Range: "bytes=0-" },
  });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`Failed to load file (HTTP ${resp.status}).`);
  }
  return resp;
}

export function DocPreview({
  partId,
  ft,
  size,
  onDownload,
}: {
  partId: number;
  ft: FileType;
  size: number;
  onDownload?: () => void;
}) {
  // PDF needs no JS fetch — the browser streams it through the <iframe>.
  if (ft.preview === "pdf") {
    return (
      <div className="doc-preview">
        <iframe
          className="doc-frame"
          src={`/api/stream/${partId}#toolbar=1&navpanes=0`}
          title="PDF preview"
        />
      </div>
    );
  }
  if (ft.preview === "text") {
    return <TextPreview partId={partId} size={size} ft={ft} onDownload={onDownload} />;
  }
  if (ft.preview === "word") {
    return <WordPreview partId={partId} size={size} ft={ft} onDownload={onDownload} />;
  }
  if (ft.preview === "sheet") {
    return <SheetPreview partId={partId} size={size} ft={ft} onDownload={onDownload} />;
  }
  return <NoPreview ft={ft} size={size} onDownload={onDownload} />;
}

/* ---- shared shells ---- */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="doc-preview doc-center">
      <div className="doc-msg">{children}</div>
    </div>
  );
}

function Loading() {
  return (
    <Centered>
      <span className="spinner" />
      <p>Loading preview…</p>
    </Centered>
  );
}

function NoPreview({
  ft,
  size,
  onDownload,
  reason,
}: {
  ft: FileType;
  size: number;
  onDownload?: () => void;
  reason?: string;
}) {
  return (
    <Centered>
      <Icon name={ft.icon} size={84} stroke={1.2} style={{ color: ft.tint }} />
      <p>{reason ?? `No inline preview for ${ft.label} files.`}</p>
      <p className="doc-sub">{fmtSize(size)}</p>
      {onDownload && (
        <button className="btn primary" onClick={onDownload}>
          <Icon name="download" size={16} />
          Download
        </button>
      )}
    </Centered>
  );
}

/* ---- text / code ---- */
function TextPreview({
  partId,
  size,
  ft,
  onDownload,
}: {
  partId: number;
  size: number;
  ft: FileType;
  onDownload?: () => void;
}) {
  const [state, setState] = useState<{ text?: string; error?: string; loading: boolean }>({
    loading: true,
  });

  useEffect(() => {
    if (size > MAX_TEXT_BYTES) {
      setState({ loading: false });
      return;
    }
    let alive = true;
    setState({ loading: true });
    fetchPart(partId)
      .then((r) => r.text())
      .then((text) => alive && setState({ text, loading: false }))
      .catch((e) => alive && setState({ error: String(e.message ?? e), loading: false }));
    return () => {
      alive = false;
    };
  }, [partId, size]);

  if (size > MAX_TEXT_BYTES) {
    return <NoPreview ft={ft} size={size} onDownload={onDownload} reason="File too large to preview." />;
  }
  if (state.loading) return <Loading />;
  if (state.error) return <NoPreview ft={ft} size={size} onDownload={onDownload} reason={state.error} />;
  return (
    <div className="doc-preview doc-scroll">
      <pre className="doc-text">{state.text}</pre>
    </div>
  );
}

/* ---- Word (.docx) ---- */
function WordPreview({
  partId,
  size,
  ft,
  onDownload,
}: {
  partId: number;
  size: number;
  ft: FileType;
  onDownload?: () => void;
}) {
  const [state, setState] = useState<{ html?: string; error?: string; loading: boolean }>({
    loading: true,
  });

  useEffect(() => {
    if (size > MAX_OFFICE_BYTES) {
      setState({ loading: false });
      return;
    }
    let alive = true;
    setState({ loading: true });
    (async () => {
      try {
        const resp = await fetchPart(partId);
        const buf = await resp.arrayBuffer();
        const mammoth = await import("mammoth/mammoth.browser.js");
        const result = await mammoth.convertToHtml({ arrayBuffer: buf });
        if (alive) setState({ html: result.value || "<p><em>Empty document.</em></p>", loading: false });
      } catch (e) {
        if (alive) setState({ error: e instanceof Error ? e.message : String(e), loading: false });
      }
    })();
    return () => {
      alive = false;
    };
  }, [partId, size]);

  if (size > MAX_OFFICE_BYTES) {
    return <NoPreview ft={ft} size={size} onDownload={onDownload} reason="File too large to preview." />;
  }
  if (state.loading) return <Loading />;
  if (state.error || !state.html) {
    return <NoPreview ft={ft} size={size} onDownload={onDownload} reason={state.error ?? "Could not render document."} />;
  }
  return (
    <div className="doc-preview doc-scroll">
      <div className="doc-paper" dangerouslySetInnerHTML={{ __html: state.html }} />
    </div>
  );
}

/* ---- Spreadsheet (.xlsx/.xls/.csv/…) ---- */
function SheetPreview({
  partId,
  size,
  ft,
  onDownload,
}: {
  partId: number;
  size: number;
  ft: FileType;
  onDownload?: () => void;
}) {
  const [state, setState] = useState<{
    sheets?: { name: string; html: string }[];
    error?: string;
    loading: boolean;
  }>({ loading: true });
  const [active, setActive] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (size > MAX_OFFICE_BYTES) {
      setState({ loading: false });
      return;
    }
    let alive = true;
    setState({ loading: true });
    (async () => {
      try {
        const resp = await fetchPart(partId);
        const buf = await resp.arrayBuffer();
        const XLSX = await import("xlsx");
        const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
        const sheets = wb.SheetNames.map((name) => ({
          name,
          html: XLSX.utils.sheet_to_html(wb.Sheets[name], { id: "" }),
        }));
        if (alive) setState({ sheets, loading: false });
      } catch (e) {
        if (alive) setState({ error: e instanceof Error ? e.message : String(e), loading: false });
      }
    })();
    return () => {
      alive = false;
    };
  }, [partId, size]);

  // Reset scroll when switching sheet tabs.
  useEffect(() => {
    bodyRef.current?.scrollTo(0, 0);
  }, [active]);

  if (size > MAX_OFFICE_BYTES) {
    return <NoPreview ft={ft} size={size} onDownload={onDownload} reason="File too large to preview." />;
  }
  if (state.loading) return <Loading />;
  if (state.error || !state.sheets || state.sheets.length === 0) {
    return <NoPreview ft={ft} size={size} onDownload={onDownload} reason={state.error ?? "Could not render spreadsheet."} />;
  }

  const sheets = state.sheets;
  const cur = sheets[Math.min(active, sheets.length - 1)];
  return (
    <div className="doc-preview doc-sheet">
      {sheets.length > 1 && (
        <div className="doc-tabs">
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              className={"doc-tab" + (i === active ? " on" : "")}
              onClick={() => setActive(i)}
              title={s.name}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="doc-scroll doc-sheet-body" ref={bodyRef}>
        <div className="doc-grid" dangerouslySetInnerHTML={{ __html: cur.html }} />
      </div>
    </div>
  );
}
