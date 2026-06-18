import type { CSSProperties } from "react";

// Set ikon line 24x24, stroke 1.6 (port dari Claude Design data.jsx).
const PATHS: Record<string, string> = {
  all: '<path d="M3 6h18M3 12h18M3 18h12"/>',
  recent: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  star: '<path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.78L12 17.9l-5.2 2.73 1-5.78-4.2-4.1 5.8-.85z"/>',
  trash:
    '<path d="M4 7h16M9.5 7V5.2c0-.66.54-1.2 1.2-1.2h2.6c.66 0 1.2.54 1.2 1.2V7M6.5 7l.8 12.1c.05.74.66 1.3 1.4 1.3h6.6c.74 0 1.35-.56 1.4-1.3L18 7"/>',
  tag: '<path d="M3.5 11.3V5.4c0-1 .8-1.9 1.9-1.9h5.9c.5 0 1 .2 1.3.6l7.3 7.3c.74.74.74 1.94 0 2.68l-5.6 5.6c-.74.74-1.94.74-2.68 0l-7.3-7.3c-.4-.36-.6-.83-.6-1.34z"/><circle cx="7.7" cy="7.7" r="1.4"/>',
  folder:
    '<path d="M3 7.5c0-1 .8-1.8 1.8-1.8h4l2 2.2h7.4c1 0 1.8.8 1.8 1.8v8.2c0 1-.8 1.8-1.8 1.8H4.8c-1 0-1.8-.8-1.8-1.8z"/>',
  image:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.4" cy="9.2" r="1.7"/><path d="M4 17l4.5-4.3c.7-.66 1.78-.66 2.48 0L17 18"/>',
  video: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.2"/><path d="M10 9.4l4.2 2.6-4.2 2.6z"/>',
  archive:
    '<rect x="4.5" y="3.8" width="15" height="16.4" rx="1.8"/><path d="M12 3.8v3M12 8.5v2M12 12.2h.01"/><path d="M10.7 12h2.6l-.4 3.4c-.06.5-.48.86-.98.86h.14c-.5 0-.92-.36-.98-.86z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.6-3.6"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4"/>',
  rows: '<rect x="4" y="5" width="16" height="3.4" rx="1.2"/><rect x="4" y="10.3" width="16" height="3.4" rx="1.2"/><rect x="4" y="15.6" width="16" height="3.4" rx="1.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 4.5v11M7.5 11L12 15.5 16.5 11M5 18.5h14"/>',
  upload: '<path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9M5 16.5v1.8c0 .9.7 1.7 1.7 1.7h10.6c1 0 1.7-.8 1.7-1.7v-1.8"/>',
  warn: '<path d="M12 3.5L1.7 20.5h20.6zM12 9.5v5M12 17.6h.01"/>',
  back: '<path d="M14.5 6l-6 6 6 6"/>',
  kebab: '<circle cx="12" cy="5.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="18.5" r="1.4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  chevdown: '<path d="M6 9.5l6 6 6-6"/>',
  chevright: '<path d="M9.5 6l6 6-6 6"/>',
  circle: '<circle cx="12" cy="12" r="8.5"/>',
  sort: '<path d="M5 8.5h9M5 12h6M5 15.5h3M16 7v10M16 17l2.5-2.5M16 17l-2.5-2.5"/>',
  cloud: '<path d="M6.5 18.5h10a3.8 3.8 0 00.6-7.55 5.3 5.3 0 00-10.2-1.2A3.7 3.7 0 006.5 18.5z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  restore: '<path d="M4.5 12a7.5 7.5 0 107.5-7.5c-2.5 0-4.7 1.2-6 3M4.5 4.5V7.5H7.5"/>',
  file: '<path d="M6 3.5h8L18.5 8v11.5c0 .55-.45 1-1 1h-11c-.55 0-1-.45-1-1v-15c0-.55.45-1 1-1z"/><path d="M14 3.5V8h4.5"/>',
  power: '<path d="M12 3.5v8" /><path d="M7.2 6.4a7 7 0 109.6 0"/>',
  home: '<path d="M4 11.2 12 4.6l8 6.6"/><path d="M6 10v9h12v-9"/>',
  drive: '<rect x="3.5" y="6.5" width="17" height="11" rx="2"/><path d="M6.5 14h7"/><circle cx="17" cy="14" r=".9" fill="currentColor" stroke="none"/>',
  edit: '<path d="M4 20h4l10.5-10.5a2 2 0 000-2.83l-1.17-1.17a2 2 0 00-2.83 0L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  refresh: '<path d="M4.5 12a7.5 7.5 0 107.5-7.5c-2.5 0-4.7 1.2-6 3M4.5 7.5v4h4"/>',
};

export function Icon({
  name,
  size = 18,
  stroke = 1.6,
  fill = false,
  style,
  className,
}: {
  name: string;
  size?: number;
  stroke?: number;
  fill?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const d = PATHS[name] || PATHS.file;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: d }}
    />
  );
}
