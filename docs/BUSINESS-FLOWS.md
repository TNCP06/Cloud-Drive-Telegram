# Business / Operational Flows

Step-by-step flows for every operation, with the exact code path. "Needs laptop?" tells you
whether the operation requires the laptop powered on. See [`ARCHITECTURE.md`](./ARCHITECTURE.md)
for components and [`CODE-MAP.md`](./CODE-MAP.md) for function-level detail.

---

## Quick reference: needs laptop?

| Operation | Needs laptop? | Why |
|---|---|---|
| Upload large archive (server mode) | No | Browser → resumable upload → server splits + MTProto. Needs the watcher running on a server (Flow A2) |
| Upload large archive (host path mode) | **Yes** | Files are on the host; watcher reads the path locally (Flow A) |
| Upload small media from phone | No | Post directly to channel; bot indexes |
| Bot Drop (web upload via PM) | No | Bot holds the file; web triggers `copyMessage` |
| Browse / search / edit title / edit tags | No | Pure Postgres writes |
| Download | No | Bot serves it with `copy_message` |
| Delete / restore | No | Soft delete in Postgres; bot purges later |

---

## A. Upload an archive (queue-driven, the normal path)

The web enqueues; the watcher executes. Web and watcher communicate **only** through
the `upload_jobs` table.

1. **Web** (`/upload`): user picks a folder/file via the host file browser
   (`fs-actions.listDir`), sets title/tags/part size → `enqueueUpload()` inserts a row into
   `upload_jobs` with `status='queued'`.
2. User clicks Start → `startUpload()` (or `startAllUploads()`) flips the row to
   `status='pending'`.
3. **Watcher** (`watcher.py`, polling every 5 s) `claim_next()` grabs the oldest `pending`
   row → `status='running'`.
4. `split_archive()` runs 7-Zip (`-v<size>m -mx=0`, store mode) → part files; progress is written
   back to `upload_jobs.progress` by a background `updater()` task.
5. Each part is sent with `client.send_file(..., force_document=True)` and caption
   `Title | i/total | tags`.
6. On success: split files are deleted (original is untouched), row → `status='done'`.
   On failure: row → `status='error'` with the message.
7. **Bot** independently sees each new `channel_post` → indexes it into `items`/`parts`
   (Flow C). The watcher and bot never talk directly.

> Manual alternative (no web/queue): run `worker.py archive <path> --title ... --tags ...`
> directly. Same upload logic, argparse CLI.

---

## A2. Upload from any device (server mode — hands-off)

The user uploads one file from a browser; the **server** stages it, splits it, and pushes it.
No manual 7-Zip. Requires the watcher running on the server (Docker — see DEPLOYMENT.md).

0. **One-click entry (no form):** the drive toolbar's **Upload** button (Main space → *Upload
   files* / *Upload folder*) skips the `/upload` form entirely. It calls `addFiles(..., autoKind:
   true)` then `runQueue()` so the upload **starts immediately**; title/tags are auto-filled from
   the filename + type, and each file's kind is chosen by size — **> 2000 MiB → split** (`archive`,
   default part size), otherwise single `media`. The **currently open folder's path is prefixed
   onto the title** (`folderPath` default), so the upload lands in the folder the user is standing
   in — server-side folder resolution splits titles on `/`. Steps 2–6 below are identical from there. The
   `/upload` page (below) remains for explicit control (per-item titles/tags, host-path mode).
1. **Web** (`/upload`, Source = "Upload from this device"): set title/tags/part size, pick a
   file → `FileUploader` sends it to `POST /api/upload` in **16 MB chunks**. A stable per-file
   token lets it **resume**: on a dropped connection it asks `GET /api/upload` for the bytes the
   server already has and continues from that offset (server returns `409` + real offset if a
   chunk arrives out of order). The file lands in the shared staging dir (`staging.ts`).
   The upload can be **paused** at any time. If the page is **refreshed**, the upload state is
   persisted in `localStorage`, prompting the user to re-select the file to resume.
2. When the whole file is staged, `POST /api/upload/complete` verifies the size and inserts an
   `upload_jobs` row: `origin='upload'`, `cleanup_source=1`, `status='queued'`.
3. User clicks Start → `status='pending'` (same as Flow A).
4. **Watcher** `claim_next()` → `process()`: `resolve_staged_file()` finds the file. archive size >
   part size → **raw streaming split** (`write_window` copies one <2 GB window → send → delete the
   part → `set_parts_done(i)`), capping disk at ~1 part; media/small → whole file. Caption
   `Title | i/total | tags` unchanged. **Transport** (`_send_part`): the fast path posts each part
   through the **local Bot API server** (`bot/tg_botapi_upload.py`, `file:///staging/…` — the
   server reads the shared staging volume directly and uploads as the **bot** account, which is
   NOT subject to the non-premium `FLOOD_PREMIUM_WAIT` throttle that capped Telethon uploads at
   ~5 MB/s). Telethon (user account) remains the fallback for laptop runs, files outside
   `/staging`, or any Bot API error.
5. On success: each part already deleted, the **whole staging dir is removed**, row → `done`.
   On failure: row → `error`; **Retry** (`retryUpload`) resumes from `parts_done` (skips parts
   already on Telegram), not from zero.
6. **Indexing**: Telethon-sent parts are indexed by the **bot** on each `channel_post` (Flow C).
   Bot-API-sent parts get **no** channel_post update (Telegram never echoes a bot its own posts),
   so the watcher indexes them **inline** (`tg_botapi_upload.index_uploaded` — same `db_ops`
   upserts, same slug rules). Download reassembly for these items is a plain concat
   (`copy /b a+b out` / `cat a b > out`), not `7z x`.

---

## A3. Remote-download from cloud drives (PikPak + Baidu via OpenList)

Pull a file straight from a cloud drive onto the VPS from Telegram, then let the normal upload
pipeline push it to the drive. All in the **bot** process ([`bot/pikpak.py`](../bot/pikpak.py));
rclone is baked into the bot image, your host `rclone.conf` is bind-mounted in. Commands are
gated to authorized users.

**Drives are data, not code.** `bot_config.DRIVES` (overridable via `DRIVES_JSON`) maps a command
key to an rclone remote + path prefix. **PikPak** uses its native `pikpak:` remote. **Baidu**
(and future Quark/115/…) have no native rclone backend, so they're mounted in the self-hosted
**OpenList** container and exposed over **WebDAV** — one rclone `webdav` remote `openlist:`,
prefix = the OpenList mount path (`baidu`). Adding a drive = one registry entry + two 1-line
handlers in `bot.py`; the pipeline below is unchanged. See [`infra/openlist/README.md`](../infra/openlist/README.md).

0. **Interactive (no typing):** open the bot's `/menu` → **☁️ Cloud Drives** → pick a drive
   (PikPak / Baidu / …) → **📂 Browse & download** → an inline-button browser lists that drive;
   tap 📁 to descend, 📄 to download. The submenu (Browse / Download by path / Recent jobs) is the
   same for every drive; the active drive is cached in `user_data` so the pk:* callbacks route to it.
1. **Discover** (optional, typed): `/pikpak_ls [folder]` / `/baidu_ls [folder]` → `rclone lsf` on
   that drive lists up to ~50 entries (root if omitted) so you can copy a path.
2. **Request**: `/pikpak <path>` or `/baidu <path>` → the bot runs `rclone lsjson --stat` on the
   resolved `remote:prefix/path` to validate + read the size. Rejected up front (no download, no job)
   if: the remote isn't configured / OpenList is unreachable / the drive cookie expired (→ a message
   pointing at `rclone config` for PikPak or the **OpenList UI** for WebDAV drives), the path is
   missing, or it's a folder. **Size policy** (all drives): a **media** file > **`PIKPAK_MAX_BYTES`**
   (2 GB) is **rejected** — a binary-split video can't be streamed. A **non-media** file > 2 GB is
   **accepted** and split later. **Disk-guard**: if free space on the staging volume `< size × 1.2`
   it first reclaims orphaned `_pikpak/<jid>` staging of done/failed jobs, then rejects if it still
   won't fit (so a big download can't fill the small shared VPS disk). Otherwise it inserts a
   `download_jobs` row (`status='queued'`, `source=<drive>`) and replies a progress message.
3. **Worker** (in-bot, `PIKPAK_MAX_CONCURRENT` asyncio tasks polling every 3 s, `FOR UPDATE SKIP
   LOCKED` claim) resolves the drive from `download_jobs.source` and runs a **resumable** download into
   `/staging/_pikpak/<jobid>/<name>`: the file is **pre-reserved** to its full size (`posix_fallocate`,
   truncate fallback) — disk reservation, so it can't run the volume out mid-transfer — and
   `rclone cat <remote:path> --offset <bytes_done>` streams from the last saved byte. Progress persists
   in `download_jobs.bytes_done`, so a deploy/restart (ensure_schema requeues `downloading`→`queued`),
   a transient error, or a throttle **resumes from where it left off instead of restarting at 0**.
   Speed is computed from the byte rate, and an **ETA** from the session-average rate (steadier than
   the instantaneous window on a throttly drive; skipped for the first ~15 s) — both go into
   `download_jobs.speed` (e.g. `5.12MB/s · ETA 23m`), written throttled (`pikpak_changed` NOTIFY,
   shown in `/pikpak_jobs`) and into the Telegram message edited live (≤ 1 / ~6 s).
   **Pause/Cancel buttons**: the progress message carries **⏸ Pause** (`dlp`) + **✖️ Cancel** (`dlx`)
   while the job is `queued`/`downloading`. *Pause* flips the row to `paused`: the worker releases it
   at its next throttled check (≤ ~5 s), **keeping** the partial file + `bytes_done`; because the
   worker session ends, the no-progress stall timer stops too. The message switches to
   **▶️ Resume** (`dlr`) + Cancel; Resume re-queues the job and the resumable download continues from
   the last byte. `paused` survives restarts (only `downloading` is requeued on boot) and its staging
   is protected from the orphan-reclaim. *Cancel* first asks for **confirmation** (a reply with
   `dlxy:<msg_id>` / `dlxn` buttons — mis-tap safe); confirmed, `cancel_download` sets `failed` /
   `error='cancelled by user'` and the partial is deleted (by the worker for a running job, directly
   for queued/paused). Once the file is handed to the upload pipeline (`downloaded`/`uploading`) both
   are **refused** — so cancel can never collide with the Telegram-channel upload.
   **Give-up policy**: abort only on a genuine no-progress stall (< `DRIVE_STALL_MIN_MB` in
   `DRIVE_STALL_WINDOW_S`, default 20 MB / 3 h) or the absolute backstop `DRIVE_MAX_DL_SECONDS`
   (default 7 days — multi-day transfers are fine) — a slow-but-advancing transfer is left to finish.
   A permanent error
   (auth/not-found) or give-up → job `failed`, **staging wiped**.
4. **Handoff**: on success the worker inserts an `upload_jobs` row — `origin='upload'`,
   `cleanup_source=1`, `status='pending'`, `title='<drive folder>/<remote subdirs>/<name>'`. The
   **`part_size`** encodes the split policy: media / non-media ≤ 2 GB → `4096` (single part,
   unchanged); non-media > 2 GB → **`DRIVE_SPLIT_PART_MB`** (default 1900) so the **watcher**
   raw-splits it into sequential binary parts `<name>.001`, `.002`, … (Flow A2 "stream" split) —
   one logical `item`, N `parts` rows. Reassemble by ordered `cat`. The watcher picks it up
   automatically (Flow A2 from step 4).
5. **Cleanup**: the watcher deletes the staging file after a successful upload (`cleanup_source=1`);
   the file is now safely in Telegram (indexing reads from Telegram, not the local copy). A
   `_track_upload` task follows the `upload_jobs` row to `done` → sets `download_jobs` → `done`,
   surfacing the watcher's whole-file part progress (*"uploading N part(s)…"*) while it runs. **Bot**
   indexes the new `channel_post`(s) (Flow C).
6. **Status**: `/pikpak_jobs` (or **☁️ Cloud Drives → <drive> → 📋 Recent jobs**) lists the last 10 download jobs
   across all drives (drive name tagged) with status + live `%`.

> **Orphan parts on failure (known limitation).** If a multi-part upload fails partway, the parts
> already sent to Telegram are indexed as a partial item (e.g. showing 2/4). This is a pre-existing
> property of the watcher's multi-part upload, shared with browser uploads; the download job is
> marked `failed`. Cleaning up orphan parts would require touching the watcher (out of scope here).

---

## A4. Unpack a stored archive → stream its contents ([`bot/unpack.py`](../bot/unpack.py))

Goal: watch a video that lives *inside* a stored (possibly password-protected, possibly split) 7z
without downloading it locally. You can't stream from inside an archive, so the archive is extracted
on the VPS and its contents are re-stored as normal items — the video then streams like any other.

1. **Trigger (web only)**: an archive item's kebab → **Unpack archive** → a dialog takes an optional
   password → the `unpackArchive` server action inserts an `unpack_jobs` row (`item_id` + `password`,
   `status='queued'`). Guarded: archive-kind only, and refused if one is already queued/running.
2. **Worker** (`unpack.worker_loop`, inside the **watcher** process — it has the Telethon client +
   p7zip). `_claim` grabs the oldest queued job and **scrubs the password in the same statement**
   (CTE reads it, UPDATE nulls it → it never lingers in the DB beyond the seconds before claim).
3. **Disk-guard** (`size × 2.3` must be free — archive + extracted output; nothing is copied
   twice since > 2 GB outputs are renamed into `_keep`), then `_download_and_concat` Telethon-downloads every
   part (resuming across Telegram FLOOD_PREMIUM_WAIT, with **live byte progress** — "downloading
   part 2/4 — 962/1900 MB", throttled ≤ 1 DB write / 5 s — so a multi-minute part never looks
   frozen) and concatenates them in part order → the
   archive (ordered concat reconstructs both 7z-native multi-volumes and raw binary splits). The
   concatenated archive is **cached** under `_unpack/_cache/<item_id>` so a wrong-password retry
   re-extracts without re-downloading (deleted on success; swept after `UNPACK_CACHE_TTL_H`). `_extract`
   runs `7z x -p… -o…` (`-p` always passed so 7z never blocks on a prompt). **Nested/disguised
   archives**: when a password is given, `_deep_extract` peels inner archives that 7z detects by
   content signature — e.g. a password-protected RAR hidden inside a `.jpg` — dropping the container,
   up to `UNPACK_MAX_DEPTH`. Wrong/missing password → `BadPassword` → `failed` (cache kept for retry).
4. **Re-store**: `_stage_outputs` moves each extracted file into its own staging dir and inserts an
   `upload_jobs` row (`origin='upload'`, `cleanup_source=1`; **media → streamable**, else document;
   title nests under `<archive> (unpacked)/…`). The existing watcher pipeline (Flow A2 step 4) uploads
   them and the **bot** indexes them (Flow C) — the video appears in the drive, streamable (Flow E2).
   **Exception — files > 2 GB** (`PIKPAK_MAX_BYTES`): re-uploading would only raw-split them into
   parts again, so they are **kept on the VPS** instead: moved to `_unpack/_keep/<jid>/…` and
   recorded in **`unpack_kept`** (`rel_path`, `size`, `expires_at` = now + `UNPACK_KEEP_TTL_H`,
   default 72 h). The web dashboard shows a *"N file(s) kept on server"* pill → a modal listing them
   with **Download** (`/api/kept/[id]`, Range-resumable, streams off the shared staging volume) and
   **Delete now** (`deleteKeptFile` — removes file + row immediately). The worker's idle sweep
   (`_sweep_keep`, every ~10 min) deletes any file past its expiry.
5. **Original archive is kept** (never deleted). The worker cleans its own temp dirs; per-file staging
   dirs are cleaned by the watcher after upload. Progress/errors on `unpack_jobs` (`unpack_changed`
   NOTIFY). Password: never logged, passed to 7z via `-p` (argv, single-user VPS).

---

## B. Upload media directly (from phone, no watcher host path)

1. Post the photo/video/document to the channel **as media** (not an archive), optionally with
   a contract caption.
2. **Bot** `on_channel_post` → `detect_kind()` = `media` → if caption invalid, `derive_media_meta()`
   fabricates a title (caption line → filename → date). Media is never rejected.
3. Bot harvests Telegram's built-in thumbnail (`harvest_thumbnail()` → `get_file` → `encode_thumbnail`
   re-encodes to **WebP** → base64 → `thumbnails`). If a local Telegram Bot API server is configured, the bot reads the local file directly from the shared volume (`telegram-bot-api-data`) instead of downloading it over HTTP.
4. Albums (multiple files sent together) are **split** — each member becomes its **own**
   single-part item (slug `m<media_group_id>-<msgid>`), with tags kept identical across the
   members via `sync_album_tags`. They are no longer merged into one multi-part item.

---

## C. Index & validate (bot, real-time — the heart)

Triggered by any new `channel_post` in `STORAGE_CHANNEL_ID` ([`bot/bot.py`](../bot/bot.py)
`on_channel_post`):

1. `detect_kind()` — not a file → ignore (plain text post).
2. `parse_caption()` against the contract.
   - Match → index.
   - No match **and** `media` → `derive_media_meta()`, index anyway.
   - No match **and** `archive` → `warn_owner()` DM, **do not index**.
3. Compute `slug` + `part_number` (see kind table in ARCHITECTURE §5).
4. `upsert_item` (resolves folders recursively and extracts the final title segment if the title has a `/` path, e.g., "Movies/Sci-Fi/Inception" creates "Movies" -> "Sci-Fi" folders and saves the item with title "Inception" under the "Sci-Fi" folder ID) → `upsert_part` (keyed on `channel_msg_id`, which deletes the old item if it becomes an orphan after part reassignment) → `recompute_totals` →
   `sync_tags` → (media) `harvest_thumbnail`. All idempotent.
5. `set_title=has_caption` guards title overwrites: a captionless media member won't overwrite
   a title set by a captioned one. Album members (`media_group_id`) are indexed as individual
   single-part items and then `sync_album_tags` re-applies the union of the album's tags to every
   sibling (slug prefix `m<media_group_id>-`), order-independently.

---

## D. Bot Drop & Telegram Interactive Upload — upload via the bot's PM

Bypasses Vercel's request-size limit: the **bot** holds the bytes, the **web** only sends a
small API call. Alternatively, the user can complete the upload entirely within Telegram.

1. **Intake**: User DMs or forwards one or more files (Photo, Video, or Document) to the bot.
   - If not authorized, access is denied (see authorization below).
   - If the file has a caption matching the contract (`Title | part/total | tags`), the bot bypasses the interactive questionnaire and copies the file directly to the storage channel.
   - If authorized but the file does not have a valid caption contract, the bot initiates the interactive questionnaire (waiting for Title, then Tags).
   - **Album/Media Group Grouping**: Multiple files forwarded simultaneously (sharing the same `media_group_id`) are grouped into a single upload flow under a single questionnaire.
   - **Queuing**: If a user sends a new file while another upload questionnaire is active, it is placed in `upload_queue` and processed sequentially after the active flow completes.
   - The bot also sends a web link: `/<web>/upload-bot?msg_id=<id>&chat_id=<id>` as an alternative.
2. **Finishing via Web**:
   - User opens the web link, completes Title & Tags, and clicks Save.
   - `processBotDrop()` (server action) calls Telegram `copyMessage` to copy the file into the storage channel with the contract caption `Title | 1/1 | tags`.
3. **Finishing via Telegram**:
   - The user replies to the bot's message with a custom Title, or clicks/types `/skip` to use the auto-caption Title (derived from filename or media date).
   - The bot then asks for Tags. The user replies with comma-separated tags, or clicks/types `/skip` to skip/use auto-tags.
   - Once the metadata is in, the bot **tidies the chat**: it deletes the questionnaire trail
     (its Title/Tags prompts, the user's typed replies, and any queue notices — tracked in each
     flow's `flow_msg_ids`), leaving the original file(s) and the final "Success!" summary. Cancel
     paths clean up the same way.
   - The bot compiles the caption `Title | 1/1 | tags` and copies the file(s) into the storage
     channel. A **multi-file album is split**: each member is copied **individually** (its own
     contract caption) and indexed as its **own** single-part `media` item sharing the one Title/
     Tags — they are no longer grouped into a single multi-part item.
4. **Indexing — inline, NOT via Flow C.** Telegram does **not** send a `channel_post` update for
   a message the **bot itself** posted, so `on_channel_post` never fires for Bot-Drop copies. The
   bot therefore indexes each copied post **inline** right after the copy via `index_bot_copy`
   (one call per file — albums are split into individual items), and the web finisher does the same via `processBotDrop`'s
   `indexBotDrop`. Both harvest the thumbnail and are idempotent (keyed on `channel_msg_id`), so
   a later `index_history.py` pass simply skips already-indexed messages. This is the fix for
   "bot-sent files never appearing on the dashboard."

---

## E. Download (no laptop)

1. **Web**: item ⋮ → Download → opens deep link `https://t.me/<bot>?start=<slug>`.
2. **Bot** `on_start` (authorized users only): decode slug → look up all `parts.channel_msg_id` for the
   item (active only, `deleted_at IS NULL`).
3. For each part, `copy_message(chat_id=user, from_chat_id=channel, message_id=...)` with a
   0.3 s gap (flood limits). File lands in the user's Telegram chat → full-speed download from
   Telegram's servers, any device.

---

## E3. Bot Authorization (Access Control)

Users can be authorized to use download & upload flows:
1. **Password Auth**: User types `/auth <password>` (where password is `AUTH_PASSWORD` or `APP_PASSWORD` in `.env`). Upon matching, their user ID is saved in the `authorized_users` database table.
2. **Owner Approval**: When an unauthorized user attempts to use the bot, the owner (`OWNER_USER_ID`) is notified. The owner can type `/approve <user_id>` to authorize them or `/revoke <user_id>` to revoke access.
3. **Authorized List**: The owner can run `/list_users` to see all authorized accounts.

> `copy_message` is a reference op → bypasses the 50/20 MB Bot API limits **and** hides the
> source channel (unlike `forward_message`).

---

## E2. Video streaming (no laptop, no download — YouTube-style)

In-browser playback of media videos (`.mp4`, `.webm`, `.m4v`, `.mov`) without downloading the whole
file first. This supports both single-part and multi-part media (e.g. photos/videos in an album).

1. **Web** (PreviewDrawer): `isPartStreamableVideo(activePart, item.kind)` detects if the active media
   part has a browser-playable extension → renders `<video src="/api/stream/{partId}">` instead of
   a static thumbnail image.
2. **Browser** `<video>` sends: `GET /api/stream/123` with `Range: bytes=0-`.
3. **Next.js** (`api/stream/[partId]/route.ts`): verifies auth cookie, proxies the request
   (incl. Range header) to `http://streamer:8080/stream/123`.
4. **Streamer** (`streamer.py`):
   * **If Local Bot API Server is configured (`TELEGRAM_API_URL` set):**
     a. Convert the target Telethon message media into a Bot API `file_id` using `pack_bot_file_id`.
     b. Query the local Bot API `/getFile` endpoint, which downloads the whole file to the shared cache volume on the VPS disk.
     c. Read and stream the requested byte range directly from the local file in 1MB blocks to serve the browser.
     d. Evict oldest accessed files from the shared cache directory using a strict LRU cache policy once it reaches `CACHE_MAX_SIZE_GB`.
     e. Skip sparse chunking and prefetching entirely since the whole file is locally available.
   * **Fallback Mode (No Local Bot API Server):**
     a. First request → query Postgres for `parts.channel_msg_id` + `file_size`, create `meta.json`.
     b. Download the requested chunk(s) via Telethon `iter_download` on cache miss.
     c. Serve the requested range as `HTTP 206 Partial Content` with `Content-Range`.
     d. Defer background **prefetch** — after successfully yielding the requested chunks, start the background prefetch worker to download chunks ahead up to the buffer limit.
5. **Subsequent requests** (browser auto-requests next range):
   * In Local Bot API mode: Served instantly from the local cached file (zero delay on seeks).
   * In Fallback mode: Served from the sparse chunk cache on disk.
6. **Seek**:
   * In Local Bot API mode: Instantaneous (standard file seek to requested byte offset).
   * In Fallback mode: Browser sends `Range: bytes=<new-offset>-`. Streamer immediately cancels any active prefetch task for the current part and awaits its complete cancellation before downloading the new chunk.
7. **Background compression (local Bot API mode):** the first view streams the **original** from
   the (evictable) Bot API cache so there's no extra wait, while a background `ffmpeg` job
   transcodes a smaller, browser-playable H.264 copy into the **persistent** `COMPRESSED_DIR`
   (same resolution → no visible quality loss; the size win is from efficient re-encoding).
   Once ready, subsequent views serve the compressed copy (less VPS bandwidth). If the result
   isn't ≥5% smaller it's discarded and a `.skip` marker prevents re-tries. The served variant is
   **pinned per playback** so the file size never changes between a load and its seeks. **When the
   compressed copy is written, the original is deleted from the Bot API cache** (it's dead weight —
   fresh loads serve compressed; an in-progress stream's open fd keeps working on Linux). Tunable via
   `VIDEO_*` / `COMPRESSED_*` env (`VIDEO_COMPRESS=0` disables it). Fallback (non-local) mode does
   not compress.
   * The old per-device Service Worker chunk cache was removed (it caused periodic playback
     stalls); the browser's native `<video>` buffering handles the original→compressed size
     change by simply re-requesting ranges against the newly reported size.
8. **Background seek-preview generation:** on first view (local Bot API mode), the streamer also fires
   a background seek-preview sprite-sheet job (`stream_seekpreview.py`). ffmpeg extracts thumbnails at
   regular intervals and assembles them into a sprite sheet JPEG + a VTT mapping file in the persistent
   `seekpreviews` volume. The web player (`VideoPlayer.tsx`) unconditionally initializes Plyr with the 
   VTT endpoint passing `?wait=true`. The streamer blocks this request for up to 60s while generating, 
   so the thumbnails dynamically pop into the progress bar mid-watch without requiring a page refresh.
   Once seek-preview finishes, it kicks off the heavy background compression task so they don't fight
   for CPU concurrently.
9. **Limitations:**
   * Local Bot API Mode: Supports single-part and multi-part media, cold start buffer delay of ~5-15s to download the file from Telegram to the VPS (at full network speed, e.g. 50MB/s), subsequent seeks and repeat views are instant.
   * Fallback Mode: Strictly throttled to ~3Mbps by Telegram's remote MTProto interface.

## E4. Automatic subtitle generation (background, Groq Whisper)

Subtitles are produced by **one** background worker (`stream_subtitles.py`, separate from compression),
**if subtitles don't already exist**. Watching a video does **not** run STT on the streaming path; instead
it **bumps that video to the front of the backfill queue** (`_enqueue_priority_subtitle` + a wake event)
so a just-opened/just-uploaded video is subtitled next — still by the single serialized worker, never a
parallel job — and the **web player polls `/api/subtitles/{partId}` and loads the tracks live** as they
land (no reopen needed). The job:

1. `ffmpeg` extracts the audio as time-sliced 16 kHz mono FLAC chunks (`SUBTITLE_CHUNK_SECONDS`,
   default 600s) to stay under Groq's per-file cap.
2. Each chunk is transcribed via Groq's **free Whisper API** (`whisper-large-v3-turbo`, falling back to
   `whisper-large-v3`). Multiple `GROQ_API_KEYS` are **rotated on rate-limit (429)** for failover;
   segment timestamps are offset per chunk and merged.
3. The original-language track is written, then translated to **English + Indonesian** via
   `deep-translator` (timestamps preserved; a target equal to the source language is skipped).
4. WebVTT files are saved to the **persistent** `/subtitles` volume and a `subtitles` Postgres row is
   written per language; a `.done` marker prevents re-runs.

The web player loads them as caption `<track>`s via `/api/subtitles/{partId}` + `/{lang}`. **Subtitle
files are kept as long as the video is indexed** (the `/subtitles` volume is never auto-evicted).
Disabled with `SUBTITLE_GEN=0` or an empty `GROQ_API_KEYS`.

**Retroactive backfill (slow):** a background loop (`_subtitle_backfill_loop`) also subtitles
**already-indexed** videos that predate this feature. It processes **one video at a time** (serialized by
the same subtitle semaphore): picks the next part — **recently-viewed videos jump the queue first**
(view-priority above), then incomplete `.partial` repairs, then oldest un-subtitled — downloads it via the
local Bot API, generates subtitles, then **deletes the download** to reclaim disk (peak footprint = one
video). The idle loop is **woken early** when a viewed video is enqueued, so it doesn't nap through it. By default
it runs **back-to-back** (`SUBTITLE_BACKFILL_INTERVAL_S=0`) — the 3 rotating `GROQ_API_KEYS` absorb Groq
rate limits and each video's own processing time provides natural spacing; set the interval >0 to add an
extra pace if needed. A failed part is skipped for the rest of the session (retried after a restart) so one
bad file can't block the queue. Toggle with `SUBTITLE_BACKFILL`.

## E5. Private space (PIN-gated hiding)

A parallel drive distinguished by `items.is_private` / `folders.is_private` (default 0 = Main):

1. **Enter:** the navbar **lock icon** navigates to `/private`, which shows a phone-style **PIN keypad**
   (`PrivateLock`, also keyboard-typable). The PIN is checked server-side against env `PIN`; on success a
   session unlock cookie is set. **Exit** (the open-lock icon or clicking the sidebar **brand**) clears the
   cookie, so a PIN is required on **every** entry.
2. **Move in/out:** the **"Move to…"** action on files and folders offers a "Move to Private" /
   "Move to Main drive" destination. Moving a folder cascades `is_private` to all descendant folders +
   items. The move **does not change `updated_at`** (hiding isn't a content change).
3. **Hiding:** `getDriveData("main")` only returns `is_private = 0` rows, so private items — and all their
   sizes/tags/storage analytics — never reach the Main page. A tag whose last Main item moved to Private
   disappears from the Main tag list (and appears in the Private one). Private data is fetched and rendered
   **only after** the PIN cookie is present, so it never ships to the Main page.


---

## F. Delete → restore → purge (soft delete)

1. **Delete (web)**: `softDelete()` sets `items.deleted_at = now`. Item disappears from the
   grid immediately; the Telegram message is untouched. The UI shows a confirmation dialog
   (`ConfirmDelete` in `DriveApp.tsx`) before calling it. Note: `updated_at` is deliberately
   **not** bumped (neither here nor on restore) so a restored item keeps its original
   date/sort position instead of looking freshly uploaded — trash status lives only in
   `deleted_at`.
2. **Restore (web, /trash)**: `restore()` sets `deleted_at = NULL`. Lossless because nothing
   was actually deleted from Telegram, and `updated_at` is preserved.
3. **Purge (bot, daily 03:00 UTC)**: `purge_job` finds items with `deleted_at <= now-7days` →
   `delete_message` each part in the channel → hard-delete `thumbnails`/`parts`/`item_tags`/
   `items` rows → DM the owner a summary.
4. **Purge now (web, /trash)**: `purgeNow(id)` is the on-demand equivalent of step 3 for a
   single trashed item — `deleteMessage` each part via the Telegram Bot API (needs `BOT_TOKEN`
   + `STORAGE_CHANNEL_ID` in web env), then the same hard-delete of DB rows. Guarded to items
   with `deleted_at IS NOT NULL`; irreversible, so the UI requires confirmation. Exposed in the
   Trash view via the context menu and preview drawer ("Delete permanently").

> The `jobs` table (`type IN ('delete','reindex')`) exists in the schema as a generic
> web→bot command queue but the current delete path uses `deleted_at` + the scheduled purge,
> not `jobs`.

---

## G. Tag / category management (web, pure Postgres)

All in [`web/app/actions.ts`](../web/app/actions.ts), no Telegram involved:

- `listTags` / `createTag` / `recolorTag` / `deleteTag`.
- `renameTag` is merge-aware: renaming onto an existing name re-points `item_tags` to the
  existing tag and drops the duplicate.
- Colour: `tags.color` stores a palette key (`sage`, `ochre`, …). The web now **persists a
  concrete colour at creation** (`createTag`/`resolveTagId` write `tagColorKey(name)` when none is
  chosen) and **pins** the derived colour before a rename, so a tag's colour never shifts on
  rename/edit. `tagColorKey()` derives over a fixed 9-key set, so adding new palette options doesn't
  reshuffle existing derived colours. Tags created by the **bot** still have empty colour and fall
  back to on-read derivation until the web touches them.

---

## H. Daily database backup ([`bot/db_backup.py`](../bot/db_backup.py))

A JobQueue job in the bot runs once a day (**04:00 UTC**, after the 03:00 purge):

1. `pg_dump --clean --if-exists --no-owner --no-privileges` of the whole database to a temp
   `.sql`, then gzip → `cdt-db-backup-YYYY-MM-DD.sql.gz` (the date is in the filename).
2. `send_document` it to the storage channel with the caption contract
   `Backup/CDT DB/cdt-db-backup-YYYY-MM-DD | 1/1 | backup`.
3. Index it inline via `index_bot_copy` (the bot gets no `channel_post` update for its own posts),
   so it appears in the dashboard under the auto-created folder path **Backup → CDT DB**.

Backups are **kept forever** (the dump is tiny); prune one manually from the dashboard Trash if
ever needed. Restore (disaster recovery), after downloading a backup out of the drive:

```bash
gunzip -c cdt-db-backup-YYYY-MM-DD.sql.gz | psql "$DATABASE_URL"
```

`pg_dump`/`psql` (postgresql-client-16) ship in the bot image; the client major matches the
`postgres:16` server.

---

## I. Watcher lifecycle & control

- **Process control**: The web UI start/stop buttons for the bot and watcher have been completely removed. The processes are started manually (laptop mode) or managed as always-on compose services (Docker mode). The actions `startWatcher`, `stopWatcher`, `startBot`, and `stopBot` are no longer active in the web page.
- **Startup Back-Indexing**: In Docker/server mode, the watcher service container automatically runs `index_history.py` before starting `watcher.py` on startup. This uses Telethon to back-index any channel messages/updates that occurred while the services were offline, keeping Postgres synchronized.

---

## Operational runbook

**Server/VPS (Docker):** `docker compose up -d --build` — see [`DEPLOYMENT.md`](./DEPLOYMENT.md)
for EC2/VPS setup, the staging volume, and migration to another host.

**Laptop:**

```bat
:: one-shot: start bot + watcher minimized, logging to bot.log / watcher.log
bot\run-all.cmd
```

- Bot must be **admin** in the storage channel (to receive `channel_post` and to `delete_message`).
- First Telethon run prompts for phone + code → creates `worker.session` (never commit it).
- Web env: `DATABASE_URL`, `NEXT_PUBLIC_BOT_USERNAME` (download link), `BOT_TOKEN` +
  `STORAGE_CHANNEL_ID` (Bot Drop). Bot env adds `OWNER_USER_ID`, `TG_API_ID/HASH`,
  `SEVENZIP_PATH`.
