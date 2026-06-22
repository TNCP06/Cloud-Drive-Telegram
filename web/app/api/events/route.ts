import type { NextRequest } from "next/server";
import { subscribeDrive } from "@/lib/driveEvents";

// Server-Sent Events stream: pushes a tiny "drive changed" signal to the browser whenever the
// drive's data changes (a Postgres NOTIFY raised by the DB triggers — see schema.sql). The
// client (DriveApp) refreshes on each signal, so bot/watcher/other-session writes appear live
// without polling. Auth is enforced upstream by middleware (this path isn't excluded). All tabs
// share ONE Postgres LISTEN connection via lib/driveEvents.
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

      // Forward each DB notification as an SSE `drive` event (payload = source table name).
      unsubscribe = await subscribeDrive((payload) => {
        enqueue(`event: drive\ndata: ${payload}\n\n`);
      });
      if (req.signal.aborted) return cleanup();

      // Initial hello + periodic heartbeat comment so proxies don't drop the idle connection.
      enqueue(`event: ready\ndata: ok\n\n`);
      heartbeat = setInterval(() => enqueue(`: ping\n\n`), 25000);
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
