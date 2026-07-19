"use client";

import { useEffect } from "react";
import { lockPrivate } from "@/app/actions";

// Guarantees the Private space re-locks whenever it's left by ANY means — not only the in-app exit
// button (DriveApp.exitPrivate). Without this the session unlock cookie persists across a browser
// back / tab close, so a later /private visit would skip the PIN. Two exit paths are covered:
//   • SPA navigation (browser back, in-app link) → React unmounts this → cleanup calls lockPrivate.
//   • Full-page unload (tab close, hard reload, URL change) → pagehide fires a sendBeacon that hits
//     /api/private/lock (cleanup can't reliably flush a server-action fetch during unload).
// Mounting never locks (only cleanup/pagehide do), so the unlock → router.refresh() round-trip is
// safe; router.refresh keeps this instance mounted, so ordinary server-action refreshes don't lock.
export function PrivateAutoLock() {
  useEffect(() => {
    const beacon = () => navigator.sendBeacon?.("/api/private/lock");
    window.addEventListener("pagehide", beacon);
    return () => {
      window.removeEventListener("pagehide", beacon);
      lockPrivate();
    };
  }, []);
  return null;
}
