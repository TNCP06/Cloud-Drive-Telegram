-- Migrasi: thumbnails per-PART (sebelumnya per-item).
-- Tujuan: album Telegram (media group) disimpan sebagai 1 item multi-part,
-- dan tiap part (foto/video) punya thumbnail sendiri → web bisa menampilkan
-- galeri seluruh isi album. Jalankan SEKALI via Turso CLI:
--   turso db shell stash-drive-tncp06 < migration-thumbnails-per-part.sql
--
-- CATATAN: ini migrasi sekali jalan, BUKAN idempotent. Menjalankannya dua kali
-- akan error (thumbnails sudah memakai part_id, tak ada lagi kolom item_id) —
-- error tsb aman/tak merusak data, tapi pastikan hanya dijalankan sekali.

ALTER TABLE thumbnails RENAME TO thumbnails_old;

CREATE TABLE thumbnails (
    part_id INTEGER PRIMARY KEY REFERENCES parts(id) ON DELETE CASCADE,
    mime    TEXT NOT NULL DEFAULT 'image/jpeg',
    data    TEXT NOT NULL                          -- base64
);

-- Backfill: tiap thumbnail lama (per item) dipindah ke PART PERTAMA item itu
-- (channel_msg_id terkecil = urutan asli). Item lama = media 1-part, jadi 1:1.
INSERT INTO thumbnails (part_id, mime, data)
SELECT p.id, t.mime, t.data
FROM thumbnails_old t
JOIN parts p ON p.item_id = t.item_id
WHERE p.channel_msg_id = (
    SELECT MIN(channel_msg_id) FROM parts WHERE item_id = t.item_id
);

DROP TABLE thumbnails_old;

-- Bantu query cover/galeri (join thumbnails → parts per item).
CREATE INDEX IF NOT EXISTS idx_thumbnails_part ON thumbnails(part_id);
