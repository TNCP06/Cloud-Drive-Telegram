import "server-only";
import { Client } from "pg";

// Server-side fan-out for Postgres LISTEN notifications.
//
// One process holds a SINGLE dedicated connection (not one per browser) that LISTENs on every
// realtime channel and fans each notification out to every subscribed SSE stream. This is the
// scalable shape: N connected tabs cost 1 Postgres connection here, not N. The listener
// auto-reconnects (with backoff) if the connection drops, re-issuing LISTEN, so subscribers keep
// receiving without re-subscribing.
//
// Two channels are multiplexed over the one connection:
//   - `drive_changed`  → the drive's visible data changed (items/folders/tags); the main grid refreshes.
//   - `upload_changed` → an upload_jobs row changed (progress/status); the /upload page refreshes.
// Each subscriber receives `(channel, payload)` so it can react to only the channel it cares about.

type Subscriber = (channel: string, payload: string) => void;

const CHANNELS = ["drive_changed", "upload_changed"] as const;

const subscribers = new Set<Subscriber>();
let client: Client | null = null;
let connecting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect() {
  client = null;
  if (reconnectTimer || subscribers.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (subscribers.size > 0) void ensureListener();
  }, 2000);
}

async function ensureListener(): Promise<void> {
  if (client || connecting) return;
  connecting = true;
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.on("notification", (msg) => {
    const channel = msg.channel ?? "";
    const payload = msg.payload ?? "";
    for (const fn of subscribers) {
      try {
        fn(channel, payload);
      } catch {
        /* a broken subscriber must not break the others */
      }
    }
  });
  // Any connection-level failure → drop the client and retry; the browser's EventSource also
  // keeps its HTTP stream open, so it resumes receiving as soon as the listener is back.
  c.on("error", () => {
    try {
      void c.end();
    } catch {
      /* ignore */
    }
    scheduleReconnect();
  });
  try {
    await c.connect();
    for (const ch of CHANNELS) await c.query(`LISTEN ${ch}`);
    client = c;
  } catch {
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

// Register an SSE stream. Returns an unsubscribe fn. The shared listener stays open even when
// the last subscriber leaves (cheap, and avoids connect/teardown churn on navigation).
export async function subscribeChanges(fn: Subscriber): Promise<() => void> {
  subscribers.add(fn);
  await ensureListener();
  return () => {
    subscribers.delete(fn);
  };
}
