-- Skema final Turso (libSQL / SQLite-compatible) untuk Telegram Cloud Drive.
-- Termasuk is_favorite + trash (deleted_at). Jalankan sekali via Turso CLI.

CREATE TABLE IF NOT EXISTS folders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    is_private INTEGER NOT NULL DEFAULT 0,        -- 1 = hidden in the PIN-gated Private space
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT UNIQUE NOT NULL,
    title        TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('archive','media')),
    total_parts  INTEGER NOT NULL DEFAULT 0,
    total_size   INTEGER NOT NULL DEFAULT 0,
    is_favorite  INTEGER NOT NULL DEFAULT 0,
    is_private   INTEGER NOT NULL DEFAULT 0,      -- 1 = hidden in the PIN-gated Private space
    date_added   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at   TEXT,                           -- NULL = aktif; terisi = di sampah
    folder_id    INTEGER REFERENCES folders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS parts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    part_number    INTEGER NOT NULL,
    channel_msg_id INTEGER UNIQUE NOT NULL,
    file_name      TEXT,
    file_size      INTEGER NOT NULL DEFAULT 0,
    uploaded_at    TEXT,
    UNIQUE(item_id, part_number)
);

CREATE TABLE IF NOT EXISTS tags (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL DEFAULT ''   -- palette key (sage, ochre, …) or '' = derive from name
);

CREATE TABLE IF NOT EXISTS item_tags (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
);

-- Thumbnail per-PART: album (media group) = 1 item multi-part, tiap foto/video
-- punya thumbnail sendiri. Cover item = thumbnail part pertama (channel_msg_id terkecil).
CREATE TABLE IF NOT EXISTS thumbnails (
    part_id INTEGER PRIMARY KEY REFERENCES parts(id) ON DELETE CASCADE,
    mime    TEXT NOT NULL DEFAULT 'image/jpeg',
    data    TEXT NOT NULL                          -- base64
);

CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL CHECK (type IN ('delete','reindex')),
    item_id    INTEGER REFERENCES items(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','done','error')),
    payload    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Antrian upload dari web → dieksekusi oleh watcher.py.
-- Dua origin:
--   'local'  : file ada di mesin watcher (laptop), source_path = path lokal. Source TIDAK dihapus.
--   'upload' : file di-upload lewat browser (resumable) ke folder staging yang dibagi
--              antara web & watcher. source_path = path file ter-stage. cleanup_source=1
--              → watcher menghapus file staging setelah sukses.
CREATE TABLE IF NOT EXISTS upload_jobs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL CHECK (kind IN ('archive','media')),
    title          TEXT NOT NULL,
    tags           TEXT NOT NULL DEFAULT '',
    source_path    TEXT NOT NULL,                  -- path lokal (local) / file staging (upload)
    part_size      INTEGER NOT NULL DEFAULT 1500,  -- MB (khusus archive)
    origin         TEXT NOT NULL DEFAULT 'local'   -- 'local' | 'upload'
                     CHECK (origin IN ('local','upload')),
    cleanup_source INTEGER NOT NULL DEFAULT 0,     -- 1 = hapus source_path setelah sukses
    parts_done     INTEGER NOT NULL DEFAULT 0,     -- checkpoint: jumlah part yang sudah ter-upload (untuk resume)
    total_bytes    INTEGER NOT NULL DEFAULT 0,     -- ukuran file (untuk display)
    status         TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','pending','running','done','error','canceled')),
    progress       INTEGER NOT NULL DEFAULT 0,     -- 0..100
    message        TEXT,                           -- detail/error
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generated subtitle tracks per part (original + translations). One row per language.
-- The VTT files live on the streamer's persistent /subtitles volume; this table just
-- tells the web player which languages are available. Kept while the video is indexed.
CREATE TABLE IF NOT EXISTS subtitles (
    part_id    INTEGER NOT NULL,
    lang       TEXT NOT NULL,                  -- ISO-639-1 (en, id, …) or 'orig'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (part_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_upload_jobs_status ON upload_jobs(status);
CREATE INDEX IF NOT EXISTS idx_parts_item     ON parts(item_id);
CREATE INDEX IF NOT EXISTS idx_thumbnails_part ON thumbnails(part_id);
CREATE INDEX IF NOT EXISTS idx_items_kind     ON items(kind);
CREATE INDEX IF NOT EXISTS idx_items_deleted  ON items(deleted_at);
CREATE INDEX IF NOT EXISTS idx_items_favorite ON items(is_favorite) WHERE is_favorite = 1;
CREATE INDEX IF NOT EXISTS idx_items_private  ON items(is_private);
CREATE INDEX IF NOT EXISTS idx_folders_private ON folders(is_private);
CREATE INDEX IF NOT EXISTS idx_subtitles_part ON subtitles(part_id);
