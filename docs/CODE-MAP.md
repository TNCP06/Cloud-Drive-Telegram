# Code Map — file & function reference

Where things live and what each function does. Pair with [`ARCHITECTURE.md`](./ARCHITECTURE.md)
(concepts) and [`BUSINESS-FLOWS.md`](./BUSINESS-FLOWS.md) (operations). Line counts are
approximate and will drift — treat function names as the stable anchor.

---

## `bot/` — Python (Telegram bridge)

### `bot.py` — indexer + download server + purge (long-running, `python-telegram-bot`)
Pure helpers (no I/O): `slugify`, `parse_caption` (the contract regex), `detect_kind`
(`media` vs `archive`), `get_file_meta`, `derive_media_meta` (media caption fallback),
`pick_thumb_file_id`, `process_next_in_queue` (helper to process the next queued file).
Turso ops (idempotent): `upsert_item` (`set_title` guard for albums; preserves user-modified metadata on conflict), `upsert_part` (keyed on
`channel_msg_id`, cleans up orphan items if a part is reassigned), `recompute_totals`, `sync_tags`, `upsert_thumbnail`.
Handlers: `on_channel_post` (index new and edited channel posts, Flow C), `harvest_thumbnail` (if the post has no thumbnail
yet — common for video, which Telegram generates asynchronously — it schedules
`_deferred_harvest` instead of giving up), `_deferred_harvest` (background task: wait 60 s, then
`forward_message` to owner chat to re-fetch the now-generated thumbnail, store it, delete the
forward), `on_start` (download via `copy_message` for authorized users), `on_auth` / `on_approve` / 
`on_revoke` / `on_list_users` / `on_set_web_url` (user authorization, management, and settings), `send_main_menu` / `on_menu` (button-driven main menu and guide),
`on_cancel` (cancel active file upload), `on_private_file` (interactive PM upload & Bot Drop intake),
`on_private_text` / `on_callback_query` (interactive questionnaire and menu callbacks), `purge_job` (daily trash purge),
`bot_heartbeat_job` (writes to `bot_heartbeat` every 10 s — web UI liveness check).
Lifecycle: `post_init`/`post_shutdown` (Turso client, auto-migration for `authorized_users` table, and commands menu registration), `main` (handler registration +
`run_daily` + `run_repeating` heartbeat). **Env:** `BOT_TOKEN`, `STORAGE_CHANNEL_ID`,
`OWNER_USER_ID`, `TURSO_*`, `AUTH_PASSWORD`/`APP_PASSWORD`.

### `watcher.py` — upload-queue executor (long-running, Telethon, **laptop OR server**)
Handles two job origins (`upload_jobs.origin`):
- **`local`** — file already on this machine. archive → `split_archive` (7-Zip); media → whole file.
- **`upload`** — file pushed via the web resumable endpoint into the shared staging dir.
  archive > part_size → **raw streaming split, no 7-Zip** (`write_window` copies one <2 GB byte
  window → upload → delete it → next); media/small → whole file. On success the staging dir is
  removed (`cleanup_source`).

`claim_next` (oldest `pending` → `running`; **preserves `parts_done`** so retries resume),
`set_progress`/`set_status`, `set_parts_done` (per-part checkpoint), `split_archive` (local 7-Zip),
`resolve_staged_file` (the single file inside an upload's staging dir), `write_window` (raw byte
window copy, 8 MB buffer), `make_video_thumbnail` (ffmpeg frame at 1 s → temp JPEG),
`_store_thumbnails` (background: poll `parts` ~70 s, `INSERT OR IGNORE` thumbnail),
`process` (build plan `list`/`stream` → upload each part, checkpoint after each, cleanup temp
parts + staging dir on success), `resolve_channel`, `heartbeat` (10 s), `main` (poll loop, 5 s).
Writes `watcher.pid`. **`ffmpeg`** for media thumbnails; **7-Zip only for `local` archives**.
Imports `normalize_tags, build_caption, safe_name, collect_parts` from `worker.py`.

### `worker.py` — standalone upload CLI (Telethon, **laptop**)
Same upload logic as the watcher but argparse-driven (`archive` / `media` subcommands).
`normalize_tags`, `build_caption`, `safe_name`, `split_with_7zip` (calls `sys.exit` on error —
contrast watcher's `split_archive` which raises), `collect_parts`, `make_progress`, `upload_parts`,
`run`, `main`.

### `index_history.py` — manual/automatic history back-indexer (Telethon, **laptop or server**)
Utility to fetch channel messages using Telethon (via `worker.session`) and sync them back to the Turso catalog. Runs on-demand or automatically inside the watcher container on startup to back-fill any updates missed while the bot was offline.

### `streamer.py` — video streaming server (FastAPI + Telethon, **server/VPS**)
HTTP 206 Partial Content server for single-part and multi-part media items. If `TELEGRAM_API_URL` is set,
downloads files on-the-fly to a shared cache volume on the VPS disk using a local Telegram Bot API
server in `--local` mode (bypassing the 3Mbps download throttle) and streams directly to the browser.
Otherwise, falls back to Telethon `iter_download` with sparse 1 MB chunk cache & prefetching.

Key functions: `_turso_http_url` (libsql→https), `download_via_local_bot_api` (requests file download
from local Bot API server), `_evict_local_api_cache_if_needed` (scans shared volume and deletes oldest files
using mtime LRU policy), `_ensure_chunk_stream` (fallback Telethon disk-or-download),
`_init_part_meta` (Turso query → `meta.json` creation), `_prefetch_worker` (fallback background prefetch),
`_get_tg_message` (in-memory message cache), `stream` (main route: parse Range, downloads via local Bot API
and streams local file if active, else chunk-streams via Telethon).
**Env:** `TG_API_ID`, `TG_API_HASH`, `STORAGE_CHANNEL_ID`, `TURSO_*`, `BOT_TOKEN`, `TELEGRAM_API_URL`
(enables local Bot API mode), `STREAMER_PORT` (default 8080), `CACHE_MAX_SIZE_GB` (used for cache limits).


### Supporting scripts
- `login.py` — one-time Telethon login → creates `worker.session` (or any custom session, e.g. `streamer.session` via CLI argument).
- `schema.sql` — full Turso schema (run once). `migration-tags-color.sql` + `run-migration.py`
  — adds `tags.color`. `migration-bot-heartbeat.sql` — adds `bot_heartbeat` table.
  `status.py` — quick DB status dump.
- `run-all.cmd` — start bot + watcher minimized (Windows). `uninstall-autostart.ps1` — Windows startup deregistration.
- `Dockerfile` — shared image for bot + watcher (ffmpeg + p7zip). See root
  `docker-compose.yml` and [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the server/VPS deployment.

---

## `web/` — Next.js 15 (App Router, React 19, server actions)

### `web/lib/` — server-side data & helpers
- `db.ts` — `@libsql/client` singleton (`server-only`; auth token never reaches the browser).
- `types.ts` — `Kind`, `Tag`, `DriveFile` (UI shape; incl. `firstPartId` + `fileName` for
  streaming), `GalleryPart` (part ID, file name, and thumbnail data URL), `UploadJob` (now incl. `origin`,
  `partsDone`, `totalBytes`), `UploadOrigin`, `UploadStatus`, `WatcherStatus`, `FsEntry`/`FsListing`/`FsShortcut`.
- `staging.ts` — shared resumable-upload staging paths. `STAGING_ROOT`
  (`UPLOAD_STAGING_DIR`, `/staging` in Docker), `jobDir(token)`, `stagedFilePath(token,name)`
  with strict token/path-traversal guards. Used by the upload API + the watcher reads the same dir.
- `items.ts` — `getDriveData()`: the main read. One batched query set → shapes `DriveFile[]` +
  `Tag[]`. Computes each item's **cover** thumbnail (first part by `channel_msg_id`), fetches
  `firstPartId`/`fileName` for media items (for video streaming), and for archives, splits title
  into `family`/`version` via `parseTitle`.
- `version.ts` — `parseTitle()`: split an archive title into `family` + `version` (e.g.
  `ReRudy 0.6.0` → `{family:"ReRudy", version:"v0.6.0"}`) for version grouping. Archives only.
- `kinds.ts` — `tagColorKey()` (deterministic name→palette colour) and kind metadata.
- `format.ts` — `sqliteToMs()` (SQLite datetime→epoch ms), byte/size formatting.
- `uploads.ts` — `getUploadJobs()` — read helper for the `/upload` page.
- `gallery-cache.ts` — in-memory cache for `getGallery` results (`GalleryPart[]`). `icons.tsx` — SVG icons.

### `web/app/` — routes & server actions
- `actions.ts` — **the metadata + control API** (all `"use server"`). Item: `toggleFavorite`,
  `softDelete`, `restore`, `purgeNow` (on-demand permanent delete of a trashed item — Telegram
  `deleteMessage` + hard-delete rows; mirrors the bot's `purge_job`), `updateMetadata` (slug
  intentionally NOT changed on rename).
  Folders: `createFolder`, `renameFolder`, `deleteFolder` (cascade soft-deletes items), `moveItemsToFolder`.
  Bulk ops: `bulkToggleFavorite`, `bulkSoftDelete`, `bulkRestore`, `bulkPurgeNow`.
  Tags: `listTags`, `createTag`, `recolorTag`, `renameTag` (merge-aware), `deleteTag`.
  Gallery: `getGallery` (all parts' thumbnails on demand). Upload queue: `enqueueUpload`
  (local path), `cancelUpload`, `startUpload`, `retryUpload` (error→pending, keeps `parts_done`
  → resumes from checkpoint), `startAllUploads`, `clearFinishedUploads`. Process control:
  `killTree` (cross-platform: `taskkill` on Windows, process-group `kill` on Linux),
  `watcherOnline`, `startWatcher`, `stopWatcher`; `botOnline`, `startBot`, `stopBot` (deprecated/unused by the UI).
  Thumbnail repair: `reharvestThumbnail(itemId)` — forwards each part's channel message to
  owner chat via Bot API `forwardMessage`, extracts `video.thumbnail.file_id`, downloads via
  `getFile`, stores in `thumbnails`, deletes forward. Fixes thumbnails missed at index time.
  `uploadThumbnail(itemId, mime, dataB64)` — manually sets a base64 thumbnail image for all
  parts of an item (fallback when Telegram never generated one, e.g. unsupported codec).
- `fs-actions.ts` — `listDir()`: reads the **laptop's real disk** for the upload file picker
  (shortcuts, drive letters, symlink/junction resolution, 3000-entry cap). Localhost-only by
  design — do not expose publicly.
- `upload-bot/actions.ts` — `processBotDrop()`: Bot Drop finisher; `copyMessage` (HTTP Bot API)
  from the bot PM into the channel with the contract caption.
- `api/upload/route.ts` — **resumable chunk receiver** (`nodejs` runtime). `GET` returns the
  bytes already staged (resume point); `POST ?offset=` appends a chunk, replies `409` with the
  real offset if out of sync. `api/upload/complete/route.ts` — verifies the staged file size,
  then inserts an `upload_jobs` row (`origin='upload'`, `cleanup_source=1`).
- `api/stream/[partId]/route.ts` — **streaming proxy** (`nodejs` runtime). Authenticates via
  cookie, then proxies `Range` requests to the streamer service (`STREAMER_URL`, default
  `http://streamer:8080`). Pipes the 206 response body back to the browser's `<video>` element (intercepted and cached by the client-side Service Worker).
- `page.tsx` (main grid), `trash/page.tsx`, `upload/page.tsx`, `upload-bot/page.tsx`,
  `login/` (`page.tsx` + `actions.ts` + `LoginForm.tsx`). `loading.tsx`/`error.tsx` per route.

### `web/public/` — static assets
- `sw.js` — **client-side Service Worker**. Intercepts video range requests, caches 2 MB chunks in IndexedDB (`video-cache-db`), reconstructs partial responses, and runs LRU cache eviction targeting a 4 GB limit.

### `web/` — auth & config
- `lib/auth.ts` — `AUTH_COOKIE`, `sha256Hex` (shared by edge middleware + actions).
- `middleware.ts` — gate all routes on `SHA-256(APP_PASSWORD)` cookie; **no `APP_PASSWORD` ⇒
  auth off**. `/api/upload` and `/api/stream` are excluded from the matcher to avoid the 10 MB
  middleware body-size limit; both routes perform their own cookie auth check internally.

### `web/components/` — UI (client)
- `ServiceWorkerRegister.tsx` — registers the Service Worker (`sw.js`) on the client side (localhost/HTTPS).
- `DriveApp.tsx` — top-level app shell/state (largest component). `Sidebar.tsx` — nav/filters.
- `FileViews.tsx` — grid/list rendering of `DriveFile`s and folders (`FolderCard`/`FolderRow`) with checkboxes for multi-select, a star toggle, and a kebab action button (now ordered to stack correctly above thumbnails).
- `PreviewDrawer.tsx` — item detail + on-demand gallery (`getGallery`) + **video streaming**: `isPartStreamableVideo()` detects if the active media part has a browser-playable extension (.mp4/.webm/.m4v/.mov) and renders a `<video>` element sourced from `/api/stream/{partId}` (styled using `maxWidth`/`maxHeight` to shrink-to-fit the player area immediately, allowing clicks on letterbox areas to trigger `onClose`). All action buttons are removed from this drawer's top bar (delegated entirely to the external card/row kebab menus). Supports keyboard shortcuts for video controls. Supports `detailsOnly` mode to render the metadata/edit panel as a standalone popup without the full-screen photo/video stage layer. `FsBrowser.tsx` — laptop folder picker (drives `listDir`).
- `UploadManager.tsx` — upload queue UI + watcher/bot start/stop; **Source toggle**: "Upload
  from this device" (default → `FileUploader`) vs "Host path (advanced)" (`FsBrowser` + path).
  `FileUploader.tsx` — **resumable browser uploader** (16 MB chunks, auto-resume on drop via
  server offset, progress/speed, Retry, Pause/Resume, and persistent state across page reload via
  localStorage). Fallback token strips both `-` and `.` to satisfy
  `TOKEN_RE` in `staging.ts`. `TagManager.tsx` / `TagPicker.tsx` — category library +
  chip picker. `AppSkeleton.tsx` — loading skeleton.

---

## Cross-cutting conventions

- **Web ↔ laptop is async via tables only.** `upload_jobs` (commands), `watcher_heartbeat`
  (liveness). No direct RPC.
- **Idempotency keys:** `parts.channel_msg_id` (re-index safe + `copy_message` target),
  `items.slug` (multi-part grouping + download deep link; never re-written).
- **Error surfacing:** the bot DMs `OWNER_USER_ID` on un-indexable game captions and on purge
  summaries, so nothing fails silently.
- **Turso connection:** `libsql://` is rewritten to `https://` in the Python side (WebSocket
  transport is rejected with HTTP 400).
