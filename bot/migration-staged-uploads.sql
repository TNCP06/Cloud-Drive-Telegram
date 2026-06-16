-- Migration: add staged (browser) upload support to upload_jobs.
-- Safe to run once on an existing Turso DB. SQLite ignores nothing here, so if a
-- column already exists the ALTER will error — run only the lines you still need.
--
--   turso db shell <your-db> < bot/migration-staged-uploads.sql
--
-- 'local'  uploads keep working unchanged (origin defaults to 'local').
-- 'upload' uploads are files pushed via the web resumable endpoint into the shared
-- staging dir; the watcher deletes them after a successful upload (cleanup_source=1).

ALTER TABLE upload_jobs ADD COLUMN origin         TEXT    NOT NULL DEFAULT 'local';
ALTER TABLE upload_jobs ADD COLUMN cleanup_source INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upload_jobs ADD COLUMN parts_done     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upload_jobs ADD COLUMN total_bytes    INTEGER NOT NULL DEFAULT 0;
