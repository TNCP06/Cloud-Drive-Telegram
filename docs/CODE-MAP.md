# Code Map — file & function reference

Where things live and what each function does. Pair with [`ARCHITECTURE.md`](./ARCHITECTURE.md)
(concepts) and [`BUSINESS-FLOWS.md`](./BUSINESS-FLOWS.md) (operations). Line counts are
approximate and will drift — treat function names as the stable anchor.

---

## `bot/` — Python (Telegram bridge)

> **Module layout (bot.py was split for size):** `bot_config.py` (env, logging, `DATABASE_URL`),
> `pg_db.py` (Postgres client shim: `?`→`%s`, autocommit pool, `.execute().rows`),
> `tg_helpers.py` (pure helpers), `db_ops.py` (idempotent Postgres ops), `indexing.py`
> (channel indexing + thumbnail harvest + `index_bot_copy`), `db_backup.py` (daily DB backup
> → Telegram), `pikpak.py` (generic remote-download: `/pikpak` `/baidu` + `_ls`/`_jobs`, drive
> registry, ☁️ Cloud Drives inline-button browser + in-bot rclone worker). `bot.py` keeps the interactive handlers
> + `main()` and **re-exports** the names
> `index_history.py` imports (`from bot import …`). The streamer's background compression lives in
> `stream_compress.py` and seek-preview sprite generation in `stream_seekpreview.py`.

### `bot.py` (+ `bot_config` / `tg_helpers` / `db_ops` / `indexing`) — indexer + download server + purge
Pure helpers (`tg_helpers.py`, no I/O): `slugify` (non-ASCII titles get a stable md5-8 suffix of the
original title — CJK titles otherwise strip to a shared stub and collide distinct items into one;
kept in sync with the TS twin in `web/app/upload-bot/actions.ts`), `parse_caption` (the contract regex), `detect_kind`
(`media` vs `archive`), `get_file_meta` (returns `(file_name, file_size)` — videos/animations
that lack a `file_name` get a **synthetic name** (`video.mp4`/`animation.mp4`) so the web's
extension-based type detection can distinguish them from photos, which legitimately have no
file name), `derive_media_meta` (media caption fallback),
`pick_thumb_file_id`, `encode_thumbnail` (raw image bytes → compact **WebP** base64 via
Pillow, JPEG passthrough fallback). `process_next_in_queue` (Bot-Drop queue helper, in `bot.py`).
Postgres ops (`db_ops.py`, idempotent): `upsert_item` (`set_title` guard; preserves user-modified metadata on conflict), `upsert_part` (keyed on
`channel_msg_id`, cleans up orphan items if a part is reassigned), `recompute_totals`, `sync_tags` (**case-insensitive**: reuses an existing tag that differs only in capitalization),
`sync_album_tags` (keeps tags identical across the individual items split from one media album — slug prefix `m<media_group_id>-`),
`split_media_albums` (one-shot migration: splits any pre-existing multi-part **media** item into N single-part items, preserving tags/folder/privacy/favorite + per-part thumbnails; run from `post_init`, marker-guarded), `upsert_thumbnail`, `is_user_authorized`.
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
Lifecycle: `post_init`/`post_shutdown` (Postgres client, auto-migrations for `authorized_users` + `download_jobs` tables, commands menu registration, and **starts the PikPak download worker(s)**), `main` (handler registration +
`run_daily`). **Env:** `BOT_TOKEN`, `STORAGE_CHANNEL_ID`,
`OWNER_USER_ID`, `DATABASE_URL`, `AUTH_PASSWORD`/`APP_PASSWORD`.

### `pikpak.py` — generic remote-download (in `bot` process, rclone; PikPak + WebDAV drives)
`/pikpak <path>` / `/baidu <path>` pull a file from a cloud drive onto the VPS and feed it into
the **existing** `upload_jobs` → watcher pipeline; no new process/session. **Drives are data:**
`bot_config.DRIVES` (overridable via `DRIVES_JSON`) maps a command key → `{remote, prefix, folder,
display}`; `resolve_drive`/`drive_remote` build the `remote:prefix/path` target. PikPak is native
(`pikpak:`); Baidu/Quark/… route through the OpenList WebDAV remote (`openlist:`, prefix = mount).
Reusable cores `start_download(…, drive_key)` (validate via `rclone_stat`; **size policy: media
> `PIKPAK_MAX_BYTES` rejected, non-media > 2 GB accepted for splitting**; insert a `download_jobs`
row with `source=<drive>` + progress reply), `do_ls(…, drive_key)` (browse via `rclone_lsf`,
~50-entry cap), `jobs_text` (last 10 jobs across all drives, drive-tagged) — shared by generic cores
`_cmd_download`/`_cmd_ls` and the thin per-drive handlers `on_pikpak`/`on_ls`/`on_baidu`/`on_baidu_ls`,
`on_jobs` (`/pikpak_jobs`), **and** the ☁️ Cloud Drives inline-button menu (drive picker →
per-drive submenu, `menu:drives`/`drive:menu|browse|path|jobs:<key>` callbacks in bot.py).
`render_browser(…, drive_key)`/`browse_navigate` drive the interactive folder browser for any drive
(callback carries a tiny index into the cached listing + `user_data['pk_drive']` for the active drive
→ under Telegram's 64-byte cap). All gated by `is_user_authorized`.
Worker: `start_workers` (spawn `PIKPAK_MAX_CONCURRENT` `_worker_loop` tasks in `post_init`),
`_claim_next` (atomic `UPDATE … FOR UPDATE SKIP LOCKED`, returns `source`), `_process` (resolve
drive → `_rclone_copy` with retry+backoff + slow-transfer flags → parse `--stats-one-line` `%` →
throttled edit → hand off to `upload_jobs`, choosing `part_size = DRIVE_SPLIT_PART_MB` for oversized
non-media so the watcher splits it, else `4096`; staging wiped on failure). Progress writes carry
speed **and an ETA** (`_fmt_eta`, session-average rate) into `download_jobs.speed` + the message.
**Pause/Resume/Cancel buttons** on the progress message: `pause_download` (`dlp` → status `paused`;
worker raises `DownloadPaused` at its next throttled check and releases the job, keeping the
partial + `bytes_done`), `resume_download` (`dlr` → re-queue, resumes from the last byte),
`cancel_confirm`/`cancel_dismiss`/`cancel_download` (`dlx` → confirmation reply → `dlxy:<msg_id>`
sets `failed`/'cancelled by user', partial deleted; refused after the upload handoff).
`_classify_rclone_error`
distinguishes native (`rclone config`) from WebDAV (OpenList unreachable vs expired cookie → OpenList
UI). `_drive_title` files items under the drive's `folder`, mirroring remote subdirs. `ensure_schema`
(idempotent table+trigger migration incl. widening the status CHECK with `'paused'` + requeue jobs
stranded mid-download; `paused` survives restarts). Needs **rclone in the bot
image** + host `rclone.conf` bind-mounted; downloads land in the shared `staging` volume. **Env:**
`PIKPAK_*`, `DRIVES_JSON`, `DRIVE_SPLIT_PART_MB`, `RCLONE_BIN`. OpenList infra + runbook:
[`infra/openlist/`](../infra/openlist/README.md). One-check: `test_pikpak.py`.

### `watcher.py` — upload-queue executor (long-running, Telethon, **laptop OR server**)
Handles two job origins (`upload_jobs.origin`):
- **`local`** — file already on this machine. archive → `split_archive` (7-Zip); media → whole file.
- **`upload`** — file pushed via the web resumable endpoint into the shared staging dir.
  archive > part_size → **raw streaming split, no 7-Zip** (`write_window` copies one <2 GB byte
  window → upload → delete it → next); media/small → whole file. On success the staging dir is
  removed (`cleanup_source`).

`claim_next` (oldest `pending` → `running`; **preserves `parts_done`** so retries resume),
`set_progress`/`set_status`, `set_parts_done` (per-part checkpoint), `split_archive` (local 7-Zip),
`_send_part` (per-part transport: **local Bot API fast path** via `tg_botapi_upload.py` — bot
account, no FLOOD_PREMIUM_WAIT, `file:///staging/…` read directly by the server, part indexed
inline via `index_uploaded` because a bot gets no channel_post for its own posts; progress is
**estimated** by a ticker from a measured-throughput EMA since the server gives no byte callback;
Telethon fallback for laptop paths / API errors),
`resolve_staged_file` (the single file inside an upload's staging dir), `write_window` (raw byte
window copy, 8 MB buffer), `make_video_thumbnail` (ffmpeg frame at 1 s → temp JPEG),
`_store_thumbnails` (background: poll `parts` ~70 s, `INSERT OR IGNORE` thumbnail),
`_send_file_smart` (send a part as media; if Telegram can't process the photo — e.g. AVIF saved
as `.jpg` — **ffmpeg-convert to JPEG and retry as a photo** so it keeps a thumbnail/preview, else
fall back to a document so the upload never dies),
`process` (build plan `list`/`stream` → upload each part, checkpoint after each, cleanup temp
parts + staging dir on success), `resolve_channel`, `main` (poll loop, 5 s).
Writes `watcher.pid`. **`ffmpeg`** for media thumbnails; **7-Zip only for `local` archives**.
Imports `normalize_tags, build_caption, safe_name, collect_parts` from `worker.py`. Also
`import unpack` → spawns `unpack.worker_loop` in `main` (shares this process's Telethon client + 7z).

### `tg_botapi_upload.py` — fast upload transport (local Bot API, used by the watcher)
`available(path)` (config + `/staging` visibility gate), `send_part` (sendVideo/Photo/Document with
a `file://` path — the telegram-bot-api container mounts the staging volume, so the server reads
the bytes directly and uploads as the bot account → no FLOOD_PREMIUM_WAIT), `index_uploaded`
(inline `db_ops` indexing — a bot receives no channel_post update for its own posts). **Env:**
`TELEGRAM_API_URL`, `BOT_TOKEN`, `UPLOAD_VIA_BOT_API` (default on), `BOT_API_VISIBLE_PREFIXES`.

### `unpack.py` — archive-unpack worker (in the **watcher** process, Telethon + p7zip)
Extracts a stored multi-part archive item and re-stores its contents as normal (streamable) items,
so e.g. a video inside a password-protected 7z is watchable in-app without a local download. Polls
`unpack_jobs` (inserted by the web `unpackArchive` action). `_claim` (oldest queued + **scrub the
password in the same statement** — a CTE reads it before the UPDATE nulls it), `_download_and_concat`
(Telethon-download every part → ordered binary concat → the archive), `_extract` (async `7z x -p…`;
`-p` always passed so it never blocks on a prompt), `_stage_outputs` (each extracted file → own
staging dir + an `upload_jobs` row so the existing pipeline uploads + the bot indexes it; title nests
under `<archive>/…`; **files > 2 GB are kept on the VPS instead**: moved to
`_unpack/_keep/<jid>/…` + an `unpack_kept` row with `expires_at` = now + `UNPACK_KEEP_TTL_H` (72 h) —
the web lists them with play/download/keep-longer/compress/delete-now, `_sweep_keep` auto-deletes
them at expiry from the idle loop), `_process` (disk-guard `size×2.3` → download → extract → stage →
cleanup; **keeps the original archive**), **manual kept-file compression** (`_claim_compress`/
`_process_compress` — polls `kept_compress_jobs` from the idle loop, ffmpeg H.264 at the job's CRF +
`veryfast` under `nice -19`, live % into `message` via `-progress pipe:1`, replaces the kept file in
place only when ≥5% smaller and updates `unpack_kept` name/size), `ensure_schema` (also creates
`unpack_kept` + `kept_compress_jobs`), `worker_loop`. Password: never logged, passed to 7z via `-p`
(argv, single-user VPS).

### `worker.py` — standalone upload CLI (Telethon, **laptop**)
Same upload logic as the watcher but argparse-driven (`archive` / `media` subcommands).
`normalize_tags`, `build_caption`, `safe_name`, `split_with_7zip` (calls `sys.exit` on error —
contrast watcher's `split_archive` which raises), `collect_parts`, `make_progress`, `upload_parts`,
`run`, `main`.

### `index_history.py` — manual/automatic history back-indexer (Telethon, **laptop or server**)
Utility to fetch channel messages using Telethon (via `worker.session`) and sync them back to the Postgres catalog. Runs on-demand or automatically inside the watcher container on startup to back-fill any updates missed while the bot was offline.

### `streamer.py` — video streaming server (FastAPI + Telethon, **server/VPS**)
HTTP 206 Partial Content server for single-part and multi-part media items. If `TELEGRAM_API_URL` is set,
downloads files on-the-fly to a shared cache volume on the VPS disk using a local Telegram Bot API
server in `--local` mode (bypassing the 3Mbps download throttle) and streams directly to the browser.
Otherwise, falls back to Telethon `iter_download` with sparse 1 MB chunk cache & prefetching.

`_init_part_meta` streams **any** non-deleted part — media **and** documents (the old
`i.kind = 'media'` gate was removed) — so a document is downloaded/cached & range-served on demand
exactly like media, sharing the same cache + eviction limits. `MIME_MAP`/`_mime_from_filename` now
also cover **documents & images** (pdf, txt/md/csv, doc(x), xls(x), ppt(x), zip/7z/…, png/jpg/…) so
the browser previews them inline with the correct `Content-Type` (default stays `video/mp4` for
unknown extensions). Background **transcode is guarded to `mime.startswith("video/")`** so a previewed
PDF/doc is never fed to ffmpeg, and subtitle backfill is gated by a video-only `VIDEO_EXTS` set
(derived from `MIME_MAP`) so the expanded map doesn't let the STT loop pick up images/documents.
Key functions: `download_via_local_bot_api` (requests file download
from local Bot API server), `_evict_local_api_cache_if_needed` (scans shared volume and deletes oldest files
using mtime LRU policy), `_ensure_chunk_stream` (fallback Telethon disk-or-download),
`_init_part_meta` (Postgres query → `meta.json` creation), `_prefetch_worker` (fallback background prefetch),
`_get_tg_message` (in-memory message cache), `stream` (main route: parse Range, downloads via local Bot API
and streams local file if active, else chunk-streams via Telethon).
**Background video compression** (local Bot API mode) lives in **`stream_compress.py`**: `_transcode_worker`
(ffmpeg → smaller H.264 MP4 in the **persistent** `COMPRESSED_DIR`, keeps same resolution; drops the result +
writes a `.skip` marker if it isn't ≥5% smaller; runs under `nice -n 19` + optional `VIDEO_TRANSCODE_THREADS`
cap, preset default `veryfast`, so it never starves streaming/STT on the small VPS; **disk-guard**:
skipped (retried on a later view, no `.skip`) if free disk < src size + `CACHE_FREE_FLOOR_GB` — a
transcode can't collide with a big unpack/download on the shared 30 GB disk),
`_schedule_transcode` (fire-and-forget, dedup'd),
`_serve_local_file_range`/`_parse_range` (byte-range serve from any local file), `_compressed_path`,
`_evict_compressed_if_needed` (optional LRU cap), `init_semaphore` (called from streamer's lifespan).
**Background seek-preview generation** (ffmpeg thumbnails) lives in **`stream_seekpreview.py`**: `generate_seek_preview`
(ffmpeg → sprite sheet + VTT), `init_seekpreview_semaphore`, `vtt_path`/`sprite_path`, `has_preview`.
Endpoints: `GET /seek-preview/{part_id}` (VTT) and `GET /seek-preview/{part_id}/sprite` (JPEG sprite sheet).
`_schedule_seekpreview` (fire-and-forget, dedup'd by part_id).
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
text as a translation** — a failed segment is dropped, an all-failed/all-unchanged track returns None, and a
segment whose translation still contains **CJK script** (`_has_cjk`: Chinese/Japanese/Korean — source text that
leaked through untranslated) is dropped so an EN/ID track can't silently carry the original language;
`_translate_track` wraps it with retry/back-off so a transient Google no-op throttle doesn't drop a language),
`_build_vtt`/`_parse_vtt`/`_parse_ts` (VTT ↔ segments), `_subtitle_worker`/`run_subtitle_job` (single-job,
dedup'd via a `.done` marker), writes WebVTT to the **persistent** `SUBTITLES_DIR` + a `subtitles` Postgres row per
lang. **`repair_translations_on_disk`** (run at backfill start + each idle rescan; per-part `.tlok` marker holds
`ok`/`noop` when finalised or an attempt count while still missing a target) fixes videos whose translations
failed under the old logic — re-translating straight from the on-disk original VTT (`_repair_one_translation`),
so it needs **no video re-download**, only a few translate calls; it retries a part still missing a language up to
`SUBTITLE_TL_REPAIR_MAX` passes, and also recovers the case where the original text had leaked into the EN/ID files.
Subtitle generation is **absence-driven**: the streamer never runs STT on the streaming path (playback stays
off the shared STT semaphore), but watching a video **`_enqueue_priority_subtitle(part_id)`** bumps it to the
FRONT of the backfill queue and **wakes the idle loop** (`_subtitle_wake` event) so a just-opened/just-uploaded
video is subtitled next — still by the single serialized worker, never a parallel job. `streamer.py` exposes
`GET /subtitles/{part_id}` (returns `{langs, done}` — `done` lets the web player poll and load tracks **live**
until finalised) and `GET /subtitles/{part_id}/{lang}` (VTT), plus the **manual-subtitle endpoints**:
`POST /subtitles/{id}/manual` (raw SRT/VTT/ASS body → ffmpeg-converted to VTT via
`convert_to_vtt`/`save_subtitle_track` in `stream_subtitles.py`; saving a manual track writes the `.done`
marker so STT never overwrites it), `POST /subtitles/{id}/from-part/{src}` (Telethon-downloads a subtitle
file stored on the drive and attaches it), and `POST /subtitles/{id}/extract` +
`GET /subtitles/{id}/extract/status` (background softsub extraction: `_run_extract_job` reuses a cached
original or re-downloads it via the shared `_download_part_original` helper — the compressed copy has no
subtitle streams — then `extract_embedded_tracks` ffprobes and converts every embedded **text** stream;
bitmap PGS/DVD streams are reported as needing OCR). It also runs the
**backfill** (`_subtitle_backfill_loop`/`_next_backfill_part`/`_fetch_part_row`/`_backfill_one`): one
already-indexed video at a time (priority/viewed first → `.partial` repairs → oldest un-subtitled; back-to-back
by default, `SUBTITLE_BACKFILL_INTERVAL_S` adds optional pace), downloads → subtitles → deletes the download; **both** download **and** transcription failures are recorded
(`_backfill_failed`) and skipped for the session — so one un-transcribable video can't wedge the loop and
starve the rest. **Per-chunk repair:** a long video whose audio splits into several chunks transcribes each
independently; failed chunks don't abort the rest — the successes are cached (`part_{id}.chunks.json`),
**partial** subtitles are written, and a `.partial` marker (`partial_part_ids`/`_bump_partial`) makes
`_next_backfill_part`'s **repair pass** re-run ONLY the missing chunks on a later pass (resuming from cache),
until complete (`.done`) or `SUBTITLE_MAX_REPAIR_ATTEMPTS` is hit (finalised with whatever partial exists).
**Env:** `TG_API_ID`, `TG_API_HASH`, `STORAGE_CHANNEL_ID`, `DATABASE_URL`, `BOT_TOKEN`, `TELEGRAM_API_URL`
(enables local Bot API mode), `STREAMER_PORT` (default 8080), `CACHE_MAX_SIZE_GB` (cache limit),
`COMPRESSED_DIR`, `VIDEO_COMPRESS` (1/0), `VIDEO_CRF`, `VIDEO_PRESET` (default `veryfast`),
`SEEKPREVIEW_DIR`, `SEEKPREVIEW_COLS`, `SEEKPREVIEW_ROWS`, `SEEKPREVIEW_THUMB_W`, `SEEKPREVIEW_THUMB_H`,
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
- `db_backup.py` — `run_backup` JobQueue job: `pg_dump` → gzip → `send_document` to the channel →
  `index_bot_copy` under **Backup/CDT DB** (scheduled daily in `bot.py`). See BUSINESS-FLOWS § H.
- `login.py` — one-time Telethon login → creates `worker.session` (or any custom session, e.g. `streamer.session` via CLI argument).
- `schema.sql` — full PostgreSQL schema (auto-applied by the `postgres` service on first init;
  includes `now_text()`, `tags.color`, `bot_settings`, `authorized_users`). `apply_schema.py` —
  apply schema.sql to a non-Docker Postgres (`DATABASE_URL`).
- `run-all.cmd` — start bot + watcher minimized (Windows). `uninstall-autostart.ps1` — Windows startup deregistration.
- `Dockerfile` — shared image for bot + watcher (ffmpeg + p7zip). See root
  `docker-compose.yml` and [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the server/VPS deployment.

---

## `web/` — Next.js 15 (App Router, React 19, server actions)

### `web/lib/` — server-side data & helpers
- `db.ts` — `pg` Pool wrapped to expose the libSQL-style `db.execute(sql | {sql,args})` → `{rows}`
  surface (rewrites `?`→`$n`; BIGINT→Number). `server-only` keeps `DATABASE_URL` out of the browser.
- `types.ts` — `Kind`, `Tag`, `DriveFile` (UI shape; incl. `firstPartId` + `fileName` for
  streaming), `GalleryPart` (part ID, file name, and thumbnail data URL), `UploadJob` (now incl. `origin`,
  `partsDone`, `totalBytes`), `UploadOrigin`, `UploadStatus`, `WatcherStatus`, `FsEntry`/`FsListing`/`FsShortcut`.
- `staging.ts` — shared resumable-upload staging paths. `STAGING_ROOT`
  (`UPLOAD_STAGING_DIR`, `/staging` in Docker), `jobDir(token)`, `stagedFilePath(token,name)`
  with strict token/path-traversal guards. Used by the upload API + the watcher reads the same dir.
- `items.ts` — `getDriveData(space = "main" | "private")`: the main read. One batched query set → shapes `DriveFile[]` + `Tag[]`, **filtered by `is_private`**
  (Main = 0, Private = 1). The tag list only includes tags still used by an item in that space, so a
  tag whose last file moved to Private vanishes from Main. Sets each item's `thumb` to a **cover URL**
  `/api/thumb/{id}` when a cover exists (no base64 in the payload), fetches `firstPartId`/`fileName`
  for **every** item (media uses it for video streaming; non-media uses the first part's `file_name`
  so `fileTypeFor` can derive the document type + drive preview), and for archives, splits title into
  `family`/`version` via `parseTitle`. The shaped result is wrapped in **`unstable_cache`** (15s window,
  tag `drive-<space>`) so repeat loads skip the six Postgres queries; mutations bust it via
  `revalidateTag` (see `actions/_shared.ts` `refresh()`).
  The client stays live by **push, not polling**: Postgres triggers (`notify_drive_change`, statement-level
  on `items`/`folders`/`item_tags`/`tags` -- see `schema.sql`) raise `NOTIFY drive_changed`; the
  **`/api/events`** SSE route forwards it as an `drive` event and `DriveApp` `router.refresh()`es (debounced;
  a focus refresh is the fallback). A second trigger (`notify_upload_change` on `upload_jobs`) raises
  `NOTIFY upload_changed`, forwarded as an `upload` event so the **/upload page** (`UploadManager`) refreshes
  on job progress without polling. Both clients subscribe via the shared **`lib/useLiveRefresh.ts`** hook,
  which is hardened for flaky/mobile networks: it holds the `EventSource` only while the tab is visible AND
  online, reconnects with exponential backoff (not the browser's tight retry), and catch-up-refreshes on
  focus/online -- eliminating the `/api/events` QUIC idle-timeout/RTO/`NAME_NOT_RESOLVED` console spam.
  One shared `LISTEN` connection (both channels) fans out to all tabs via **`lib/driveEvents.ts`**
  (`subscribeChanges(fn)` → `(channel, payload)`), so N browsers cost 1 Postgres connection. So files indexed
  outside the tab (Bot Drop, history index) appear live within the cache window.
- `version.ts` — `parseTitle()`: split an archive title into `family` + `version` (e.g.
  `ReRudy 0.6.0` → `{family:"ReRudy", version:"v0.6.0"}`) for version grouping. Archives only.
- `kinds.ts` — `tagColorKey()` (deterministic name→palette colour) and coarse kind metadata
  (`media`/`archive`).
- `fileType.ts` — `fileTypeFor(item)` / `extOf(name)`: derives a **fine-grained file type**
  (PDF/Word/Spreadsheet/Presentation/Archive/Code/Text/Image/Video/Audio) from the first part's
  `file_name` extension (falls back to title, then coarse kind) — no schema change. Returns
  `{ id, label, icon, tint, badge, preview }` where `preview` (`pdf|text|word|sheet|image|video|none`)
  tells the viewer how to render the file inline; multi-part items are forced to `preview:"none"`.
  Drives the per-type icon/colour/badge in the grid/list and the inline document preview. Media
  **without** a usable file name (Telegram photos = extension-less JPEGs) falls back to the
  **image** icon; videos/animations are safe because `get_file_meta` now guarantees a synthetic
  `.mp4` extension even when Telegram supplies no name. The list & details rows show the item's
  **cover thumbnail** when one exists (only thumbless items fall back to the type icon).
  `displayName(item, showExtensions)` — the name shown in the grid (family for archives, title
  otherwise); appends the real extension from the first part's `fileName` when the "File name
  extensions" view toggle is on.
- `layoutPrefs.ts` — **Windows-Explorer-style view preferences** persisted to `localStorage`
  (`tcd_layout`). `LayoutMode` (`xl` (Gallery)|`large`|`medium`|`small`|`list`|`details`|`tiles`|`content`), `LayoutPrefs`
  (layout + `showSidebar`/`compact`/`showCheckboxes`/`showExtensions`/`showDetailItems`/`detailsPane`),
  `DEFAULT_PREFS`, `loadPrefs`/`savePrefs` (best-effort, SSR-safe), `LAYOUT_ICON`/`LAYOUT_LABEL`.
- `format.ts` — `sqliteToMs()` (SQLite datetime→epoch ms), byte/size formatting.
- `uploads.ts` — `getUploadJobs()` — read helper for the `/upload` page.
- `uploadDb.ts` — **client-side IndexedDB** persistence for the upload queue (`tcd-upload-db`).
  Stores each picked File's bytes + metadata (`putUpload`/`getAllUploads`/`deleteUpload`/
  `markUploadErrored`) so a page refresh **resumes** in-flight uploads instead of forcing a
  re-pick; records are deleted on handoff/remove so the blob only lives there while uploading.
  Best-effort (quota errors degrade to in-memory only).
- `gallery-cache.ts` — in-memory cache for `getGallery` results (`GalleryPart[]`). `icons.tsx` — SVG icons.

### `web/app/` — routes & server actions
- `actions.ts` — re-export **barrel** for the server actions, now split by domain under
  `app/actions/` (`items.ts`, `tags.ts`, `folders.ts`, `uploads.ts`, `thumbnails.ts`, `private.ts`,
  `subtitles.ts`, plus `_shared.ts` for `refresh`/`resolveTagId`). `@/app/actions` imports are unchanged. Inventory:
  Item (`items.ts`): `toggleFavorite`,
  `softDelete`, `restore`, `purgeNow` (on-demand permanent delete of a trashed item — Telegram
  `deleteMessage` + hard-delete rows; mirrors the bot's `purge_job`), `updateMetadata` (slug
  intentionally NOT changed on rename), `unpackArchive`/`getUnpackStatus` (queue/poll `unpack_jobs`),
`getActiveUnpack` (latest queued/running job — resumes the progress pill after a navigation),
  `listKeptFiles`/`deleteKeptFile`/`extendKeptFile` (unpack outputs over the Telegram cap kept on
  the VPS in `unpack_kept` — list them / delete file + row now / push `expires_at` out by N hours
  or to the `9999-12-31` sentinel = permanent until manually deleted; the web shares the
  `staging` volume).
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
  Subtitles (`subtitles.ts`): `listDriveSubtitleFiles` — non-private, non-deleted parts with a
  subtitle extension (.srt/.vtt/.ass/.ssa/.sub), for the SubtitleDialog's "from Telegram storage" picker.
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
  then inserts an `upload_jobs` row (`origin='upload'`, `cleanup_source=1`). **Idempotent**:
  if a job already exists for the staging dir (`source_path`) it returns that `jobId` instead of
  inserting a duplicate, so a client retrying `complete` after a reload can't double-queue.
- `api/stream/[partId]/route.ts` — **streaming proxy** (`nodejs` runtime). Authenticates via
  cookie, then proxies `Range` requests to the streamer service (`STREAMER_URL`, default
  `http://streamer:8080`). Pipes the 206 response body straight back to the browser's `<video>` element.
- `api/subtitles/[partId]/route.ts` (lang list) + `api/subtitles/[partId]/[lang]/route.ts` (one WebVTT
  track) — cookie-auth proxies to the streamer's `/subtitles/...` endpoints; the player loads these as
  `<track>`s. Manual-subtitle proxies (same auth pattern): `api/subtitles/[partId]/manual/route.ts`
  (POST raw SRT/VTT/ASS body + `?lang=&ext=`), `api/subtitles/[partId]/from-part/route.ts` (POST
  `{srcPartId, lang}` — attach a subtitle file stored on the drive), and
  `api/subtitles/[partId]/extract/route.ts` (POST starts the softsub-extraction job, GET polls its
  status).
- `api/seek-preview/[partId]/route.ts` and `api/seek-preview/[partId]/sprite/route.ts` — cookie-auth proxies to
  the streamer's `/seek-preview/...` endpoints (VTT with rewritten sprite URLs + JPEG sprite sheet).
- `api/kept/[id]/route.ts` (`nodejs` runtime) — downloads a **kept unpack output** (`unpack_kept`)
  straight off the shared staging volume (`/staging/_unpack/_keep/<rel_path>`); own cookie-auth check
  (same pattern as `/api/stream`), single-Range support so a multi-GB download can resume.
- `api/kept/[id]/subtitles/` (`nodejs`) — subtitle upload/list/serve for kept files, backed by
  `lib/keptSubs.ts` (auth + kept-path resolve + `<file>.<lang>.vtt` sibling paths + in-process
  SRT/VTT→WebVTT `toVtt`; NO ffmpeg/streamer — the streamer never mounts staging). `route.ts` GET
  lists langs (`done:true`), `manual/route.ts` POST converts+writes a sibling, `[lang]/route.ts` GET
  serves one VTT. `VideoPlayer`/`SubtitleDialog` take a `subtitleBase` prop so the kept full-screen
  viewer reuses the same track-loading + upload UI as drive videos (`localOnly` hides from-drive/
  extract). Siblings are cleaned by `deleteKeptFile` + the bot's `_sweep_keep`, moved on compress.
- `api/thumb/[itemId]/route.ts` (`nodejs` runtime) — serves an item's **cover thumbnail** bytes
  (first part by `channel_msg_id`) with `Cache-Control: public, max-age=600, stale-while-revalidate`.
  Keeps the cover out of the main page payload so the grid stays light at any scale; auth is enforced
  by middleware (path not excluded). The grid `<img>` lazy-loads → only on-screen covers are fetched.
- `stats/page.tsx` — **live system-map + stats page** (`/stats`, force-dynamic server component,
  gated by the global middleware like every route): storage totals from `parts`, items by kind,
  top tags, job counters (download/upload/unpack incl. `paused`), kept files, VPS disk via
  `statfsSync` on the staging volume, and a compact data-flow map (Store / Pull / Unpack / Watch).
- `page.tsx` (main grid), `private/page.tsx` (**PIN-gated Private space**: renders `PrivateLock` until the
  unlock cookie is present, then `DriveApp space="private"` with `getDriveData("private")`),
  `trash/page.tsx`, `upload/page.tsx`, `upload-bot/page.tsx`,
  `login/` (`page.tsx` + `actions.ts` + `LoginForm.tsx`). `loading.tsx`/`error.tsx` per route.

### `web/public/` — static assets
- `sw.js` — **kill-switch Service Worker**. The old video-chunk IndexedDB cache SW caused periodic playback stalls (4 MB-max responses + sequential fetches + full-store `getAll()` per write); this replacement unregisters itself, deletes `video-cache-db`, and intercepts nothing. Kept (and still registered) so clients running the old SW pick it up and get cleaned.
- `logo.png` — sidebar/brand logo. **Note:** `next.config.ts` uses `output: "standalone"`, which does **not** bundle `public/`; `web/Dockerfile` must `COPY .../public ./public` into the run stage or these assets 404 in production.

### `web/` — auth & config
- `lib/auth.ts` — `AUTH_COOKIE`, `sha256Hex` (shared by edge middleware + actions).
- `middleware.ts` — gate all routes on `SHA-256(APP_PASSWORD)` cookie. Behaviour:
  - **`APP_PASSWORD` unset** -- auth off; visiting `/login` redirects to `/` (no form shown).
  - **`APP_PASSWORD` set** -- all routes require the cookie; unauthenticated requests → `/login`.
  - `/api/upload`, `/api/stream`, and `/api/seek-preview` are excluded from the matcher to avoid
    the 10 MB middleware body-size limit; these routes perform their own cookie auth check internally.

### `web/components/` — UI (client)
- `ServiceWorkerRegister.tsx` — registers `sw.js` (localhost/HTTPS) — now only distributes the kill-switch SW above.
- `DriveApp.tsx` — top-level app shell/state (largest component; its pure view-model logic — section
  grouping `buildGroups`/`GROUP_OPTIONS`, the `SORTS` comparators, and the optimistic `fileReducer`/
  `folderReducer` overlays — lives in **`lib/driveView.ts`**). Takes a `space` prop ("main"|"private");
  a navbar **lock/unlock** icon enters/exits the Private space (exit clears the PIN cookie via `lockPrivate`).
  A topbar **"View" button** (replaces the old grid/list segmented toggle) opens `ViewMenu`; the chosen
  `LayoutPrefs` (from `lib/layoutPrefs.ts`, hydrated post-mount to avoid SSR mismatch) drive **8 layouts**
  via `renderItems` — icon grids `xl` (Gallery)|`large`|`medium`|`small` (one `FileCard`, sized by `.grid[data-layout]`
  CSS), `list` (`FileListItem` column-flow), `details` (the sortable `FileRow` table), `tiles`
  (`FileTile`), `content` (`FileContent`) — plus the `.app` class flags `no-sidebar`/`with-details`/
  `compact`/`show-checks`. When `detailsPane` is on, `DetailsPane` renders the **single-selected** item.
  **Render perf:** off-screen cells (`.card`/`.row`/`.tile`/`.crow`) use CSS `content-visibility: auto`
  (+ `contain-intrinsic-size`) so the browser skips layout/paint for what isn't scrolled into view —
  cheap virtualization across all 8 layouts. The version-collapsing + sorting (`collapseVersions`,
  `navList`, `visibleKeys`, the per-group collapsed lists) is **memoized** on its real inputs so a
  selection click / arrow keypress doesn't re-sort the whole library.
  The **sort menu** also carries a Windows-Explorer "Group by ›" side-flyout (`SubMenuItem`):
  `groupBy` (`none|name|type|tag|modified|size`) feeds `buildGroups()` → labelled sections rendered via
  `renderItems(section, false)` with the folders drawn **once** above all sections (the Recent view still
  defaults to date grouping when `groupBy` is `none`); grouping is suppressed while searching. The
  displayed-order key list `visibleKeys` (folders + `navList`) drives Ctrl+A, select-all, and Shift-range
  so a range can span folders, files, and groups.
  Selection UX: **files and folders share one selection model** — every selected entry is a tagged key
  (`i:<id>` / `f:<id>` in `selected: SelKey[]`; `selectedItemIds`/`selectedFolderIds` are derived for the
  actions) because item and folder IDs live in different tables and can collide. Clicking the empty content
  background or pressing **Esc** clears the selection (a window-level handler; the preview/detail popup
  `stopPropagation`s its own Esc in `PreviewDrawer` so closing it never drops the selection). **Arrow keys**
  move the focused entry — folders included (a global window listener via `keyNavRef`, so it works even
  before any click — lands on the selected/first entry; DOM-geometry nav via `[data-key]`, works in every
  layout) — **Shift+arrow** extends the range from the anchor (ranges may span folders + files + groups via the
  `visibleKeys` on-screen order), **Ctrl+arrow** moves focus only (Ctrl+Space toggles), **Ctrl/Cmd+A**
  selects all (folders + items), **Alt+Enter** opens the detail popup. Folder navigation has two shortcuts
  (Main "All files" view, when not typing): **Backspace** steps back through the visited folders
  (`folderHistory` back-stack — every folder change routes through `goToFolder`), and **Alt+↑** goes up
  one level to the parent folder (`goToParentFolder`). The floating **selection toolbar is
  icon-only** (tooltip/aria-label per button): **Download**/**Favorite** appear only when the selection
  contains files (folders can't be downloaded/starred; download opens the bot deep link per item, badge
  when >1), **Move** and **Delete** act on the whole mix (delete → `bulkSoftDelete` items + `deleteFolder`
  each folder, cascading), and for a single selection a **Details** action (item drawer or `FolderDetailsModal`).
  `folderStats` (memoized bottom-up over the acyclic folder tree) gives each folder its recursive item +
  sub-folder counts for the cards/details views.
  The toolbar (Main space, "All files", no search) carries an **Upload** button next to **New Folder**:
  it opens a small menu (**Upload files** / **Upload folder**) wired to hidden `<input type=file>`
  pickers (the folder one uses `webkitdirectory`). Picking starts the upload **immediately with no form**
  via `useUpload().addFiles(..., { autoKind: true })` + `runQueue()` — titles/tags are auto-filled and
  files **> ~2 GB are auto-split** (see `UploadProvider`/`uploadClient`). Hidden in the Private space
  (the upload pipeline indexes into Main only).
- `ViewMenu.tsx` — the **View dropdown**: a radio list of the 8 layouts (picks close the menu), a
  Details-pane toggle, and a "Show" group of on/off toggles (Sidebar / Compact view / Item check boxes /
  File name extensions / Detail items) — toggles keep the menu open. Built from the shared `Menu`/`MenuItem`.
- `DetailsPane.tsx` — **persistent right-hand details panel** (Windows "Details pane"). Shows the
  single selected entry's preview + metadata when exactly one is selected (else a hint): a **file**
  (type/size/parts/modified/added/status/tags) or a **folder** (type/total items/sub-folders/created/
  modified, counts from `folderStats`). Does not change card-click behavior. Desktop-only (hidden on
  mobile via CSS). Folders render in their own compact `.grid.folders` above the file grid. Its modals +
  empty state were extracted to `DriveDialogs.tsx` (`ConfirmDelete`, `ConfirmBulkDelete` — folder-aware
  message, `CreateFolderModal`, `RenameFolderModal`, `MoveToFolderModal`, `FolderDetailsModal` — the
  standalone folder "Properties" popup, `EmptyState`, `KeptFilesModal` — the "files kept on server"
  list (unpack outputs > 2 GB): download via `/api/kept/[id]` + delete-now, opened from a pill in
  `DriveApp` when `listKeptFiles()` is non-empty). `MoveToFolderModal` takes `moveItemIds` +
  `moveFolderIds` so one dialog moves any mix of items + folders (excluding each moving folder's own
  subtree as a target) and offers a cross-space destination (Move to Private / Move to Main drive). `PrivateLock.tsx` —
  the phone-style PIN keypad (also keyboard-typable); fixed **6-digit** PIN that **auto-submits** the
  moment the 6th digit is entered (no Enter / check tap needed). `Sidebar.tsx` — nav/filters (the **brand is clickable
  to exit** in the Private space); regular tags sorted by usage count (desc); a collapsible **Type Tags**
  group (Image/Video/**Archive**); the storage meter is a button that opens a `StorageDetail` breakdown popup.
  `VideoPlayer.tsx` (Plyr) loads generated subtitle `<track>`s (original + EN + ID) from `/api/subtitles`, and
  keeps **polling** for them while the video is open (until `done`) — appending new `<track>`s live (Plyr
  `captions.update:true` picks them up via `addtrack`) and auto-activating the preferred language the first
  time captions appear, so subtitles for a freshly-uploaded video show up **without reopening**.
  Volume/mute **and** the chosen caption language persist globally in `localStorage` (`subtitle-lang`, or
  `"off"`): each new video auto-activates the saved language via `pickCaptionLang` with the fallback chain
  **preferred → Indonesian → original**. Plyr's `previewThumbnails` is enabled **only after probing
  `/api/seek-preview` and confirming a valid (non-empty) VTT** — Plyr's parser crashes on a zero-cue track
  (`reading frames[0].text`), which is exactly what a video with no preview returns; previews self-heal on a
  later open once the background sprite job finishes.
- `FileViews.tsx` — per-layout rendering of `DriveFile`s and folders: `FileCard` (icon grids),
  `FileRow` (Details table), `FileTile` (horizontal tile), `FileContent` (wide metadata row),
  `FileListItem` (compact column-flow). All take `showExtensions` (extension on the name via
  `displayName`) and card-like ones take `showDetails` (the "Detail items" toggle — hides size/date/tags).
  `FolderCard` is a **compact horizontal tile** (icon + name + "N folders · M items" summary) sized to
  the **same column width as file cards** (the `.grid.folders` block carries `data-layout` and inherits
  the file grid's columns); `FolderRow` for the Details table. **Folders are first-class selectable cells**
  with the same `data-key` focus wiring as files. The FolderCard has **no select checkbox** — its selected
  state is shown as a **glowing accent ring around the folder icon** (`.card.folder.sel .folder-ico`, no
  card border), not the file card's border highlight; `FolderRow` keeps the table `row-check`. **Interaction model (Explorer-style):**
  shared `activation()` (files) / `folderActivation()` (folders) helpers wire every cell so a single click
  (or Space) **selects** (`onSelect`) and a double-click (or Enter) **activates/opens** (`onOpen`, folders
  enter the folder); cells are `tabIndex`-focusable with a focus ring, tagged `data-key` (`i:`/`f:`). Native
  `onClick`/`onDoubleClick` keep the two separate (no timer), and inner buttons `stopPropagation`. `onSelect`
  honours Ctrl/Meta (toggle) and Shift (range over the on-screen order, anchored by `selectAnchor` in
  `DriveApp`); **Alt+Enter** opens the entry's details popup (folder → `FolderDetailsModal`).
  Thumbless items render a **type-specific icon + colour** via `fileTypeFor` (PDF/Word/Excel/…)
  with an extension **badge** (e.g. "PDF", "XLSX"); the list view's Type column shows the
  fine-grained label.
  Relative timestamps (`fmtDate`/`trashDaysLeft`) render through a local **`ClientText`**
  helper that emits nothing on the server + first client paint and the real string after
  mount — they depend on the viewer's clock/timezone, so rendering them during SSR caused
  React hydration error #418.
- `PreviewDrawer.tsx` — item detail + on-demand gallery (`getGallery`) + **video streaming**: `isPartStreamableVideo()` detects if the active media part has a browser-playable extension (.mp4/.webm/.m4v/.mov) and renders **`VideoPlayer.tsx`** (a **Plyr** player) sourced from `/api/stream/{partId}`. The drawer keeps only `Esc` (close) and `Shift+←/→` (jump between parts/files) — Plyr owns the media shortcuts (←/→ seek 5s via `seekTime`, `f` fullscreen, `m` mute, space play); the document keydown is capture-phase so `Shift+arrows` are intercepted before Plyr's global handler. All action buttons are removed from this drawer's top bar (delegated entirely to the external card/row kebab menus). Supports `detailsOnly` mode to render the metadata/edit panel as a standalone popup without the full-screen photo/video stage layer. For non-media single-part files whose `fileTypeFor().preview` is `pdf|text|word|sheet`, the stage renders **`DocPreview.tsx`** instead of the static cover/icon. On the video stage the top bar has an **"Add subtitle"** button (CC icon) opening **`SubtitleDialog.tsx`** — three sources: upload a local SRT/VTT/ASS file (`/api/subtitles/{id}/manual`), attach a subtitle file already stored on the drive (`listDriveSubtitleFiles` server action in `actions/subtitles.ts` + `/api/subtitles/{id}/from-part`), or extract the video's embedded softsub streams (`/api/subtitles/{id}/extract`, polled every 3 s). The language comes from a dropdown but a `Movie.id.srt`-style file name overrides it (`guessLang`); on success the dialog bumps `subsBump` (part of the `VideoPlayer` key) to remount the player so the new track shows in the CC menu immediately. `FsBrowser.tsx` — laptop folder picker (drives `listDir`).
- `DocPreview.tsx` — inline document preview on the viewer stage. **PDF** → native `<iframe>`
  pointed at `/api/stream/{partId}` (needs `application/pdf` from the streamer). **Text/code/markdown**
  → fetched as text into a `<pre>`. **Word (.docx)** → `mammoth` (dynamically imported browser build
  `mammoth/mammoth.browser.js`) → HTML "paper". **Spreadsheets (.xlsx/.xls/.csv/…)** → `xlsx` (SheetJS,
  dynamically imported) → HTML table(s) with sheet tabs. All fetches send `Range: bytes=0-` to force
  the streamer to return the **whole** file (a plain GET returns only the first chunk in Telethon
  fallback mode). Size-capped (5 MB text / 30 MB office); anything else (incl. archives, multi-part)
  falls back to a download button. Heavy libs are `import()`-ed so they only load when such a file is
  opened. Ambient types for the mammoth browser entry live in `web/types/vendor.d.ts`.
- `VideoPlayer.tsx` — **Plyr** wrapper for the lightbox stage. Fills the whole `.viewer-stage` from the first frame (Plyr's wrapper/video are 100%×100%; the frame is letterboxed via `object-fit: contain`) so it never starts tiny while the stream loads. Plyr's `clickToPlay` is disabled and clicks are split by geometry: on the displayed (contain-fitted) frame → play/pause; on the letterbox → `onRequestClose` (skipped while fullscreen); on controls → Plyr. Poster dims (the data-URL thumbnail) seed the letterbox hit-test before the video reports its own size. Volume/mute are persisted to `localStorage` (`video-volume`/`video-muted`) and restored on `ready` — Plyr's own `storage` is off — so they never reset when switching videos. It initializes with `previewThumbnails: { src: '/api/seek-preview/{partId}?wait=true' }` which blocks on the streamer up to 60s so hover thumbnails appear dynamically mid-watch once background generation finishes.
- `UploadProvider.tsx` — **global upload context** mounted in `app/layout.tsx` so the client-side
  upload queue + runner live above the page tree and **survive client-side navigation**. Holds the
  `LocalItem[]` queue (ref + force-render), the sequential runner (`runQueue`, was in `UploadManager`),
  `pauseRun`/`cancelRun`, `addFiles`/`removeLocal`/`updateLocal`/`clearDone`, and `speed`. `addFiles`
  takes `UploadDefaults`; with `autoKind: true` (the one-click Upload button) the **kind is decided per
  file by size** — `autoKindFor(size)` routes files > ~2 GB to the split pipeline (`kind="archive"`,
  default part size) and keeps the rest as single `media`, tagging by real file type either way. Persists
  each item to IndexedDB (`lib/uploadDb.ts`) on add/edit and, on first mount, **rehydrates + auto-resumes**
  any in-flight uploads (the refresh-safety fix). On handoff (browser→VPS done) it deletes the persisted
  blob, marks the item `done`, and calls `startUpload(jobId)`. `useUpload()` is the consumer hook.
- `FloatingUploadPanel.tsx` — **global floating upload monitor** (also mounted in `app/layout.tsx`),
  hidden on `/upload` (the full manager is there) and when the queue is empty. Reads `useUpload()` to
  show overall progress + speed on any page; **expand/collapse** reveals two **tabs** — **Process**
  (in-flight + queued + failed) and **Completed** (handed off to Telegram) — each listing files with
  per-item stage (uploading %/queued/done/failed), retry/remove (queued items removable = cancel), and
  a "Clear completed" action on the Completed tab (auto-falls back to the tab that has rows). A
  **Pause/Stop (or Resume)** strip drives `pauseRun`/`cancelRun`/`runQueue` while uploading. Styled with
  the app's `--card`/`--sh-3` surface (`.fup*` classes in `globals.css`). Floating-layer layout rules:
  transient pills live in a top-right `.pill-stack`, `.fup` owns bottom-right, the selection toolbar
  bottom-center, and `body:has(.viewer)` hides pills + panel under a full-screen preview.
- `UploadManager.tsx` — **unified, queue-first** upload UI on `/upload`; now **consumes `UploadProvider`**
  via `useUpload()` for the queue + runner (the local queue state/runner moved out of this component).
  Live job progress arrives by **SSE, not polling** via the shared `useLiveRefresh("upload")` hook: it
  `router.refresh()`es (debounced) on each `upload` event (Postgres `upload_changed` NOTIFY on `upload_jobs`),
  with a tab-focus refresh as the fallback — the old 3 s/6 s `setInterval` poll is gone.
  Selecting files (multiple, or a whole **folder** via `webkitdirectory`) adds them to ONE queue as
  editable **ready** items (NOT uploading yet); you set Title/Tags per item, then **Start** runs the
  full pipeline in that same list: browser→VPS (client progress) → the watcher job (VPS→Telegram)
  appears and takes over. Folder files carry their relative path as the title so the bot recreates
  nested folders. Type toggle is **Media (left) / Archive (right)**; a type tag (**Image/Video/Archive**)
  is auto-added per file. Queued (not-yet-started) jobs have an **Edit** button (`updateUploadJob`).
  **Source toggle**: device (default) vs "Host path (advanced)" (`FsBrowser` + `enqueueUpload`). The
  list collapses to ~6 rows with **Show more / Show less**. The resumable engine lives in
  `lib/uploadClient.ts` (`uploadResumable` 16 MB chunks + server-offset resume; `autoTypeTag`,
  `withTag`, `newToken`; `autoKindFor` + `SPLIT_THRESHOLD_BYTES`/`DEFAULT_PART_MB` for size-based
  kind selection used by the one-click Upload button). Each chunk POST goes over **`XMLHttpRequest`**
  (helper `postChunk`) so `upload.onprogress` streams **real-time byte progress + rolling speed**
  (fetch has no upload-progress API → the bar would only advance once per finished 16 MB chunk); the
  caller's `AbortController` is bridged to `xhr.abort()` for pause/cancel.
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
- **DB connection:** self-hosted Postgres via `DATABASE_URL`. SQL keeps `?` placeholders; the
  shims (`web/lib/db.ts` → `pg`, `bot/pg_db.py` → `psycopg`) rewrite them to `$n`/`%s`.
