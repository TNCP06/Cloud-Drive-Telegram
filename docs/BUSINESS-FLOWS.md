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
| Browse / search / edit title / edit tags | No | Pure Turso writes |
| Download | No | Bot serves it with `copy_message` |
| Delete / restore | No | Soft delete in Turso; bot purges later |

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
   part size → **raw streaming split** (`write_window` copies one <2 GB window → `send_file`
   force_document → delete the part → `set_parts_done(i)`), capping disk at ~1 part; media/small
   → whole file. Caption `Title | i/total | tags` unchanged.
5. On success: each part already deleted, the **whole staging dir is removed**, row → `done`.
   On failure: row → `error`; **Retry** (`retryUpload`) resumes from `parts_done` (skips parts
   already on Telegram), not from zero.
6. **Bot** indexes each new `channel_post` (Flow C). Download reassembly for these items is a
   plain concat (`copy /b a+b out` / `cat a b > out`), not `7z x`.

---

## B. Upload media directly (from phone, no watcher host path)

1. Post the photo/video/document to the channel **as media** (not an archive), optionally with
   a contract caption.
2. **Bot** `on_channel_post` → `detect_kind()` = `media` → if caption invalid, `derive_media_meta()`
   fabricates a title (caption line → filename → date). Media is never rejected.
3. Bot harvests Telegram's built-in thumbnail (`harvest_thumbnail()` → `get_file` → `encode_thumbnail`
   re-encodes to **WebP** → base64 → `thumbnails`). If a local Telegram Bot API server is configured, the bot reads the local file directly from the shared volume (`telegram-bot-api-data`) instead of downloading it over HTTP.
4. Albums (multiple files sent together) merge into one multi-part item via `media_group_id`.

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
5. `set_title=has_caption` guards album ordering: a captionless album member won't overwrite
   the title set by a captioned member (album update order isn't guaranteed).

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
   - The bot compiles the caption `Title | 1/total | tags` and executes `copyMessage` (or `copyMessages` for albums) to copy the file(s) into the storage channel. For albums, the first message's caption in the channel is edited afterwards to set the caption contract.
4. **Indexing — inline, NOT via Flow C.** Telegram does **not** send a `channel_post` update for
   a message the **bot itself** posted, so `on_channel_post` never fires for Bot-Drop copies. The
   bot therefore indexes each copied post **inline** right after the copy via `index_bot_copy`
   (single file or multi-part album), and the web finisher does the same via `processBotDrop`'s
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
     a. First request → query Turso for `parts.channel_msg_id` + `file_size`, create `meta.json`.
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
   **pinned per playback** so the file size never changes between a load and its seeks. Tunable via
   `VIDEO_*` / `COMPRESSED_*` env (`VIDEO_COMPRESS=0` disables it). Fallback (non-local) mode does
   not compress.
8. **Limitations:**
   * Local Bot API Mode: Supports single-part and multi-part media, cold start buffer delay of ~5-15s to download the file from Telegram to the VPS (at full network speed, e.g. 50MB/s), subsequent seeks and repeat views are instant.
   * Fallback Mode: Strictly throttled to ~3Mbps by Telegram's remote MTProto interface.


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

## G. Tag / category management (web, pure Turso)

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

## H. Watcher lifecycle & control

- **Heartbeat**: Watcher writes `watcher_heartbeat` every 10 s. While this table is still updated by the watcher, the frontend UI no longer displays these status indicators or heartbeats.
- **Process control**: The web UI start/stop buttons for the bot and watcher have been completely removed. The processes are started manually (laptop mode) or managed as always-on compose services (Docker mode). The actions `startWatcher`, `stopWatcher`, `startBot`, and `stopBot` are no longer active in the web page.
- **Startup Back-Indexing**: In Docker/server mode, the watcher service container automatically runs `index_history.py` before starting `watcher.py` on startup. This uses Telethon to back-index any channel messages/updates that occurred while the services were offline, keeping Turso synchronized.

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
- Web env: `TURSO_*`, `NEXT_PUBLIC_BOT_USERNAME` (download link), `BOT_TOKEN` +
  `STORAGE_CHANNEL_ID` (Bot Drop). Bot env adds `OWNER_USER_ID`, `TG_API_ID/HASH`,
  `SEVENZIP_PATH`.
