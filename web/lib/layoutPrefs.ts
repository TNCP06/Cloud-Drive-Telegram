// Layout & view preferences for the drive grid (Windows-Explorer-style "View" menu).
// Persisted to localStorage so a chosen layout survives reloads, like the theme toggle.
// Pure module: callers read/save; React state (in DriveApp) is the single source of truth
// at runtime, and is hydrated from here after mount to avoid SSR mismatch.

import type { GroupKey } from "./driveView";

export type LayoutMode =
  | "xl" // Extra large icons
  | "large" // Large icons
  | "medium" // Medium icons (default)
  | "small" // Small icons
  | "list" // List (compact, column-flow names)
  | "details" // Details (sortable table)
  | "tiles" // Tiles (horizontal icon + name + type/size)
  | "content"; // Content (wide rows with metadata)

export type SortOrder = "asc" | "desc";

export interface LayoutPrefs {
  layout: LayoutMode;
  /** Show the left navigation sidebar (desktop). */
  showSidebar: boolean;
  /** Denser spacing (smaller rows/cards/gaps). */
  compact: boolean;
  /** Always show item check boxes (vs reveal on hover). */
  showCheckboxes: boolean;
  /** Append the file extension to the displayed (title-based) name. */
  showExtensions: boolean;
  /** Show per-card detail items (size/date/tags). Off = name only. */
  showDetailItems: boolean;
  /** Show the persistent right-hand details pane. */
  detailsPane: boolean;
  /** Active sort comparator key (one of `SORTS` in driveView). */
  sort: string;
  /** Sort direction for the active comparator. */
  sortOrder: SortOrder;
  /** Windows-Explorer-style section grouping. */
  groupBy: GroupKey;
  /** Collapse same-family archive versions into one representative card. */
  groupVersions: boolean;
  /** Per-folder layout preferences. Key is the folder ID (or 'root'), value is the layout mode. */
  folderLayouts: Record<string, LayoutMode>;
}

export const DEFAULT_PREFS: LayoutPrefs = {
  layout: "medium",
  showSidebar: true,
  compact: false,
  showCheckboxes: false,
  showExtensions: false,
  showDetailItems: true,
  detailsPane: false,
  sort: "modified",
  sortOrder: "desc",
  groupBy: "none",
  groupVersions: true,
  folderLayouts: {},
};

const VALID_GROUPS: GroupKey[] = ["none", "name", "type", "tag", "modified", "size"];
const VALID_SORTS = ["modified", "added", "name", "size", "kind"];

const KEY = "tcd_layout";

const VALID_LAYOUTS: LayoutMode[] = [
  "xl", "large", "medium", "small", "list", "details", "tiles", "content",
];

/** Read saved prefs (merged over defaults). Returns defaults on SSR / parse error. */
export function loadPrefs(): LayoutPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<LayoutPrefs>;
    const merged = { ...DEFAULT_PREFS, ...parsed, folderLayouts: parsed.folderLayouts || {} };
    if (!VALID_LAYOUTS.includes(merged.layout)) merged.layout = DEFAULT_PREFS.layout;
    if (!VALID_GROUPS.includes(merged.groupBy)) merged.groupBy = DEFAULT_PREFS.groupBy;
    if (!VALID_SORTS.includes(merged.sort)) merged.sort = DEFAULT_PREFS.sort;
    if (merged.sortOrder !== "asc" && merged.sortOrder !== "desc") merged.sortOrder = DEFAULT_PREFS.sortOrder;
    return merged;
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Best-effort persist (ignores quota / private-mode failures). */
export function savePrefs(prefs: LayoutPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore storage failures */
  }
}

/** Menu icon shown on the topbar "View" button for the active layout. */
export const LAYOUT_ICON: Record<LayoutMode, string> = {
  xl: "iconsXl",
  large: "iconsLg",
  medium: "iconsMd",
  small: "iconsSm",
  list: "viewList",
  details: "viewDetails",
  tiles: "viewTiles",
  content: "viewContent",
};

export const LAYOUT_LABEL: Record<LayoutMode, string> = {
  xl: "Gallery",
  large: "Large icons",
  medium: "Medium icons",
  small: "Small icons",
  list: "List",
  details: "Details",
  tiles: "Tiles",
  content: "Content",
};
