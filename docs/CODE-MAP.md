# Code Map — file & function reference

Where things live and what each function does. Pair with [`ARCHITECTURE.md`](./ARCHITECTURE.md)
(concepts) and [`BUSINESS-FLOWS.md`](./BUSINESS-FLOWS.md) (operations). Line counts are
approximate and will drift — treat function names as the stable anchor.

---

## `bot/` — Python (Telegram bridge)

> **Module layout (bot.py was split for size):** `bot_config.py` (env, logging, Turso URL
> rewrite), `tg_helpers.py` (pure helpers), `db_ops.py` (idempotent Turso ops), `indexing.py`
> (channel indexing + thumbnail harvest + `index_bot_copy`). `bot.py` keeps the interactive
> handlers + `main()` and **re-exports** the names `index_history.py` imports (`from bot import …`).
> The streamer's background compression lives in `stream_compress.py`.

### `bot.py` (+ `bot_config` / `tg_helpers` / `db_ops` / `indexing`) — indexer + download server + purge
Pure helpers (`tg_helpers.py`, no I/O): `slugify`, `parse_caption` (the contract regex), `detect_kind`
(`media` vs `archive`), `get_file_meta`, `derive_media_meta` (media caption fallback),
`pick_thumb_file_id`, `encode_thumbnail` (raw image bytes → compact **WebP** base64 via
Pillow, JPEG passthrough fallback). `process_next_in_queue` (Bot-Drop queue helper, in `bot.py`).
Turso ops (`db_ops.py`, idempotent): `upsert_item` (`set_title` guard for albums; preserves user-modified metadata on conflict), `upsert_part` (keyed on
`channel_msg_id`, cleans up orphan items if a part is reassigned), `recompute_totals`, `sync_tags` (**case-insensitive**: reuses an existing tag that differs only in capitalization), `upsert_thumbnail`, `is_user_authorized`.
`index_bot_copy` (`indexing.py`): indexes a channel post the **bot created itself** (`copy_message`/`copy_messages`)
inline — Telegram sends no `channel_post` update for a bot's own messages, so `on_channel_post`
never fires for Bot-Drop uploads; idempotent, stores `file_id=NULL` (streamer resolves on demand),
harvests the thumbnail from the original private-chat message.
Handlers: `on_channel_post` (`indexing.py`; index new and edited channel posts, Flow C), `harvest_thumbnail` (if the post has no thumbnail
yet — common for video, which Telegram generates asynchronously — it schedules
`_deferred_harvest` instead of giving up), `_deferred_harvest` (background task: wait 60 s, then
`forward_message` to owner chat to re-fetch the now-generated thumbnail, store it, delete the
forward), `on_start` (download via `copy_message` for authorized users), `on_auth` / `on_approve` / 
`on_revoke` / `on_list_users` / `on_set_web_url` (user authorization, management, and settings), `send_main_menu` / `on_menu` (button-driven main menu and guide),
`on_cancel` (cancel active file upload), `on_private_file` (interactive PM upload & Bot Drop intake),
`on_private_text` / `on_callback_query` (interactive questionnaire and menu callbacks), `purge_job` (daily trash purge).
Lifecycle: `post_init`/`post_shutdown` (Turso client, auto-migration for `authorized_users` table, and commands menu registration), `main` (handler registration +
`run_daily`). **Env:** `BOT_TOKEN`, `STORAGE_CHANNEL_ID`,
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
parts + staging dir on success), `resolve_channel`, `main` (poll loop, 5 s).
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
**Background video compression** (local Bot API mode) lives in **`stream_compress.py`**: `_transcode_worker`
(ffmpeg → smaller H.264 MP4 in the **persistent** `COMPRESSED_DIR`, keeps same resolution; drops the result +
writes a `.skip` marker if it isn't ≥5% smaller; runs under `nice -n 19` + optional `VIDEO_TRANSCODE_THREADS`
cap, preset default `veryfast`, so it never starves streaming/STT on the small VPS),
`_schedule_transcode` (fire-and-forget, dedup'd),
`_serve_local_file_range`/`_parse_range` (byte-range serve from any local file), `_compressed_path`,
`_evict_compressed_if_needed` (optional LRU cap), `init_semaphore` (called from streamer's lifespan).
`stream` serves the original on the first view (instant) while transcoding in the background; later views
serve the compressed copy. The served variant is **pinned per playback** (`_serving_variant`: a fresh load /
`bytes=0-` re-evaluates and prefers compressed once ready; seeks reuse the pin) so file size never changes
mid-session. Once the compressed copy is written, `_transcode_worker` calls back into the streamer's
`_reclaim_original_after_compress` to **delete the now-redundant original** from the Bot API cache (an
in-progress stream's open fd keeps reading on Linux); the compressed copy is persistent.
**Background subtitle generation** (Groq Whisper STT) lives in **`stream_subtitles.py`**: `_extract_audio_chunks`
(ffmpeg → time-sliced 16 kHz FLAC), `_transcribe_chunk`/`_transcribe_audio` (`_transcribe_chunk_groq` =
`audio/transcriptions` with **key + model failover** on 429, then **`_transcribe_chunk_cloudflare`** = optional
Cloudflare Workers AI Whisper **failover** used only when every Groq attempt fails, normalised to Groq's shape;
`stt_available` gates the backfill on any provider being configured; chunks transcribed **CONCURRENTLY**, each on its own rotating key bounded by
`SUBTITLE_CHUNK_CONCURRENCY`, with an **in-job retry/back-off** `SUBTITLE_CHUNK_RETRY_ATTEMPTS`/`_DELAY_S` so a
transient blip is retried while the video is still on disk; segment offsets merged; each chunk's segments pass
`_is_confident_segment` — drops Whisper **hallucinations** on music/silence via verbose_json stats
(`no_speech_prob`/`avg_logprob`/`compression_ratio`, thresholds `SUBTITLE_NO_SPEECH_MAX`/`_LOGPROB_MIN`/`_COMPRESSION_MAX`)
and `_collapse_consecutive_dupes` merges looping repeats, so a non-speech video no longer yields a **random-language**
track and **only a chunk with confident speech sets the source language**), `_translate_segments`
(deep-translator → EN/ID, timestamps preserved; uses the **known source language** mapped to a valid code
via `_make_translator` — `zh`→`zh-CN` — because Google's auto-detect silently echoes some content untranslated
(e.g. Traditional Chinese → English); **never emits the original
text as a translation** — a failed segment is dropped, an all-failed/all-unchanged track returns None;
`_translate_track` wraps it with retry/back-off so a transient Google no-op throttle doesn't drop a language),
`_build_vtt`/`_parse_vtt`/`_parse_ts` (VTT ↔ segments), `_subtitle_worker`/`run_subtitle_job` (single-job,
dedup'd via a `.done` marker), writes WebVTT to the **persistent** `SUBTITLES_DIR` + a `subtitles` Turso row per
lang. **`repair_translations_on_disk`** (run at backfill start + each idle rescan; per-part `.tlok` marker holds
`ok`/`noop` when finalised or an attempt count while still missing a target) fixes videos whose translations
failed under the old logic — re-translating straight from the on-disk original VTT (`_repair_one_translation`),
so it needs **no video re-download**, only a few translate calls; it retries a part still missing a language up to
`SUBTITLE_TL_REPAIR_MAX` passes, and also recovers the case where the original text had leaked into the EN/ID files.
Subtitle generation is **absence-driven, NOT view-driven**: the streamer does *not* schedule subtitles when
a video is played — it is produced solely by the background backfill loop, which subtitles any indexed video
that has no subtitles yet (keeps playback off the shared STT semaphore). `streamer.py` exposes
`GET /subtitles/{part_id}` (langs) and `GET /subtitles/{part_id}/{lang}` (VTT), and runs the
**backfill** (`_subtitle_backfill_loop`/`_next_backfill_part`/`_fetch_part_row`/`_backfill_one`): one
already-indexed video at a time (back-to-back by default; `SUBTITLE_BACKFILL_INTERVAL_S` adds optional pace),
downloads → subtitles → deletes the download; **both** download **and** transcription failures are recorded
(`_backfill_failed`) and skipped for the session — so one un-transcribable video can't wedge the loop and
starve the rest. **Per-chunk repair:** a long video whose audio splits into several chunks transcribes each
independently; failed chunks don't abort the rest — the successes are cached (`part_{id}.chunks.json`),
**partial** subtitles are written, and a `.partial` marker (`partial_part_ids`/`_bump_partial`) makes
`_next_backfill_part`'s **repair pass** re-run ONLY the missing chunks on a later pass (resuming from cache),
until complete (`.done`) or `SUBTITLE_MAX_REPAIR_ATTEMPTS` is hit (finalised with whatever partial exists).
**Env:** `TG_API_ID`, `TG_API_HASH`, `STORAGE_CHANNEL_ID`, `TURSO_*`, `BOT_TOKEN`, `TELEGRAM_API_URL`
(enables local Bot API mode), `STREAMER_PORT` (default 8080), `CACHE_MAX_SIZE_GB` (cache limit),
`COMPRESSED_DIR`, `VIDEO_COMPRESS` (1/0), `VIDEO_CRF`, `VIDEO_PRESET` (default `veryfast`),
`VIDEO_MIN_COMPRESS_MB`, `VIDEO_TRANSCODE_CONCURRENCY`, `VIDEO_TRANSCODE_THREADS` (0 = auto),
`COMPRESSED_MAX_SIZE_GB` (0 = keep forever), `SUBTITLE_GEN` (1/0),
`SUBTITLES_DIR`, `GROQ_API_KEYS` (comma-separated), `GROQ_STT_MODELS`,
`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_STT_MODEL` (optional Whisper failover),
`SUBTITLE_TARGET_LANGS`,
`SUBTITLE_CHUNK_SECONDS`, `SUBTITLE_CHUNK_CONCURRENCY` (0 = #keys), `SUBTITLE_CHUNK_RETRY_ATTEMPTS`,
`SUBTITLE_CHUNK_RETRY_DELAY_S`, `SUBTITLE_TRANSLATE_RETRY`, `SUBTITLE_TRANSLATE_RETRY_DELAY_S`,
`SUBTITLE_TL_REPAIR_MAX` (passes to fix a part's missing target langs, default 5),
`SUBTITLE_BACKFILL` (1/0), `SUBTITLE_BACKFILL_INTERVAL_S`,
`SUBTITLE_MAX_REPAIR_ATTEMPTS` (cross-pass repair budget, default 4).


### Supporting scripts
- `login.py` — one-time Telethon login → creates `worker.session` (or any custom session, e.g. `streamer.session` via CLI argument).
- `schema.sql` — full Turso schema (run once; already includes `tags.color`). `run-migration.py`
  — generic one-off SQL migration runner (`python run-migration.py <file.sql>`).
  `migration-folders.sql` — the folders-feature migration. `status.py` — quick DB status dump.
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
- `items.ts` — `getDriveData(space = "main" | "private")`: the main read. One batched query set →
  shapes `DriveFile[]` + `Tag[]`, **filtered by `is_private`** (Main = 0, Private = 1). The tag list
  only includes tags still used by an item in that space, so a tag whose last file moved to Private
  vanishes from Main. Sets each item's `thumb` to a **cover URL** `/api/thumb/{id}` when a cover
  exists (no base64 in the payload), fetches `firstPartId`/`fileName` for media items (for video
  streaming), and for archives, splits title into `family`/`version` via `parseTitle`. The shaped
  result is wrapped in **`unstable_cache`** (30s window, tag `drive-<space>`) so repeat loads skip
  the six Turso queries; mutations bust it via `revalidateTag` (see `actions/_shared.ts` `refresh()`).
- `version.ts` — `parseTitle()`: split an archive title into `family` + `version` (e.g.
  `ReRudy 0.6.0` → `{family:"ReRudy", version:"v0.6.0"}`) for version grouping. Archives only.
- `kinds.ts` — `tagColorKey()` (deterministic name→palette colour) and kind metadata.
- `format.ts` — `sqliteToMs()` (SQLite datetime→epoch ms), byte/size formatting.
- `uploads.ts` — `getUploadJobs()` — read helper for the `/upload` page.
- `gallery-cache.ts` — in-memory cache for `getGallery` results (`GalleryPart[]`). `icons.tsx` — SVG icons.

### `web/app/` — routes & server actions
- `actions.ts` — re-export **barrel** for the server actions, now split by domain under
  `app/actions/` (`items.ts`, `tags.ts`, `folders.ts`, `uploads.ts`, `thumbnails.ts`, `private.ts`, plus
  `_shared.ts` for `refresh`/`resolveTagId`). `@/app/actions` imports are unchanged. Inventory:
  Item (`items.ts`): `toggleFavorite`,
  `softDelete`, `restore`, `purgeNow` (on-demand permanent delete of a trashed item — Telegram
  `deleteMessage` + hard-delete rows; mirrors the bot's `purge_job`), `updateMetadata` (slug
  intentionally NOT changed on rename).
  Folders: `createFolder`, `renameFolder`, `deleteFolder` (cascade soft-deletes items), `moveItemsToFolder`,
  `moveFolderToFolder` (reparent; rejects cycles into self/descendants).
  Bulk ops: `bulkToggleFavorite`, `bulkSoftDelete`, `bulkRestore`, `bulkPurgeNow`.
  Private (`private.ts`): `isPrivateUnlocked`/`unlockPrivate`/`lockPrivate` (PIN cookie gate, env `PIN`),
  `moveItemsPrivacy`/`moveFolderPrivacy` (toggle `is_private` between Main ⇄ Private; land at the
  destination root; **never touch `updated_at`**; folder move cascades to all descendant folders + items).
  Tags: `listTags`, `createTag` (case-insensitive: won't create a capitalization-only
  duplicate), `recolorTag`, `renameTag` (merge-aware), `deleteTag`. `resolveTagId` (internal):
  maps a name to a tag id, reusing an existing tag that differs only in case; used by
  `updateMetadata` so assigning "game" links to existing "Game" instead of forking a new tag.
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
  from the bot PM into the channel with the contract caption, then **indexes the new post inline**
  (`indexBotDrop` helper: forwards the post once to harvest metadata + thumbnail → upserts
  item/part/tags/thumbnail) because the bot's own channel post produces no `channel_post` update.
  Best-effort; `index_history.py` back-fills if it fails.
- `api/upload/route.ts` — **resumable chunk receiver** (`nodejs` runtime). `GET` returns the
  bytes already staged (resume point); `POST ?offset=` appends a chunk, replies `409` with the
  real offset if out of sync. `api/upload/complete/route.ts` — verifies the staged file size,
  then inserts an `upload_jobs` row (`origin='upload'`, `cleanup_source=1`).
- `api/stream/[partId]/route.ts` — **streaming proxy** (`nodejs` runtime). Authenticates via
  cookie, then proxies `Range` requests to the streamer service (`STREAMER_URL`, default
  `http://streamer:8080`). Pipes the 206 response body back to the browser's `<video>` element (intercepted and cached by the client-side Service Worker).
- `api/subtitles/[partId]/route.ts` (lang list) + `api/subtitles/[partId]/[lang]/route.ts` (one WebVTT
  track) — cookie-auth proxies to the streamer's `/subtitles/...` endpoints; the player loads these as
  `<track>`s.
- `api/thumb/[itemId]/route.ts` (`nodejs` runtime) — serves an item's **cover thumbnail** bytes
  (first part by `channel_msg_id`) with `Cache-Control: public, max-age=600, stale-while-revalidate`.
  Keeps the cover out of the main page payload so the grid stays light at any scale; auth is enforced
  by middleware (path not excluded). The grid `<img>` lazy-loads → only on-screen covers are fetched.
- `page.tsx` (main grid), `private/page.tsx` (**PIN-gated Private space**: renders `PrivateLock` until the
  unlock cookie is present, then `DriveApp space="private"` with `getDriveData("private")`),
  `trash/page.tsx`, `upload/page.tsx`, `upload-bot/page.tsx`,
  `login/` (`page.tsx` + `actions.ts` + `LoginForm.tsx`). `loading.tsx`/`error.tsx` per route.

### `web/public/` — static assets
- `sw.js` — **client-side Service Worker**. Intercepts video range requests, caches 2 MB chunks in IndexedDB (`video-cache-db`), reconstructs partial responses, and runs LRU cache eviction targeting a 4 GB limit. **Validates the cached size against the server once per SW lifetime and namespaces chunk keys by size** (`partId_size_chunk_i`) so an original→compressed variant switch can't mix two variants' bytes (purges stale chunks on a size change).
- `logo.png` — sidebar/brand logo. **Note:** `next.config.ts` uses `output: "standalone"`, which does **not** bundle `public/`; `web/Dockerfile` must `COPY .../public ./public` into the run stage or these assets 404 in production.

### `web/` — auth & config
- `lib/auth.ts` — `AUTH_COOKIE`, `sha256Hex` (shared by edge middleware + actions).
- `middleware.ts` — gate all routes on `SHA-256(APP_PASSWORD)` cookie; **no `APP_PASSWORD` ⇒
  auth off**. `/api/upload` and `/api/stream` are excluded from the matcher to avoid the 10 MB
  middleware body-size limit; both routes perform their own cookie auth check internally.

### `web/components/` — UI (client)
- `ServiceWorkerRegister.tsx` — registers the Service Worker (`sw.js`) on the client side (localhost/HTTPS).
- `DriveApp.tsx` — top-level app shell/state (largest component). Takes a `space` prop ("main"|"private");
  a navbar **lock/unlock** icon enters/exits the Private space (exit clears the PIN cookie via `lockPrivate`).
  Folders render in their own compact `.grid.folders` above the file grid. Its modals + empty state were
  extracted to `DriveDialogs.tsx` (`ConfirmDelete`, `ConfirmBulkDelete`, `CreateFolderModal`,
  `RenameFolderModal`, `MoveToFolderModal`, `EmptyState`). `MoveToFolderModal` works for both items and
  folders and offers a cross-space destination (Move to Private / Move to Main drive). `PrivateLock.tsx` —
  the phone-style PIN keypad (also keyboard-typable); fixed **6-digit** PIN that **auto-submits** the
  moment the 6th digit is entered (no Enter / check tap needed). `Sidebar.tsx` — nav/filters (the **brand is clickable
  to exit** in the Private space); regular tags sorted by usage count (desc); a collapsible **Type Tags**
  group (Image/Video/**Archive**); the storage meter is a button that opens a `StorageDetail` breakdown popup.
  `VideoPlayer.tsx` (Plyr) loads generated subtitle `<track>`s (original + EN + ID) from `/api/subtitles`.
  Volume/mute **and** the chosen caption language persist globally in `localStorage` (`subtitle-lang`, or
  `"off"`): each new video auto-activates the saved language via `pickCaptionLang` with the fallback chain
  **preferred → Indonesian → original**.
- `FileViews.tsx` — grid/list rendering of `DriveFile`s and folders. `FolderCard` is a **compact
  horizontal tile** (icon + name, no big thumbnail) to avoid wasted space; `FolderRow` for list view.
  File cards keep checkboxes for multi-select, a star toggle, and a kebab action button.
  Relative timestamps (`fmtDate`/`trashDaysLeft`) render through a local **`ClientText`**
  helper that emits nothing on the server + first client paint and the real string after
  mount — they depend on the viewer's clock/timezone, so rendering them during SSR caused
  React hydration error #418.
- `PreviewDrawer.tsx` — item detail + on-demand gallery (`getGallery`) + **video streaming**: `isPartStreamableVideo()` detects if the active media part has a browser-playable extension (.mp4/.webm/.m4v/.mov) and renders **`VideoPlayer.tsx`** (a **Plyr** player) sourced from `/api/stream/{partId}`. The drawer keeps only `Esc` (close) and `Shift+←/→` (jump between parts/files) — Plyr owns the media shortcuts (←/→ seek 5s via `seekTime`, `f` fullscreen, `m` mute, space play); the document keydown is capture-phase so `Shift+arrows` are intercepted before Plyr's global handler. All action buttons are removed from this drawer's top bar (delegated entirely to the external card/row kebab menus). Supports `detailsOnly` mode to render the metadata/edit panel as a standalone popup without the full-screen photo/video stage layer. `FsBrowser.tsx` — laptop folder picker (drives `listDir`).
- `VideoPlayer.tsx` — **Plyr** wrapper for the lightbox stage. Fills the whole `.viewer-stage` from the first frame (Plyr's wrapper/video are 100%×100%; the frame is letterboxed via `object-fit: contain`) so it never starts tiny while the stream loads. Plyr's `clickToPlay` is disabled and clicks are split by geometry: on the displayed (contain-fitted) frame → play/pause; on the letterbox → `onRequestClose` (skipped while fullscreen); on controls → Plyr. Poster dims (the data-URL thumbnail) seed the letterbox hit-test before the video reports its own size. Volume/mute are persisted to `localStorage` (`video-volume`/`video-muted`) and restored on `ready` — Plyr's own `storage` is off — so they never reset when switching videos.
- `UploadManager.tsx` — **unified, queue-first** upload UI. Selecting files (multiple, or a whole
  **folder** via `webkitdirectory`) adds them to ONE queue as editable **ready** items (NOT uploading
  yet); you set Title/Tags per item, then **Start** runs the full pipeline in that same list:
  browser→VPS (client progress) → the watcher job (VPS→Telegram) appears and takes over. Folder files
  carry their relative path as the title so the bot recreates nested folders. Type toggle is **Media
  (left) / Archive (right)**; a type tag (**Image/Video/Archive**) is auto-added per file. Queued
  (not-yet-started) jobs have an **Edit** button (`updateUploadJob`). **Source toggle**: device
  (default) vs "Host path (advanced)" (`FsBrowser` + `enqueueUpload`). The list collapses to ~6 rows
  with **Show more / Show less**. The resumable engine lives in `lib/uploadClient.ts`
  (`uploadResumable` 16 MB chunks + server-offset resume; `autoTypeTag`, `withTag`, `newToken`).
  `TagManager.tsx` / `TagPicker.tsx` — category library + chip picker (picker dedupes existing tags case-insensitively).
  `ThemeToggle.tsx` — light/dark switch (flips `data-theme` on `<html>`, persists to localStorage
  `tcd_theme`; theme is applied pre-paint by an inline script in `layout.tsx`). `AppSkeleton.tsx` — loading skeleton.

---

## Cross-cutting conventions

- **Web ↔ laptop is async via tables only.** `upload_jobs` (commands + progress). No direct RPC.
- **Idempotency keys:** `parts.channel_msg_id` (re-index safe + `copy_message` target),
  `items.slug` (multi-part grouping + download deep link; never re-written).
- **Error surfacing:** the bot DMs `OWNER_USER_ID` on un-indexable game captions and on purge
  summaries, so nothing fails silently.
- **Turso connection:** `libsql://` is rewritten to `https://` in the Python side (WebSocket
  transport is rejected with HTTP 400).
