"use client";

import { Menu, MenuItem } from "./FileViews";
import {
  type LayoutMode,
  type LayoutPrefs,
  LAYOUT_ICON,
  LAYOUT_LABEL,
} from "@/lib/layoutPrefs";

// Windows-Explorer-style "View" menu: a single radio list of layouts, the details-pane
// toggle, and a "Show" group of on/off toggles. Mirrors the project's Sort menu idiom
// (labelled sections inside one panel) rather than a nested flyout, so every option is
// visible at once. Layout picks close the menu; toggles keep it open for quick tweaking.

const LAYOUT_ORDER: LayoutMode[] = [
  "xl", "large", "medium", "small", "list", "details", "tiles", "content",
];

export function ViewMenu({
  anchor,
  prefs,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  prefs: LayoutPrefs;
  onChange: (patch: Partial<LayoutPrefs>) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="menu-scrim" onClick={onClose} />
      <Menu anchor={anchor} onClose={onClose} align="right" width={244}>
        <div className="menu-label">Layout</div>
        {LAYOUT_ORDER.map((mode) => (
          <MenuItem
            key={mode}
            icon={LAYOUT_ICON[mode]}
            label={LAYOUT_LABEL[mode]}
            check={prefs.layout === mode}
            onClick={() => {
              onChange({ layout: mode });
              onClose();
            }}
          />
        ))}

        <div className="menu-sep" />
        <MenuItem
          icon="panelRight"
          label="Details pane"
          check={prefs.detailsPane}
          onClick={() => onChange({ detailsPane: !prefs.detailsPane })}
        />

        <div className="menu-sep" />
        <div className="menu-label">Show</div>
        <MenuItem
          icon="panelLeft"
          label="Sidebar"
          check={prefs.showSidebar}
          onClick={() => onChange({ showSidebar: !prefs.showSidebar })}
        />
        <MenuItem
          icon="compact"
          label="Compact view"
          check={prefs.compact}
          onClick={() => onChange({ compact: !prefs.compact })}
        />
        <MenuItem
          icon="checkbox"
          label="Item check boxes"
          check={prefs.showCheckboxes}
          onClick={() => onChange({ showCheckboxes: !prefs.showCheckboxes })}
        />
        <MenuItem
          icon="file"
          label="File name extensions"
          check={prefs.showExtensions}
          onClick={() => onChange({ showExtensions: !prefs.showExtensions })}
        />
        <MenuItem
          icon="all"
          label="Detail items"
          check={prefs.showDetailItems}
          onClick={() => onChange({ showDetailItems: !prefs.showDetailItems })}
        />
      </Menu>
    </>
  );
}
