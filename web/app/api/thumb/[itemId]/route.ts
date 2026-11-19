import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { isAppAuthenticated } from "@/lib/apiAuth";
import { canReadSpace } from "@/lib/resourceAuth";

// Cover thumbnail (first part) of an item, served as a CACHEABLE image instead of being
// embedded as base64 in the main page payload. The grid now ships only a tiny URL per item, so
// the initial load stays small no matter how large the library grows; the browser then HTTP-caches
// each thumbnail and — combined with native lazy-loading on the <img> — fetches only the covers
// actually scrolled into view. Auth is enforced upstream by middleware (this path isn't excluded).
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
) {
  if (!(await isAppAuthenticated())) return new NextResponse("Unauthorized", { status: 401 });
  const { itemId } = await params;
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) {
    return new NextResponse("Bad request", { status: 400 });
  }

  // Cover = thumbnail of the item's FIRST part (album = smallest channel_msg_id).
  // Combined with authorization check in a single query to eliminate pool lock contention.
  const rs = await db.execute({
    sql: `SELECT i.is_private AS is_private, i.deleted_at AS deleted_at, t.mime AS mime, t.data AS data
          FROM items i
          JOIN parts p ON p.item_id = i.id
          JOIN thumbnails t ON t.part_id = p.id
          WHERE i.id = ?
          ORDER BY p.channel_msg_id
          LIMIT 1`,
    args: [id],
  });
  const row = rs.rows[0];
  if (!row || !row.data || row.deleted_at != null) {
    return new NextResponse("Not found", { status: 404 });
  }

  const isPrivate = Number(row.is_private ?? 0);
  if (!(await canReadSpace(isPrivate))) {
    return new NextResponse("Not found", { status: 404 });
  }

  const etag = `W/"thumb-${id}"`;
  const cacheControl = isPrivate === 1
    ? "private, max-age=86400, stale-while-revalidate=604800"
    : "public, max-age=604800, stale-while-revalidate=2592000";

  // Fast 304 response if the client already has this thumbnail in cache
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === "*")) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": cacheControl,
      },
    });
  }

  const body = new Uint8Array(Buffer.from(String(row.data), "base64"));
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": String(row.mime || "image/jpeg"),
      ETag: etag,
      "Cache-Control": cacheControl,
    },
  });
}
