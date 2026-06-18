import type { Kind } from "./types";

// Palet warna tag — muted & earthy (dari desain Claude Design).
export const TAG_COLORS: Record<string, string> = {
  sage: "#5E7A52",
  ochre: "#B08526",
  clay: "#B0573A",
  slate: "#5C6E7E",
  teal: "#3C7A74",
  plum: "#7A546B",
  rose: "#A65656",
  indigo: "#5A5F8A",
  moss: "#74762F",
};

const COLOR_KEYS = Object.keys(TAG_COLORS);

/** Pemetaan deterministik nama tag → key warna (stabil antar render). */
export function tagColorKey(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return COLOR_KEYS[h % COLOR_KEYS.length];
}

// Metadata per kind: ikon (nama path di Icon), tint, label.
export const KINDS: Record<Kind, { icon: string; tint: string; label: string }> = {
  archive: { icon: "archive", tint: "#8A8068", label: "Archive" },
  media: { icon: "video", tint: "#A65656", label: "Media" },
};


