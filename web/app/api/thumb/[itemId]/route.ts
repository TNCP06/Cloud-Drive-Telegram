import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";

// Cover thumbnail (first part) of an item, served as a CACHEABLE image instead of being
// embedded as base64 in the main page payload. The grid now ships only a tiny URL per item, so
// the initial load stays small no matter how large the library grows; the browser then HTTP-caches
// each thumbnail and — combined with native lazy-loading on the <img> — fetches only the covers
// actually scrolled into view. Auth is enforced upstream by middleware (this path isn't excluded).
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
) {
  const { itemId } = await params;
  const id = Number(itemId);
  if (!Number.isFinite(id)) {
    return new NextResponse("Bad request", { status: 400 });
  }

  // Cover = thumbnail of the item's FIRST part (album = smallest channel_msg_id).
  const rs = await db.execute({
    sql: `SELECT t.mime AS mime, t.data AS data
          FROM thumbnails t JOIN parts p ON p.id = t.part_id
          WHERE p.item_id = ?
          ORDER BY p.channel_msg_id
          LIMIT 1`,
    args: [id],
  });
  const row = rs.rows[0];
  if (!row || !row.data) {
    return new NextResponse("Not found", { status: 404 });
  }

  const body = new Uint8Array(Buffer.from(String(row.data), "base64"));
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": String(row.mime || "image/jpeg"),
      // Browser caches the cover; stale-while-revalidate lets a re-harvested/replaced cover
      // refresh quietly in the background without ever blocking the grid render.
      "Cache-Control": "public, max-age=600, stale-while-revalidate=86400",
    },
  });
}
