"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/lib/icons";

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

  return (
    <button
      className="iconbtn ghost"
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
    >
      <Icon name={dark ? "sun" : "moon"} size={18} />
    </button>
  );
}
