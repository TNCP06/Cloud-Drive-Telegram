import type { Kind } from "./types";

// Tag colour palette — muted & earthy. The first 9 ("derivation set") are also used
// for auto-deriving a colour from a name; the rest are extra options for manual picking.
export const TAG_COLORS: Record<string, string> = {
  // --- derivation set (do NOT reorder/remove: changing it reshuffles derived colours) ---
  sage: "#5E7A52",
  ochre: "#B08526",
  clay: "#B0573A",
  slate: "#5C6E7E",
  teal: "#3C7A74",
  plum: "#7A546B",
  rose: "#A65656",
  indigo: "#5A5F8A",
  moss: "#74762F",
  // --- extra manual-pick options ---
  forest: "#3F6B4A",
  pine: "#2F6B5C",
  olive: "#6E7335",
  mustard: "#C29A33",
  copper: "#A8623A",
  brick: "#9C4636",
  mauve: "#8C6A8E",
  denim: "#41618C",
  steel: "#506B72",
  sand: "#9C7E55",
};

// Derivation uses only the original 9 keys so that adding new palette options above
// never changes the colour auto-derived for an existing tag (keeps colours stable).
const DERIVE_KEYS = ["sage", "ochre", "clay", "slate", "teal", "plum", "rose", "indigo", "moss"];

/** Deterministic name → colour key (stable across renders AND palette growth). */
export function tagColorKey(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return DERIVE_KEYS[h % DERIVE_KEYS.length];
}

// Metadata per kind: ikon (nama path di Icon), tint, label.
export const KINDS: Record<Kind, { icon: string; tint: string; label: string }> = {
  archive: { icon: "archive", tint: "#8A8068", label: "Archive" },
  media: { icon: "video", tint: "#A65656", label: "Media" },
};


