# Arsitektur — Penyimpanan Game & Media berbasis Telegram

Sistem katalog pribadi yang memakai Telegram sebagai storage, Turso sebagai metadata, dan dashboard web untuk akses multi-device. Mendukung CRUD penuh (browse, edit, hapus) plus download via bot.

---

## 1. Prinsip inti

1. **Telegram = storage murni.** File asli (arsip game, video, gambar) hanya hidup di sebuah channel privat. Tidak ada salinan di server lain.
2. **Turso = otak metadata.** Semua judul, tag, ukuran, dan pointer ke pesan Telegram ada di sini. Selalu hidup (tidak tidur seperti Supabase).
3. **Web tidak menyentuh Telegram.** Dashboard (Vercel) hanya baca/tulis Turso. Yang bicara ke Telegram adalah bot dan laptop.
4. **Laptop hanya untuk upload file besar.** Setelah game ter-upload, laptop boleh dimatikan. Browse, edit, hapus, download tidak butuh laptop.
5. **Caption = kontrak.** Format caption yang konsisten adalah satu-satunya hal yang membuat indexing otomatis bekerja.

---

## 2. Komponen & tanggung jawab

| Komponen | Tempat | Tugas |
|---|---|---|
| Channel privat | Telegram | Menyimpan file (arsip `.7z` game / file media). Bot jadi admin. |
| Bot | Webhook (serverless OK) | Index caption ke Turso, validasi format, `copyMessage` untuk download, hapus pesan. |
| Turso (libSQL) | Cloud, free tier | Metadata: items, parts, tags, thumbnails, jobs, upload_jobs, heartbeats. |
| Dashboard | Next.js di Vercel | UI multi-device. Baca/tulis Turso. Trigger download & hapus. |
| Streamer | VPS (FastAPI) | Streaming video parsial (sparse caching) dari Telegram ke dashboard. |
| Worker upload | Laptop (Telethon) | Split file besar, upload ke channel via MTProto. Opsional: full re-index. |
| History Indexer | Laptop / Server (Watcher container) | Sinkronisasi riwayat pesan channel ke Turso menggunakan Telethon (worker.session) pada saat startup atau secara manual. |

---

## 3. Dua jenis item

| Jenis | Contoh | Penyimpanan | Thumbnail |
|---|---|---|---|
| `game` | Ren'Py VN | Arsip `.7z` di-split jadi part ~1–1.9 GB | Tidak perlu (dikenali dari judul) |
| `media` | Video / gambar | File utuh (bukan arsip), 1 part | Perlu — di-harvest dari thumbnail bawaan Telegram oleh bot |

Pemikiran pemisahan jenis ini tetap sama, namun thumbnail kini disimpan secara per-part untuk mendukung album media.

---

## 4. Kontrak caption

Format wajib di setiap pesan yang masuk channel:

```
Judul | part/total | tag1, tag2
```

Contoh:
- Game multi-part: `Eternum | 3/8 | rpg, fantasy`
- Media tunggal: `Trailer Eternum | 1/1 | video, promo`

Bot mem-parsing caption ini. Jika cocok → tulis metadata ke Turso. Jika tidak cocok → balas peringatan ke owner di Telegram (jadi tidak ada file yang hilang diam-diam).

Regex acuan:
```
^(?P<title>.+?)\s*\|\s*(?P<part>\d+)\s*/\s*(?P<total>\d+)\s*\|\s*(?P<tags>.*)$
```

---

## 5. Skema data (Turso / libSQL — SQLite-compatible)

```sql
-- satu baris per item (game atau media)
CREATE TABLE items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT UNIQUE NOT NULL,
    title        TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('game','media')),
    total_parts  INTEGER NOT NULL DEFAULT 0,
    total_size   INTEGER NOT NULL DEFAULT 0,   -- bytes, dijumlah dari parts
    is_favorite  INTEGER NOT NULL DEFAULT 0,
    date_added   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at   TEXT                           -- soft delete; NULL = aktif
);

-- satu baris per file/part di channel
CREATE TABLE parts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    part_number   INTEGER NOT NULL,
    channel_msg_id INTEGER UNIQUE NOT NULL,      -- ID pesan di channel = kunci idempotensi & target copyMessage
    file_name     TEXT,
    file_size     INTEGER NOT NULL DEFAULT 0,
    uploaded_at   TEXT,
    UNIQUE(item_id, part_number)
);

-- tag many-to-many
CREATE TABLE tags (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL DEFAULT ''
);
CREATE TABLE item_tags (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
);

-- Thumbnail per-PART: album (media group) = 1 item multi-part, tiap foto/video
-- punya thumbnail sendiri. Cover item = thumbnail part pertama (channel_msg_id terkecil).
CREATE TABLE thumbnails (
    part_id INTEGER PRIMARY KEY REFERENCES parts(id) ON DELETE CASCADE,
    mime    TEXT NOT NULL DEFAULT 'image/jpeg',
    data    TEXT NOT NULL                          -- base64
);

-- antrian perintah dari web ke bot (untuk tugas async)
CREATE TABLE jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL CHECK (type IN ('delete','reindex')),
    item_id    INTEGER REFERENCES items(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'pending'    -- pending | running | done | error
                 CHECK (status IN ('pending','running','done','error')),
    payload    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- antrian upload dari web ke watcher
CREATE TABLE upload_jobs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL CHECK (kind IN ('game','media')),
    title          TEXT NOT NULL,
    tags           TEXT NOT NULL DEFAULT '',
    source_path    TEXT NOT NULL,
    part_size      INTEGER NOT NULL DEFAULT 1500,
    origin         TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local','upload')),
    cleanup_source INTEGER NOT NULL DEFAULT 0,
    parts_done     INTEGER NOT NULL DEFAULT 0,
    total_bytes    INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','pending','running','done','error','canceled')),
    progress       INTEGER NOT NULL DEFAULT 0,
    message        TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- status liveness watcher
CREATE TABLE watcher_heartbeat (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    last_seen TEXT NOT NULL,
    status    TEXT
);

-- index untuk kolom yang sering difilter (hemat row-reads di Turso)
CREATE INDEX idx_parts_item ON parts(item_id);
CREATE INDEX idx_thumbnails_part ON thumbnails(part_id);
CREATE INDEX idx_items_kind ON items(kind);
CREATE INDEX idx_items_deleted ON items(deleted_at);
CREATE INDEX idx_items_favorite ON items(is_favorite) WHERE is_favorite = 1;
CREATE INDEX idx_upload_jobs_status ON upload_jobs(status);
```

Catatan desain:
- `channel_msg_id UNIQUE` → bot/indexer idempotent, dan jadi target langsung `copyMessage` saat download.
- `deleted_at` → hapus terasa instan di web (soft delete), pesan asli dibersihkan bot setelahnya atau manual via dashboard.
- `thumbnails` per-part → disimpan per-part agar album (media group) bisa memiliki thumbnail berbeda per item di dalamnya. Cover item utama diambil dari part pertama.

---

## 6. Alur per operasi

### A. Upload game (file besar)
1. **Mode browser (Upload dari device ini)**: User mengunggah file lewat browser. File dikirim per potongan 16 MB secara resumable ke folder staging di server. Setelah selesai, row `upload_jobs` dibuat dengan origin `upload`. Watcher secara otomatis melakukan streaming split (menulis potongan byte <2 GB, mengirimnya ke Telegram via MTProto, lalu menghapusnya). Staging asli dibersihkan setelah selesai.
2. **Mode lokal (Host path)**: File berada di laptop. Watcher membagi file menggunakan 7-Zip secara lokal menjadi bagian-bagian `game.7z.001`, `.002`, ... lalu mengunggahnya.
3. Bot mendeteksi kiriman channel_post baru secara real-time dan mengindeksnya ke Turso.

### B. Upload media (video/gambar)
1. Kirim file ke channel (sebagai dokumen/media) dengan caption.
2. Bot melihat post → parse caption → ambil thumbnail bawaan Telegram. Jika server Telegram Bot API lokal dikonfigurasi, bot membaca file thumbnail langsung dari shared volume (`telegram-bot-api-data`) daripada melakukan unduhan HTTP.

### C. Index & validasi (bot, real-time)
- `channel_post` masuk → parse caption.
- Cocok → upsert `items`/`parts` (+`thumbnails` untuk media).
- Tidak cocok → balas owner: "⚠️ caption tidak sesuai format, belum terindeks."

### D. Download — tanpa laptop
1. Web: klik "download" → buka deep link `https://t.me/NamaBot?start=<kode_item>`.
2. Bot `/start` handler: decode kode → lookup `channel_msg_id` semua part item di Turso.
3. Bot `copyMessage` tiap part ke chat user. File mendarat di Telegram user → download langsung dari server Telegram (kecepatan penuh, multi-device).

> `copyMessage` = operasi referensi, jadi tidak kena limit 50/20 MB. Pakai `copyMessage` (bukan `forwardMessage`) agar channel storage tetap tersembunyi.

### E. Hapus & Pembersihan Permanen
1. **Soft Delete (Web)**: User mengklik hapus → set `items.deleted_at = waktu_sekarang`. Item langsung tersembunyi dari grid utama.
2. **Hard Delete (Purge)**:
   - **Manual (Web)**: User membuka halaman Trash dan mengklik "Delete permanently" → memanggil server action `purgeNow` yang langsung memanggil Telegram Bot API `deleteMessage` untuk setiap part di channel, lalu menghapus seluruh baris metadata di database secara permanen.
   - **Otomatis (Bot)**: Bot secara berkala (harian) mendeteksi item di Trash dengan `deleted_at` yang berusia lebih dari 7 hari, menghapus pesan dari channel Telegram, dan membersihkan baris data dari Turso.

---

## 7. Butuh laptop vs tidak

| Operasi | Butuh laptop? | Catatan |
|---|---|---|
| Upload game besar (lokal) | Ya | File ada di laptop + butuh MTProto laptop |
| Upload game/media (browser) | Tidak | Diproses oleh watcher di server VPS |
| Upload media kecil (dari HP) | Tidak | Post langsung ke channel |
| Browse / edit judul / edit tag | Tidak | Menulis langsung ke Turso |
| Download | Tidak | Lewat deep link bot |
| Hapus / Trash Purge | Tidak | Lewat bot / Server actions web |

---

## 8. Catatan teknis, Keamanan & Optimasi

- **Bypass Throttling Telegram (Local Bot API & Streamer)**: Streaming video menggunakan server FastAPI (`streamer.py`) didukung dengan Local Telegram Bot API server (`--local`). File video diunduh secara lokal oleh API server ke volume bersama (`telegram-bot-api-data`), lalu streamer menyajikannya sebagai `HTTP 206 Partial Content` secara instan (bypass batas 3Mbps).
- **Service Worker & IndexedDB Caching**: Web menggunakan service worker client-side (`sw.js`) untuk membagi video range requests menjadi potongan 2 MB dan menyimpannya di IndexedDB (`video-cache-db`) lokal hingga 4 GB untuk mengurangi beban bandwidth VPS dan pemutaran instan.
- **Session Telethon & token bot jangan di-commit.** Masukkan ke `.gitignore` dan/atau environment variables. Session = akses penuh ke akun.
- **Turso row-reads** dihitung per baris yang di-scan → pastikan filter (`kind`, tag, `deleted_at`) memakai index di atas. Untuk katalog ratusan item, free tier sangat cukup.
- **Thumbnail per-part**: Disimpan base64 di tabel `thumbnails` dan diasosiasikan per-part agar mendukung thumbnail berbeda dalam album media group.
- **Dashboard baca Turso** via `@libsql/client` di route handler Next.js. CRUD metadata (judul/tag/hapus) cukup operasi Turso — instan dari device mana saja.

---

## 9. Urutan implementasi yang disarankan

1. Buat channel privat + bot, jadikan bot admin.
2. Setup Turso, jalankan skema di atas.
3. Bot: handler `channel_post` (index + validasi) — jantung sistem.
4. Worker laptop (Telethon): split + upload + caption otomatis.
5. Dashboard Next.js: grid + sort + filter (baca Turso).
6. Bot: handler `/start` (download via `copyMessage`).
7. Web + bot: alur hapus (`jobs`).
