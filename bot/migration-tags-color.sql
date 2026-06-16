-- Migrasi: tambah kolom color ke tabel tags.
-- Tujuan: memungkinkan user memilih warna kategori secara manual lewat web UI.
-- Warna disimpan sebagai key palette (sage, ochre, clay, …) atau string kosong
-- (= fallback ke warna deterministik dari nama tag via tagColorKey di TypeScript).
--
-- Jalankan SEKALI:
--   python run-migration.py migration-tags-color.sql
--
-- Idempotent: jika kolom sudah ada, statement akan error tapi data aman.

ALTER TABLE tags ADD COLUMN color TEXT NOT NULL DEFAULT '';
