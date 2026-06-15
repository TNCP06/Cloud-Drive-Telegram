"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { Kind } from "@/lib/types";
import { spawn } from "node:child_process";
import { openSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

// Lokasi script watcher (default: ../bot relatif ke folder web). Override via env kalau perlu.
const WATCHER_DIR = process.env.WATCHER_DIR || path.resolve(process.cwd(), "..", "bot");
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const PID_FILE = path.join(WATCHER_DIR, "watcher.pid");

// Server actions untuk metadata Turso (instan, tanpa menyentuh Telegram).
// Catatan: softDelete HANYA set deleted_at. File asli di Telegram baru dihapus
// saat purge (>7 hari) oleh JobQueue bot → restore bersifat lossless.

function refresh() {
  revalidatePath("/");
  revalidatePath("/trash");
}

export async function toggleFavorite(id: number, next: boolean) {
  await db.execute({
    sql: "UPDATE items SET is_favorite = ?, updated_at = datetime('now') WHERE id = ?",
    args: [next ? 1 : 0, id],
  });
  refresh();
}

export async function softDelete(id: number) {
  await db.execute({
    sql: "UPDATE items SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
    args: [id],
  });
  refresh();
}

export async function restore(id: number) {
  await db.execute({
    sql: "UPDATE items SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?",
    args: [id],
  });
  refresh();
}

// Edit metadata (judul / jenis / tag). Murni operasi Turso — TIDAK menyentuh
// Telegram, watcher, atau worker.session → aman dijalankan saat upload berjalan
// & tanpa restart bot. Penting: slug SENGAJA tidak diubah. Slug adalah kunci
// grouping multi-part game (ON CONFLICT saat indexing) sekaligus target deep-link
// unduhan; mengubahnya bisa bentrok & mematahkan tautan lama. family/versi game
// diturunkan ulang dari title saat dibaca, jadi rename tetap terlihat di UI.
export async function updateMetadata(
  id: number,
  input: { title: string; kind: Kind; tags: string }
) {
  const title = input.title.trim();
  if (!title) throw new Error("Judul tidak boleh kosong.");
  if (input.kind !== "game" && input.kind !== "media") {
    throw new Error("Jenis tidak valid.");
  }

  await db.execute({
    sql: "UPDATE items SET title = ?, kind = ?, updated_at = datetime('now') WHERE id = ?",
    args: [title, input.kind, id],
  });

  // Tag: normalisasi (dedup, buang kosong) → upsert nama → ganti relasi item ini.
  // Tidak menghapus tag yatim agar tak balapan dgn indexing upload yang berjalan.
  const names = Array.from(
    new Set(
      input.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    )
  );

  await db.execute({ sql: "DELETE FROM item_tags WHERE item_id = ?", args: [id] });
  for (const name of names) {
    await db.execute({
      sql: "INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING",
      args: [name],
    });
    const rs = await db.execute({
      sql: "SELECT id FROM tags WHERE name = ?",
      args: [name],
    });
    await db.execute({
      sql: "INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      args: [id, Number(rs.rows[0].id)],
    });
  }

  refresh();
}

// Galeri: thumbnail SELURUH part sebuah item, urut sesuai album (channel_msg_id).
// Dipakai PreviewDrawer untuk menampilkan semua foto/video album. Dimuat on-demand
// saat drawer dibuka → grid utama tetap ringan (hanya cover per item).
export async function getGallery(itemId: number): Promise<string[]> {
  const rs = await db.execute({
    sql: "SELECT t.mime AS mime, t.data AS data FROM thumbnails t JOIN parts p ON p.id = t.part_id WHERE p.item_id = ? ORDER BY p.channel_msg_id",
    args: [itemId],
  });
  return rs.rows.map((r) => `data:${String(r.mime)};base64,${String(r.data)}`);
}

// --- Antrian upload (dieksekusi watcher.py di laptop) ---
export async function enqueueUpload(input: {
  kind: Kind;
  title: string;
  tags: string;
  sourcePath: string;
  partSize: number;
}) {
  const sourcePath = input.sourcePath.trim();
  if (!sourcePath) throw new Error("Path file di laptop wajib diisi.");
  // Media (gambar/file receh) boleh tanpa judul → ambil dari nama file.
  // Game tetap wajib judul karena judul = kunci grouping antar part-nya.
  let title = input.title.trim();
  if (!title) {
    if (input.kind === "media") {
      const base = sourcePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
      title = base.replace(/\.[^.]+$/, "").trim() || "media";
    } else {
      throw new Error("Judul wajib diisi untuk game.");
    }
  }
  await db.execute({
    sql: "INSERT INTO upload_jobs (kind, title, tags, source_path, part_size) VALUES (?, ?, ?, ?, ?)",
    args: [input.kind, title, input.tags.trim(), sourcePath, input.partSize || 1500],
  });
  revalidatePath("/upload");
}

export async function cancelUpload(id: number) {
  await db.execute({
    sql: "UPDATE upload_jobs SET status = 'canceled', updated_at = datetime('now') WHERE id = ? AND status IN ('queued','pending')",
    args: [id],
  });
  revalidatePath("/upload");
}

// Picu eksekusi: queued → pending (watcher di laptop akan mengambilnya).
export async function startUpload(id: number) {
  await db.execute({
    sql: "UPDATE upload_jobs SET status='pending', message='diminta mulai…', updated_at=datetime('now') WHERE id = ? AND status='queued'",
    args: [id],
  });
  revalidatePath("/upload");
}

export async function startAllUploads() {
  await db.execute(
    "UPDATE upload_jobs SET status='pending', message='diminta mulai…', updated_at=datetime('now') WHERE status='queued'"
  );
  revalidatePath("/upload");
}

export async function clearFinishedUploads() {
  await db.execute(
    "DELETE FROM upload_jobs WHERE status IN ('done','error','canceled')"
  );
  revalidatePath("/upload");
}

// --- Kontrol proses watcher.py DI LAPTOP (web & watcher satu mesin) ---
async function watcherOnline(): Promise<boolean> {
  try {
    const rs = await db.execute("SELECT last_seen FROM watcher_heartbeat WHERE id = 1");
    if (!rs.rows.length) return false;
    const ms = new Date(String(rs.rows[0].last_seen).replace(" ", "T") + "Z").getTime();
    return Date.now() - ms < 30000;
  } catch {
    return false;
  }
}

export async function startWatcher(): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  if (await watcherOnline()) return { ok: true, already: true };
  try {
    const out = openSync(path.join(WATCHER_DIR, "watcher.log"), "a");
    // shell:true → "python" diresolusi lewat PATHEXT (.exe) di Windows.
    // detached + unref → watcher tetap hidup walau dev server di-restart.
    const child = spawn(PYTHON_BIN, ["-u", "watcher.py"], {
      cwd: WATCHER_DIR,
      detached: true,
      windowsHide: true,
      shell: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    if (child.pid) {
      try {
        writeFileSync(PID_FILE, String(child.pid));
      } catch {
        /* abaikan */
      }
      // Heartbeat instan → UI langsung "aktif" tanpa menunggu watcher konek.
      await db.execute(
        "INSERT INTO watcher_heartbeat (id, last_seen, status) VALUES (1, datetime('now'), 'idle') " +
          "ON CONFLICT(id) DO UPDATE SET last_seen=datetime('now'), status='idle'"
      );
    }
    revalidatePath("/upload");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Gagal menjalankan watcher." };
  }
}

export async function stopWatcher(): Promise<{ ok: boolean; error?: string }> {
  let pid = "";
  try {
    if (existsSync(PID_FILE)) pid = readFileSync(PID_FILE, "utf8").trim();
  } catch {
    /* abaikan */
  }
  if (!pid || !/^\d+$/.test(pid)) {
    return {
      ok: false,
      error: "PID watcher tidak diketahui (mungkin dijalankan manual). Tutup lewat jendela watcher.",
    };
  }
  try {
    // /T = ikut anak proses (7-Zip, dst), /F = paksa.
    await new Promise<void>((resolve) => {
      const k = spawn("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true });
      k.on("close", () => resolve());
      k.on("error", () => resolve());
    });
    try {
      rmSync(PID_FILE);
    } catch {
      /* abaikan */
    }
    // Buat heartbeat basi → UI langsung "tidak aktif".
    await db.execute(
      "UPDATE watcher_heartbeat SET last_seen = datetime('now','-1 hour'), status = NULL WHERE id = 1"
    );
    revalidatePath("/upload");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Gagal menghentikan watcher." };
  }
}
