"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/lib/icons";
import { SHORTCUTS, withShortcut } from "@/lib/shortcuts";

// Light/dark toggle. The actual theme is applied pre-paint by an inline script in
// layout.tsx (reads localStorage 'tcd_theme' or the OS preference) so there's no
// flash; this button just flips the data-theme attribute and persists the choice.
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.dataset.theme === "dark");
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    const t = next ? "dark" : "light";
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("tcd_theme", t);
    } catch {
      /* ignore storage failures (private mode) */
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement as HTMLElement | null;
      const typing = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
      if (!typing && e.altKey && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dark]);

  return (
    <button
      className="iconbtn ghost"
      onClick={toggle}
      title={withShortcut(dark ? "Switch to light mode" : "Switch to dark mode", SHORTCUTS.toggleTheme)}
      aria-label="Toggle theme"
    >
      <Icon name={dark ? "sun" : "moon"} size={18} />
    </button>
  );
}
