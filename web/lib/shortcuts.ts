/**
 * Centralized Keyboard Shortcuts Registry
 * All keyboard shortcuts, labels, descriptions, and tooltip formatters are defined here.
 * Any future modifications to shortcuts can be adjusted in this single file.
 */

export interface ShortcutDef {
  id: string;
  key: string;            // Key identifier or representation
  label: string;          // Compact label for tooltips & menus, e.g. "F2", "Shift+D", "/"
  fullLabel?: string;     // Detailed label for help modal, e.g. "I or Alt+Enter"
  desc: string;           // Human-readable description
  category: "nav" | "actions" | "media";
}

export const SHORTCUTS = {
  // Navigation & selection
  arrowNav: {
    id: "arrowNav",
    key: "ArrowKeys",
    label: "Arrows",
    fullLabel: "Arrow Keys",
    desc: "Move focus & selection between items",
    category: "nav",
  },
  ctrlArrowNav: {
    id: "ctrlArrowNav",
    key: "Ctrl+Arrows",
    label: "Ctrl+Arrows",
    desc: "Move focus cursor only (leave selection)",
    category: "nav",
  },
  shiftArrowNav: {
    id: "shiftArrowNav",
    key: "Shift+Arrows",
    label: "Shift+Arrows",
    desc: "Select range of items",
    category: "nav",
  },
  quickLook: {
    id: "quickLook",
    key: " ",
    label: "Space",
    desc: "Quick Look preview or open folder",
    category: "nav",
  },
  toggleSelect: {
    id: "toggleSelect",
    key: "Ctrl+Space",
    label: "Ctrl+Space",
    desc: "Toggle selection of focused item",
    category: "nav",
  },
  open: {
    id: "open",
    key: "Enter",
    label: "Enter",
    desc: "Open folder or preview selected file",
    category: "nav",
  },
  back: {
    id: "back",
    key: "Backspace",
    label: "Backspace",
    fullLabel: "Backspace / Alt+Left",
    desc: "Step back or go up to parent folder",
    category: "nav",
  },
  parentFolder: {
    id: "parentFolder",
    key: "Alt+ArrowUp",
    label: "Alt+Up",
    fullLabel: "Alt + ArrowUp",
    desc: "Go up one level to parent folder",
    category: "nav",
  },
  selectAll: {
    id: "selectAll",
    key: "a",
    label: "Ctrl+A",
    fullLabel: "Ctrl / Cmd + A",
    desc: "Select all visible files and folders",
    category: "nav",
  },
  escape: {
    id: "escape",
    key: "Escape",
    label: "Esc",
    fullLabel: "Escape",
    desc: "Clear selection, close modals, or reset search",
    category: "nav",
  },
  typeAhead: {
    id: "typeAhead",
    key: "a-z / 0-9",
    label: "a-z / 0-9",
    desc: "Jump to matching file or folder by typing",
    category: "nav",
  },

  // File actions & layout
  rename: {
    id: "rename",
    key: "F2",
    label: "F2",
    desc: "Rename selected file or folder",
    category: "actions",
  },
  details: {
    id: "details",
    key: "Alt+Enter",
    label: "Alt+Enter",
    fullLabel: "Alt + Enter  or  Shift+I",
    desc: "Open details & metadata panel",
    category: "actions",
  },
  move: {
    id: "move",
    key: "Shift+M",
    label: "Shift+M",
    desc: "Move selected items to folder",
    category: "actions",
  },
  download: {
    id: "download",
    key: "d",
    label: "Shift+D",
    desc: "Download selected items",
    category: "actions",
  },
  delete: {
    id: "delete",
    key: "Delete",
    label: "Del",
    fullLabel: "Delete",
    desc: "Move to trash (or purge in trash view)",
    category: "actions",
  },
  purge: {
    id: "purge",
    key: "Delete",
    label: "Shift+Del",
    fullLabel: "Shift + Delete",
    desc: "Permanently delete without trash",
    category: "actions",
  },
  star: {
    id: "star",
    key: "Shift+S",
    label: "Shift+S",
    desc: "Toggle favorite / star on selected items",
    category: "actions",
  },
  layoutXl: {
    id: "layoutXl",
    key: "Alt+1",
    label: "Alt+1",
    desc: "Switch view: Gallery",
    category: "actions",
  },
  layoutLarge: {
    id: "layoutLarge",
    key: "Alt+2",
    label: "Alt+2",
    desc: "Switch view: Large Icons",
    category: "actions",
  },
  layoutGrid: {
    id: "layoutLarge",
    key: "Alt+2",
    label: "Alt+2",
    desc: "Switch view: Large Icons",
    category: "actions",
  },
  layoutMedium: {
    id: "layoutMedium",
    key: "Alt+3",
    label: "Alt+3",
    desc: "Switch view: Medium Icons",
    category: "actions",
  },
  layoutSmall: {
    id: "layoutSmall",
    key: "Alt+4",
    label: "Alt+4",
    desc: "Switch view: Small Icons",
    category: "actions",
  },
  layoutList: {
    id: "layoutList",
    key: "Alt+5",
    label: "Alt+5",
    desc: "Switch view: List",
    category: "actions",
  },
  layoutDetails: {
    id: "layoutDetails",
    key: "Alt+6",
    label: "Alt+6",
    desc: "Switch view: Details",
    category: "actions",
  },
  layoutTiles: {
    id: "layoutTiles",
    key: "Alt+7",
    label: "Alt+7",
    desc: "Switch view: Tiles",
    category: "actions",
  },
  layoutContent: {
    id: "layoutContent",
    key: "Alt+8",
    label: "Alt+8",
    desc: "Switch view: Content",
    category: "actions",
  },
  search: {
    id: "search",
    key: "/",
    label: "/ or Ctrl+K",
    fullLabel: "Ctrl + K  or  /",
    desc: "Focus search bar",
    category: "actions",
  },
  shortcutsHelp: {
    id: "shortcutsHelp",
    key: "?",
    label: "?",
    desc: "Show keyboard shortcuts help",
    category: "actions",
  },
  togglePrivate: {
    id: "togglePrivate",
    key: "Alt+P",
    label: "Alt+P",
    desc: "Open or exit Private space",
    category: "actions",
  },
  toggleTheme: {
    id: "toggleTheme",
    key: "Alt+T",
    label: "Alt+T",
    desc: "Switch between dark and light mode",
    category: "actions",
  },

  // Media & preview viewer
  viewerPrevNext: {
    id: "viewerPrevNext",
    key: "ArrowLeft / ArrowRight",
    label: "Left / Right",
    fullLabel: "Left / Right Arrow",
    desc: "Previous / next photo or video part",
    category: "media",
  },
  viewerFullscreen: {
    id: "viewerFullscreen",
    key: "f",
    label: "F",
    desc: "Toggle full screen viewer",
    category: "media",
  },
  viewerFilmstrip: {
    id: "viewerFilmstrip",
    key: "e",
    label: "E",
    desc: "Expand / collapse filmstrip panel",
    category: "media",
  },
  viewerLoop: {
    id: "viewerLoop",
    key: "p",
    label: "P",
    desc: "Toggle video looping mode",
    category: "media",
  },
} as const satisfies Record<string, ShortcutDef>;

export type ShortcutKey = keyof typeof SHORTCUTS;

/**
 * Appends a shortcut label to a title tooltip string.
 * Example: withShortcut("Rename", SHORTCUTS.rename) => "Rename (F2)"
 */
export function withShortcut(baseTitle: string, shortcut?: ShortcutDef | string | null): string {
  if (!shortcut) return baseTitle;
  const label = typeof shortcut === "string" ? shortcut : shortcut.label;
  return `${baseTitle} (${label})`;
}

function displayKey(def: { label: string; fullLabel?: string }): string {
  return def.fullLabel || def.label;
}

/**
 * Returns grouped shortcuts for the Help modal.
 */
export function getShortcutsGrouped() {
  return [
    {
      category: "Navigation & selection",
      list: [
        { key: displayKey(SHORTCUTS.arrowNav), desc: SHORTCUTS.arrowNav.desc },
        { key: displayKey(SHORTCUTS.ctrlArrowNav), desc: SHORTCUTS.ctrlArrowNav.desc },
        { key: displayKey(SHORTCUTS.shiftArrowNav), desc: SHORTCUTS.shiftArrowNav.desc },
        { key: displayKey(SHORTCUTS.quickLook), desc: SHORTCUTS.quickLook.desc },
        { key: displayKey(SHORTCUTS.toggleSelect), desc: SHORTCUTS.toggleSelect.desc },
        { key: displayKey(SHORTCUTS.open), desc: SHORTCUTS.open.desc },
        { key: displayKey(SHORTCUTS.back), desc: SHORTCUTS.back.desc },
        { key: displayKey(SHORTCUTS.parentFolder), desc: SHORTCUTS.parentFolder.desc },
        { key: displayKey(SHORTCUTS.selectAll), desc: SHORTCUTS.selectAll.desc },
        { key: displayKey(SHORTCUTS.typeAhead), desc: SHORTCUTS.typeAhead.desc },
        { key: displayKey(SHORTCUTS.escape), desc: SHORTCUTS.escape.desc },
      ],
    },
    {
      category: "File actions & layout",
      list: [
        { key: displayKey(SHORTCUTS.rename), desc: SHORTCUTS.rename.desc },
        { key: displayKey(SHORTCUTS.details), desc: SHORTCUTS.details.desc },
        { key: displayKey(SHORTCUTS.move), desc: SHORTCUTS.move.desc },
        { key: displayKey(SHORTCUTS.download), desc: SHORTCUTS.download.desc },
        { key: displayKey(SHORTCUTS.delete), desc: SHORTCUTS.delete.desc },
        { key: displayKey(SHORTCUTS.star), desc: SHORTCUTS.star.desc },
        { key: "Alt+1 .. Alt+8", desc: "Switch view: Gallery, Large, Medium, Small, List, Details, Tiles, Content" },
        { key: displayKey(SHORTCUTS.search), desc: SHORTCUTS.search.desc },
        { key: displayKey(SHORTCUTS.togglePrivate), desc: SHORTCUTS.togglePrivate.desc },
        { key: displayKey(SHORTCUTS.toggleTheme), desc: SHORTCUTS.toggleTheme.desc },
        { key: displayKey(SHORTCUTS.shortcutsHelp), desc: SHORTCUTS.shortcutsHelp.desc },
      ],
    },
    {
      category: "Media & preview viewer",
      list: [
        { key: displayKey(SHORTCUTS.viewerPrevNext), desc: SHORTCUTS.viewerPrevNext.desc },
        { key: displayKey(SHORTCUTS.viewerFullscreen), desc: SHORTCUTS.viewerFullscreen.desc },
        { key: displayKey(SHORTCUTS.viewerFilmstrip), desc: SHORTCUTS.viewerFilmstrip.desc },
        { key: displayKey(SHORTCUTS.viewerLoop), desc: SHORTCUTS.viewerLoop.desc },
      ],
    },
  ];
}
