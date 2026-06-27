import type { NextRequest } from "next/server";
import { subscribeChanges } from "@/lib/driveEvents";

// Server-Sent Events stream: pushes tiny "something changed" signals to the browser whenever the
// drive's data or an upload job changes (Postgres NOTIFYs raised by DB triggers — see schema.sql).
// `drive_changed` → `event: drive` (DriveApp refreshes the grid); `upload_changed` → `event: upload`
// (the /upload page refreshes the job list). The clients refresh on each signal, so bot/watcher/
// other-session writes appear live without polling. Auth is enforced upstream by middleware (this
// path isn't excluded). All tabs share ONE Postgres LISTEN connection via lib/driveEvents.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: () => void = () => {};
      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // The client may already be gone (or leave mid-subscribe) — bail without leaking.
      if (req.signal.aborted) return cleanup();
      req.signal.addEventListener("abort", cleanup);

      // Forward each DB notification as an SSE event named after the channel: `drive_changed`
      // → `drive`, `upload_changed` → `upload` (data = source table name).
      unsubscribe = await subscribeChanges((channel, payload) => {
        const name = channel === "upload_changed" ? "upload" : "drive";
        enqueue(`event: ${name}\ndata: ${payload}\n\n`);
      });
      if (req.signal.aborted) return cleanup();

      // Initial hello + periodic heartbeat comment so neither proxies nor the browser's QUIC/HTTP3
      // transport drop the connection as idle. Kept well under typical ~30s idle timeouts (the
      // source of the `ERR_QUIC_PROTOCOL_ERROR.QUIC_NETWORK_IDLE_TIMEOUT` console errors).
      enqueue(`event: ready\ndata: ok\n\n`);
      heartbeat = setInterval(() => enqueue(`: ping\n\n`), 15000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (nginx) so events flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
