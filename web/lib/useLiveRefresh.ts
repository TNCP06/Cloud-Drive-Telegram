"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

type Options = {
  /** Debounce window for coalescing bursty events (default 400ms). */
  debounceMs?: number;
  /**
   * Extra gate for a refresh (e.g. skip while an optimistic mutation is mid-flight so it can't
   * clobber in-progress client state). Returning false skips the refresh; absent = always allow.
   */
  canRefresh?: () => boolean;
};

/**
 * Subscribe to the shared `/api/events` SSE stream and `router.refresh()` on the named event, so
 * writes from the bot / history-index / other browser sessions appear live without polling.
 *
 * Hardened for flaky and mobile networks — the source of the console's `ERR_QUIC_PROTOCOL_ERROR`
 * (`QUIC_NETWORK_IDLE_TIMEOUT` / `QUIC_TOO_MANY_RTOS`) and `ERR_NAME_NOT_RESOLVED` spam on
 * `/api/events`:
 *   - Holds a connection ONLY while the tab is visible AND the device is online. A backgrounded
 *     tab closes its socket (so it can't sit idle until the transport times out) and an offline
 *     tab opens none (so it can't retry into unresolvable DNS). Both are the dominant error
 *     sources, and the bare browser `EventSource` does neither.
 *   - On a stream error it takes over reconnection with capped exponential backoff instead of the
 *     browser's tight built-in retry (which hammers a dead/flaky link), resetting on a clean open.
 *   - Reconnects and does an immediate catch-up `router.refresh()` on focus / regained visibility /
 *     coming back online, covering anything missed while the stream was down.
 */
export function useLiveRefresh(
  eventName: string,
  { debounceMs = 400, canRefresh }: Options = {},
) {
  const router = useRouter();
  // Keep the latest predicate without re-subscribing the stream on every render.
  const canRefreshRef = useRef(canRefresh);
  canRefreshRef.current = canRefresh;

  useEffect(() => {
    let es: EventSource | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;

    const isVisible = () => document.visibilityState === "visible";
    const allowed = () => canRefreshRef.current?.() ?? true;

    const refreshSoon = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        if (isVisible() && allowed()) router.refresh();
      }, debounceMs);
    };

    const closeStream = () => {
      if (es) {
        es.close();
        es = null;
      }
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
    };

    const connect = () => {
      if (stopped || es || retry) return;
      if (!isVisible()) return; // reconnects on visibilitychange
      if (typeof navigator !== "undefined" && navigator.onLine === false) return; // reconnects on `online`
      try {
        es = new EventSource("/api/events");
      } catch {
        return; // SSE unsupported — focus refresh below still covers it
      }
      es.addEventListener("open", () => {
        attempt = 0;
      });
      es.addEventListener(eventName, refreshSoon);
      es.addEventListener("error", () => {
        // Take over from EventSource's tight built-in retry loop so a flaky link backs off
        // instead of hammering it (which is what produces the QUIC/RTO console noise).
        if (es) {
          es.close();
          es = null;
        }
        if (stopped || retry) return;
        const delay = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 1000;
        attempt += 1;
        retry = setTimeout(() => {
          retry = null;
          connect();
        }, delay);
      });
    };

    const onVisibility = () => {
      if (isVisible()) {
        if (allowed()) router.refresh(); // catch up on anything missed while away/disconnected
        attempt = 0;
        connect();
      } else {
        closeStream(); // a backgrounded tab keeps no socket → no idle-timeout while away
      }
    };
    const onOnline = () => {
      attempt = 0;
      connect();
    };

    connect();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", closeStream);

    return () => {
      stopped = true;
      closeStream();
      if (debounce) clearTimeout(debounce);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", closeStream);
    };
  }, [router, eventName, debounceMs]);
}
