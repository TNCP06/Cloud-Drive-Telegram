# Business / Operational Flows

Step-by-step flows for every operation, with the exact code path. "Needs laptop?" tells you
whether the operation requires the laptop powered on. See [`ARCHITECTURE.md`](./ARCHITECTURE.md)
for components and [`CODE-MAP.md`](./CODE-MAP.md) for function-level detail.

---

## Quick reference: needs laptop?

| Operation | Needs laptop? | Why |
|---|---|---|
| Upload large game (server mode) | No | Browser → resumable upload → server splits + MTProto. Needs the watcher running on a server (Flow A2) |
| Upload large game (laptop mode) | **Yes** | Files are on the laptop; watcher reads the path locally (Flow A) |
| Upload small media from phone | No | Post directly to channel; bot indexes |
| Bot Drop (web upload via PM) | No | Bot holds the file; web triggers `copyMessage` |
| Browse / search / edit title / edit tags | No | Pure Turso writes |
| Download | No | Bot serves it with `copy_message` |
| Delete / restore | No | Soft delete in Turso; bot purges later |

---

## A. Upload a game (queue-driven, the normal path)

The web enqueues; the laptop watcher executes. Web and watcher communicate **only** through
the `upload_jobs` table.

1. **Web** (`/upload`): user picks a folder/file via the laptop file browser
   (`fs-actions.listDir`), sets title/tags/part size → `enqueueUpload()` inserts a row into
   `upload_jobs` with `status='queued'`.
2. User clicks Start → `startUpload()` (or `startAllUploads()`) flips the row to
   `status='pending'`.
3. **Watcher** (`watcher.py`, polling every 5 s) `claim_next()` grabs the oldest `pending`
   row → `status='running'`.
4. `split_game()` runs 7-Zip (`-v<size>m -mx=0`, store mode) → part files; progress is written
   back to `upload_jobs.progress` by a background `updater()` task.
5. Each part is sent with `client.send_file(..., force_document=True)` and caption
   `Title | i/total | tags`.
6. On success: split files are deleted (original is untouched), row → `status='done'`.
   On failure: row → `status='error'` with the message.
7. **Bot** independently sees each new `channel_post` → indexes it into `items`/`parts`
   (Flow C). The watcher and bot never talk directly.

> Manual alternative (no web/queue): run `worker.py game <path> --title ... --tags ...`
> directly on the laptop. Same upload logic, argparse CLI.

---

## A2. Upload from any device (server mode — "terima beres")

The user uploads one file from a browser; the **server** stages it, splits it, and pushes it.
No manual 7-Zip. Requires the watcher running on the server (Docker — see DEPLOYMENT.md).

1. **Web** (`/upload`, Source = "Upload from this device"): set title/tags/part size, pick a
   file → `FileUploader` sends it to `POST /api/upload` in **16 MB chunks**. A stable per-file
   token lets it **resume**: on a dropped connection it asks `GET /api/upload` for the bytes the
   server already has and continues from that offset (server returns `409` + real offset if a
   chunk arrives out of order). The file lands in the shared staging dir (`staging.ts`).
2. When the whole file is staged, `POST /api/upload/complete` verifies the size and inserts an
   `upload_jobs` row: `origin='upload'`, `cleanup_source=1`, `status='queued'`.
3. User clicks Start → `status='pending'` (same as Flow A).
4. **Watcher** `claim_next()` → `process()`: `resolve_staged_file()` finds the file. game over
   part size → **raw streaming split** (`write_window` copies one <2 GB window → `send_file`
   force_document → delete the part → `set_parts_done(i)`), capping disk at ~1 part; media/small
   → whole file. Caption `Title | i/total | tags` unchanged.
5. On success: each part already deleted, the **whole staging dir is removed**, row → `done`.
   On failure: row → `error`; **Retry** (`retryUpload`) resumes from `parts_done` (skips parts
   already on Telegram), not from zero.
6. **Bot** indexes each new `channel_post` (Flow C). Download reassembly for these items is a
   plain concat (`copy /b a+b out` / `cat a b > out`), not `7z x`.

---

## B. Upload media directly (from phone, no laptop)

1. Post the photo/video/document to the channel **as media** (not an archive), optionally with
   a contract caption.
2. **Bot** `on_channel_post` → `detect_kind()` = `media` → if caption invalid, `derive_media_meta()`
   fabricates a title (caption line → filename → date). Media is never rejected.
3. Bot harvests Telegram's built-in thumbnail (`harvest_thumbnail()` → `get_file` → base64 →
   `thumbnails`).
4. Albums (multiple files sent together) merge into one multi-part item via `media_group_id`.

---

## C. Index & validate (bot, real-time — the heart)

Triggered by any new `channel_post` in `STORAGE_CHANNEL_ID` ([`bot/bot.py`](../bot/bot.py)
`on_channel_post`):

1. `detect_kind()` — not a file → ignore (plain text post).
2. `parse_caption()` against the contract.
   - Match → index.
   - No match **and** `media` → `derive_media_meta()`, index anyway.
   - No match **and** `game` → `warn_owner()` DM, **do not index**.
3. Compute `slug` + `part_number` (see kind table in ARCHITECTURE §5).
4. `upsert_item` → `upsert_part` (keyed on `channel_msg_id`) → `recompute_totals` →
   `sync_tags` → (media) `harvest_thumbnail`. All idempotent.
5. `set_title=has_caption` guards album ordering: a captionless album member won't overwrite
   the title set by a captioned member (album update order isn't guaranteed).

---

## D. Bot Drop & Telegram Interactive Upload — upload via the bot's PM

Bypasses Vercel's request-size limit: the **bot** holds the bytes, the **web** only sends a
small API call. Alternatively, the user can complete the upload entirely within Telegram.

1. **Intake**: User DMs a file (Photo, Video, or Document) to the bot.
   - If not authorized, access is denied (see authorization below).
   - If authorized, the bot initiates the interactive questionnaire (waiting for Title, then Tags).
   - The bot also sends a web link: `/<web>/upload-bot?msg_id=<id>&chat_id=<id>` as an alternative.
2. **Finishing via Web**:
   - User opens the web link, completes Title & Tags, and clicks Save.
   - `processBotDrop()` (server action) calls Telegram `copyMessage` to copy the file into the storage channel with the contract caption `Title | 1/1 | tags`.
3. **Finishing via Telegram**:
   - The user replies to the bot's message with a custom Title, or clicks/types `/skip` to use the auto-caption Title (derived from filename or media date).
   - The bot then asks for Tags. The user replies with comma-separated tags, or clicks/types `/skip` to skip/use auto-tags.
   - The bot compiles the caption `Title | 1/1 | tags` and executes `copyMessage` to copy the file into the storage channel.
4. **Indexing**: The new channel post is indexed by Flow C like any other upload.

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
7. **Limitations:**
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
- Colour: `tags.color` stores a palette key (`sage`, `ochre`, …); empty string → derived
  deterministically from the name via `tagColorKey()`. Tags created by the bot have no colour
  and fall back to derivation.

---

## H. Watcher lifecycle & control

- **Heartbeat**: watcher writes `watcher_heartbeat` every 10 s. Web treats it as online if
  `last_seen` is < 30 s old (`watcherOnline()`). Same for the bot (`bot_heartbeat`).
- **Start** (`startWatcher`): if not already online, `spawn('python -u watcher.py', {detached,
  shell})`, write `watcher.pid`, and write an instant heartbeat so the UI shows "active" right
  away.
- **Stop** (`stopWatcher`): read `watcher.pid` → `killTree(pid)` — `taskkill /PID <pid> /T /F`
  on Windows, or `kill` of the detached process group on Linux/macOS — then stale the heartbeat.
- The start/stop buttons only work when the **web server shares a machine with the scripts**
  (laptop mode). **Under Docker** the bot & watcher are always-on compose services, so the
  buttons are inert; the heartbeat dots still report real status.

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
