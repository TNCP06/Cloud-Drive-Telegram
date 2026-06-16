-- Skema final Turso (libSQL / SQLite-compatible) untuk Telegram Cloud Drive.
-- Termasuk is_favorite + trash (deleted_at). Jalankan sekali via Turso CLI.

CREATE TABLE IF NOT EXISTS items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT UNIQUE NOT NULL,
    title        TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('game','media')),
    total_parts  INTEGER NOT NULL DEFAULT 0,
    total_size   INTEGER NOT NULL DEFAULT 0,
    is_favorite  INTEGER NOT NULL DEFAULT 0,
    date_added   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at   TEXT                            -- NULL = aktif; terisi = di sampah
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

-- Antrian upload dari web → dieksekusi oleh watcher.py di laptop (Telethon).
-- File asli ada di laptop; web hanya mencatat path + metadata.
CREATE TABLE IF NOT EXISTS upload_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL CHECK (kind IN ('game','media')),
    title       TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '',
    source_path TEXT NOT NULL,                  -- path file/folder DI LAPTOP
    part_size   INTEGER NOT NULL DEFAULT 1500,  -- MB (khusus game)
    status      TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','pending','running','done','error','canceled')),
    progress    INTEGER NOT NULL DEFAULT 0,     -- 0..100
    message     TEXT,                           -- detail/error
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Heartbeat watcher: web pakai ini untuk menampilkan status "aktif/tidak aktif".
CREATE TABLE IF NOT EXISTS watcher_heartbeat (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    last_seen TEXT NOT NULL,
    status    TEXT                              -- idle | busy
);

CREATE INDEX IF NOT EXISTS idx_upload_jobs_status ON upload_jobs(status);
CREATE INDEX IF NOT EXISTS idx_parts_item     ON parts(item_id);
CREATE INDEX IF NOT EXISTS idx_thumbnails_part ON thumbnails(part_id);
CREATE INDEX IF NOT EXISTS idx_items_kind     ON items(kind);
CREATE INDEX IF NOT EXISTS idx_items_deleted  ON items(deleted_at);
CREATE INDEX IF NOT EXISTS idx_items_favorite ON items(is_favorite) WHERE is_favorite = 1;
