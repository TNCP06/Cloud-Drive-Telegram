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
| Turso (libSQL) | Cloud, free tier | Metadata: items, parts, tags, thumbnails, jobs. |
| Dashboard | Next.js di Vercel | UI multi-device. Baca/tulis Turso. Trigger download & hapus. |
| Worker upload | Laptop (Telethon) | Split file besar, upload ke channel via MTProto. Opsional: full re-index. |

---

## 3. Dua jenis item

| Jenis | Contoh | Penyimpanan | Thumbnail |
|---|---|---|---|
| `game` | Ren'Py VN | Arsip `.7z` di-split jadi part ~1–1.9 GB | Tidak perlu (dikenali dari judul) |
| `media` | Video / gambar | File utuh (bukan arsip), 1 part | Perlu — di-harvest dari thumbnail bawaan Telegram oleh bot |

Pemisahan ini penting: hanya `media` yang punya thumbnail, dan thumbnail-nya diambil dari Telegram (yang otomatis membuat thumbnail untuk video/gambar), bukan diekstrak manual.

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
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
);
CREATE TABLE item_tags (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
);

-- thumbnail terpisah supaya listing grid tetap ringan (lazy-load per kartu)
CREATE TABLE thumbnails (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    mime    TEXT NOT NULL DEFAULT 'image/webp',
    data    TEXT NOT NULL                         -- base64; kecil (~KB)
);

-- antrian perintah dari web ke bot/worker (untuk hapus & tugas async)
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

-- index untuk kolom yang sering difilter (hemat row-reads di Turso)
CREATE INDEX idx_parts_item ON parts(item_id);
CREATE INDEX idx_items_kind ON items(kind);
CREATE INDEX idx_items_deleted ON items(deleted_at);
```

Catatan desain:
- `channel_msg_id UNIQUE` → bot/indexer idempotent, dan jadi target langsung `copyMessage` saat download.
- `deleted_at` → hapus terasa instan di web (soft delete), pesan asli dibersihkan bot setelahnya.
- `thumbnails` dipisah → query grid (`SELECT id,title,kind,... FROM items`) tidak menyeret bytes gambar.

---

## 6. Alur per operasi

### A. Upload game (file besar) — butuh laptop
1. Laptop: split folder dengan 7-Zip, mode store untuk asset yang sudah padat.
   `7z a -v1500m -mx=0 game.7z "D:\Games\NamaGame"` → `game.7z.001`, `.002`, ...
2. (Opsional) ekstrak/siapkan cover lokal — untuk game Ren'Py dilewati (tanpa thumbnail).
3. Worker (Telethon) upload tiap part ke channel dengan caption sesuai kontrak.
4. Bot melihat tiap `channel_post` baru → parse caption → tulis `items` + `parts` ke Turso.

> Upload >50 MB wajib via session user (MTProto), karena Bot API dibatasi 50 MB.

### B. Upload media (video/gambar) — bisa dari HP
1. Kirim file ke channel (sebagai dokumen/media, **bukan** arsip) dengan caption.
2. Bot melihat post → parse caption → ambil `thumbnail` bawaan Telegram (`getFile`, kecil, di bawah limit 20 MB) → simpan ke tabel `thumbnails` + tulis metadata.

### C. Index & validasi (bot, real-time)
- `channel_post` masuk → parse caption.
- Cocok → upsert `items`/`parts` (+`thumbnails` untuk media).
- Tidak cocok → balas owner: "⚠️ caption tidak sesuai format, belum terindeks."

### D. Download — tanpa laptop
1. Web: klik "download" → buka deep link `https://t.me/NamaBot?start=<kode_item>`.
2. Bot `/start` handler: decode kode → lookup `channel_msg_id` semua part item di Turso.
3. Bot `copyMessage` tiap part ke chat user. File mendarat di Telegram user → download langsung dari server Telegram (kecepatan penuh, multi-device).

> `copyMessage` = operasi referensi, jadi tidak kena limit 50/20 MB. Pakai `copyMessage` (bukan `forwardMessage`) agar channel storage tetap tersembunyi.

### E. Hapus — tanpa laptop
1. Web: set `items.deleted_at` (hilang dari UI seketika) + insert `jobs(type='delete')`.
2. Bot proses job: `deleteMessage` tiap part di channel → hapus baris `parts`/`items` (hard delete). Karena bot admin channel, ini berjalan tanpa laptop.

---

## 7. Butuh laptop vs tidak

| Operasi | Butuh laptop? |
|---|---|
| Upload game besar | Ya (file ada di laptop + butuh MTProto) |
| Upload media kecil (dari HP) | Tidak |
| Browse / edit judul / edit tag | Tidak |
| Download | Tidak (lewat bot) |
| Hapus | Tidak (lewat bot) |

---

## 8. Catatan teknis & keamanan

- **Split lebih kecil (1 GB) untuk internet lemot** → kalau upload gagal, hanya 1 chunk yang diulang; juga lebih aman dari kegagalan forward di file mendekati 2 GB.
- **Session Telethon & token bot jangan di-commit.** Masukkan ke `.gitignore` dan/atau environment variables. Session = akses penuh ke akun.
- **Turso row-reads** dihitung per baris yang di-scan → pastikan filter (`kind`, tag, `deleted_at`) memakai index di atas. Untuk katalog ratusan item, free tier sangat cukup.
- **Thumbnail kecil** (~256px, WebP) cukup untuk grid. Disimpan base64 di tabel `thumbnails`, di-render inline (`data:image/webp;base64,...`).
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
