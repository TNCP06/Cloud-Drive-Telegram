// Formatting helpers for sizes and dates. Pure functions — safe to use on server & client.

/** Bytes to compact string (B/KB/MB/GB). */
export function fmtSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return bytes + " B";
  const kb = bytes / 1024;
  if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + " KB";
  const mb = kb / 1024;
  if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + " MB";
  const gb = mb / 1024;
  return (gb < 10 ? gb.toFixed(2) : gb.toFixed(1)) + " GB";
}

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) → epoch ms. */
export function sqliteToMs(s: string | null | undefined): number {
  if (!s) return 0;
  // datetime('now') in SQLite is always UTC without offset — append 'Z'.
  return new Date(s.replace(" ", "T") + "Z").getTime();
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDay)
    return "Today, " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  const diff = (now.getTime() - ts) / 86400000;
  if (diff < 7) return Math.floor(diff) + " days ago";
  return d.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

export function relGroup(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = (now.getTime() - ts) / 86400000;
  if (d.toDateString() === now.toDateString()) return "Today";
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  if (diff < 7) return "This week";
  if (diff < 30) return "This month";
  return "Older";
}

/** Days remaining before purge (deleted_at + 7 days). */
export function trashDaysLeft(deletedAtMs: number): number {
  const purge = deletedAtMs + 7 * 86400000;
  return Math.max(0, Math.ceil((purge - Date.now()) / 86400000));
}
