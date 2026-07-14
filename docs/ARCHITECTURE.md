# Architecture — Telegram Cloud Drive

> Single source of truth for **how the system actually works today** (the code, not the
> design phase). Pair with [`BUSINESS-FLOWS.md`](./BUSINESS-FLOWS.md) (operations),
> [`CODE-MAP.md`](./CODE-MAP.md) (file/function map), and [`DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## 1. One-paragraph summary

Files live as messages in a **private Telegram channel** (effectively unlimited, free
storage). A **PostgreSQL** database is the metadata brain — titles, tags, sizes, and
the `channel_msg_id` pointer back to each Telegram message. A **Next.js dashboard**
(Vercel) reads/writes Postgres only; it never touches Telegram directly for storage. Two
**Python processes** bridge to Telegram: a long-running **bot** (`bot.py`, indexes new
channel posts + serves downloads + purges trash) and a laptop-side **watcher**
(`watcher.py`, executes the web's upload queue via MTProto). The glue that makes
auto-indexing work is a single **caption contract**: `Title | part/total | tag1, tag2`.

---

## 2. Components & responsibilities

| Component | Runs on | File(s) | Responsibility |
|---|---|---|---|
| **Storage channel** | Telegram | — | Holds the actual file bytes (one message per part). Bot is admin. |
| **Bot (indexer/server)** | Any always-on host (VPS or laptop) | `bot/bot.py` | Index `channel_post` → Postgres; serve downloads via `copy_message`; daily trash purge; daily DB backup → Telegram; Bot Drop intake; **remote-download** (`bot/pikpak.py`: `/pikpak` + `/baidu` and other registry drives via OpenList/WebDAV, `_ls`/`_jobs` + a ☁️ PikPak inline-button browser + in-process rclone worker → hands off to `upload_jobs`, splitting non-media > 2 GB into parts). |
| **Watcher** | Laptop **or** server (VPS/EC2) | `bot/watcher.py` | Polls `upload_jobs`. `local` jobs read a path (7-Zip split for archives); `upload` jobs read a browser-staged file and **raw streaming split** it (<2 GB/part, no 7-Zip), deleting each part + the staged file as it goes. |
| **Worker (CLI)** | The laptop | `bot/worker.py` | Manual/standalone version of the watcher's upload logic (argparse CLI). Watcher imports its helpers. |
| **History Indexer** | Laptop **or** server (watcher container) | `bot/index_history.py` | Standalone script that logs in via Telethon and back-indexes channel messages to Postgres; runs automatically on watcher container startup. |
| **Streamer** | Server/VPS (Docker) | `bot/streamer.py` (+ `stream_compress.py`, `stream_subtitles.py`, `stream_seekpreview.py`) | Video streaming: if local Bot API server is configured, downloads files on-the-fly to a shared disk cache and streams directly; else falls back to Telethon `iter_download` with sparse 1 MB chunk cache & prefetch. Also runs background **H.264 compression** (deletes the original once done), background **subtitle generation** (Groq Whisper STT → original + EN + ID WebVTT), and background **seek-preview sprite-sheet generation** (ffmpeg thumbnails → Plyr progress-bar hover). |
| **Web dashboard** | Vercel (or localhost) | `web/` (Next.js 15) | Browse/search/edit/delete metadata; trigger download/upload; stream video; Bot Drop form. Streaming/subtitles/seek-preview are **proxied** to the streamer at `STREAMER_URL` (default internal `http://streamer:8080`; the Cloudflare-Tunnel hostname when hosted on Vercel), forwarding the optional `X-Streamer-Secret`. |
| **Cloudflare Tunnel** | Server/VPS (Docker) | `cloudflared` service (compose) | Only when the dashboard runs OFF the VPS (Vercel): exposes the internal `streamer` over public HTTPS with **no open inbound port**, Public-Hostname origin `http://streamer:8080`. The streamer requires the shared `STREAMER_SECRET` so only the dashboard can use the public URL. Dormant unless `CLOUDFLARE_TUNNEL_TOKEN` is set. |
| **PostgreSQL** | Docker (`postgres` service, same host) | schema in `bot/schema.sql` (auto-applied on first init) | All metadata. Self-hosted; data in the `pgdata` volume; backed up daily to Telegram. |

> **Process topology matters.** `bot.py`, `watcher.py`, and `streamer.py` are **separate
> processes** that only communicate through Postgres tables — they never call each other.
> `bot/run-all.cmd` starts bot + watcher + streamer (minimized) on the laptop.
>
> **Live updates stay in-band too.** The dashboard is kept fresh by Postgres `LISTEN/NOTIFY`,
> not by any process calling another: statement-level triggers raise `NOTIFY drive_changed`
> (`notify_drive_change`, on items/folders/tags), `NOTIFY upload_changed` (`notify_upload_change`,
> on `upload_jobs`), and `NOTIFY pikpak_changed` (`notify_pikpak_change`, on `download_jobs` — the
> PikPak remote-download queue) in `schema.sql`; the web's `/api/events` SSE endpoint holds one shared `LISTEN`
> connection (both channels) and pushes a signal to every open browser — `drive` → the grid
> refreshes, `upload` → the /upload page refreshes. So a file the bot indexes (or an upload's
> progress) appears in the dashboard live, still purely through PG — no polling.

---

## 3. Data flow (the big picture)

```
                    ┌───────────────────────── PostgreSQL ─────────────────────────┐
                    │  folders · items · parts · tags · item_tags · thumbnails ·       │
                    │  jobs · upload_jobs · subtitles                                  │
                    └──▲───────────▲──────────────▲──────────────▲────────────▲─────────┘
   read/write metadata │           │ index result │ claim job    │ progress   │ read grid
   (instant, no TG)    │           │              │              │            │
              ┌────────┴──────┐    │       ┌──────┴──────────────┴──┐   ┌─────┴────────┐
              │  Web (Next.js)│    │       │   watcher.py (laptop)   │   │ Web (Next.js)│
              │  server actions│   │       │   Telethon / MTProto    │   │  getDriveData│
              └───┬────────────┘   │       └──────────┬─────────────┘   └──────────────┘
   Bot Drop form  │ copyMessage    │ channel_post     │ send_file (≤2 GB/part)
   (copyMessage)  ▼ (HTTP API)     │ (index)          ▼
              ┌───────────────────────────── Telegram private channel ──────────────────┐
              │            message 101 (part 1) · message 102 (part 2) · …               │
              └──────────────────────────────────────▲──────────────────────────────────┘
                                       /start deep link │ copy_message (download)
                                              ┌─────────┴─────────┐
                                              │   bot.py (server) │
                                              └───────────────────┘
```

Key principle (storage path): **the web never streams file bytes to Telegram.** The watcher
pushes parts to Telegram (MTProto); downloads go Telegram→user's chat (`copy_message`).
Video streaming goes Telegram→streamer cache→Next.js proxy→Service Worker (IndexedDB cache)→browser `<video>` element.

Two upload entry points:
- **`local`** — pick a path on the machine that runs the watcher (laptop mode). The file never
  touches HTTP.
- **`upload`** — the browser sends the file to the server's **resumable** endpoint
  (`/api/upload`, 16 MB chunks, resumes from the server offset on a dropped connection) into a
  staging dir shared with the watcher; the watcher then splits + uploads + cleans up. This is
  what enables upload from any device. See [`DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## 4. The caption contract (the heart of the system)

Every file posted to the channel must carry this caption:

```
Title | part/total | tag1, tag2
```

Regex ([`bot/tg_helpers.py`](../bot/tg_helpers.py) `CAPTION_RE`):

```
^(?P<title>.+?)\s*\|\s*(?P<part>\d+)\s*/\s*(?P<total>\d+)\s*\|\s*(?P<tags>.*)$
```

- **Archives** REQUIRE a valid caption — `title` is the grouping key across parts, `part/total`
  is the assembly order. Invalid caption on an archive → bot DMs the owner (file is **not** lost,
  just not indexed).
- **Media** caption is OPTIONAL — `derive_media_meta()` falls back to caption first line →
  filename → date, so media is never lost.

---

## 5. Two item kinds

| Kind | Example | Storage shape | Thumbnail | Slug strategy |
|---|---|---|---|---|
| `archive` | Ren'Py archive | `.7z` split into ~1.5 GB parts → many messages, one item | none | `slugify(title)` — stable, groups parts |
| `media` | single video/image | one whole file (Telegram makes a thumbnail) | yes (harvested per-part) | per message: `slug-<msgid>` (single) / `m<media_group_id>-<msgid>` (album member) |

`detect_kind()` decides: photo/video/animation or `image/*`/`video/*` document → `media`;
any other document (`.7z`, `.zip`, split parts) → `archive`.

**Albums** (Telegram media groups) are **NOT grouped** — each photo/video becomes its **own
single-part `media` item** (slug `m<media_group_id>-<msgid>`, so siblings stay discoverable).
Tags are kept identical across the split members (`sync_album_tags`); the web filmstrip still
shows them side-by-side via the parent view's nav list. So multi-part `media` items no longer
exist — only `archive` items are multi-part (real split files).

---

## 6. Identity & idempotency invariants

These are load-bearing — break them and indexing/downloads break:

- **`parts.channel_msg_id` is UNIQUE** → it's both the idempotency key for re-indexing and
  the direct target of `copy_message` on download. Re-processing the same post is a no-op.
- **`items.slug` is immutable after creation.** `updateMetadata()` deliberately does NOT
  change the slug on rename — it's the multi-part grouping key (`ON CONFLICT` during
  indexing) and the download deep-link target. `family`/`version` are re-derived from the
  title at read time so a rename still shows in the UI.
- **Folders and nesting:** Folder hierarchy is managed in the `folders` table. The bot's `upsert_item` auto-resolves caption paths (e.g. `Movies/Sci-Fi/Inception`) to nested folders. Deleting a folder recursively soft-deletes (sets `items.deleted_at` and `folders.deleted_at`) all nested subfolders and files.
- **Soft delete:** `items.deleted_at` set → vanishes from UI instantly; the real Telegram
  message survives until the bot's daily purge (>7 days), so restore is lossless. The Trash
  view can also purge a single item on demand via `purgeNow()` (irreversible).
- **Private space partition:** `items.is_private` / `folders.is_private` (default 0) split the drive
  into the public **Main** view and the PIN-gated **Private** view. `getDriveData(space)` filters by it,
  so private rows (and their sizes/tags/analytics) never reach the Main page. Moving in/out toggles the
  flag **without touching `updated_at`** (hiding is not a content change). The PIN lives only in env `PIN`;
  the client only ever sees a `SHA-256` unlock cookie.
- **Subtitles are kept while the video is indexed.** Generated WebVTT tracks live on the persistent
  `/subtitles` volume with one `subtitles(part_id, lang)` row each; they are never auto-evicted (only a
  hard-delete/purge of the item should remove them).
- **Thumbnails are per-part** (`thumbnails.part_id`). An item's cover = thumbnail of the part
  with the smallest `channel_msg_id`. `getDriveData()` only ships **whether** a cover exists
  (`thumb` = `/api/thumb/{itemId}` URL, or `null`) — the bytes are served lazily & HTTP-cached by
  that endpoint, so the grid payload stays tiny regardless of library size. The full gallery loads
  on demand via `getGallery()`.
- **Streamer Deadlock & Priority Invariants:** To avoid Telethon connection choking and deadlocks during concurrent browser seeks, main client playback requests always take absolute priority. Prefetch tasks for the same video are immediately cancelled and awaited (ensuring they release their Telegram locks) before a main playback request proceeds. Additionally, prefetch tasks are only scheduled to start *after* the main playback request successfully completes yielding its chunks, eliminating concurrent lock contention. Finally, the Next.js API proxy disables Keep-Alive (`Connection: close`) to force immediate Uvicorn request completion, ensuring completed chunks are promoted to cache on connection termination.
- **Client-side Video Caching (Service Worker + IndexedDB):** Video requests to `/api/stream/*` are intercepted by the client's Service Worker (`web/public/sw.js`). Video chunks of 2 MB are stored locally in IndexedDB (`video-cache-db`). An LRU (Least Recently Used) policy automatically evicts older file caches once the total size exceeds 4 GB. This saves VPS bandwidth and allows instant seeking/playback of cached parts without hitting the VPS.

---

## 7. Auth

Single shared password (`APP_PASSWORD` env). Cookie `tcd_auth` stores `SHA-256(password)`,
verified in [`web/middleware.ts`](../web/middleware.ts) (edge) and login server action.
**If `APP_PASSWORD` is unset, auth is disabled (open) and the `/login` route redirects to `/`**
(middleware bounces it; `login/page.tsx` also redirects server-side as defence in depth).
Telegram-side access control is separate: the bot only obeys `/start` downloads and Bot Drop
from `OWNER_USER_ID`.

### Demo Mode

Set `DEMO_MODE=true` (env) to run the dashboard without a real database or Telegram account.
Activating demo mode:
- **Replaces all data reads** -- `getDriveData()` returns fake seeder data from `lib/demo.ts`
  instead of querying Postgres. No `DATABASE_URL` is needed.
- **Writes mutate the in-memory seeder data instead of a DB** -- favorite/trash/restore/purge,
  folder create/rename/delete/restore/move, and tag create/rename/recolor/delete all check
  `isDemoMode()` and edit `DEMO_FILES`/`DEMO_FOLDERS`/`DEMO_TAGS` (`lib/demo.ts`) in place, then
  `refresh()` as usual -- so the UI change actually sticks (until the server restarts) instead of
  throwing. Actions with no meaningful demo effect (uploads needing real file bytes; thumbnail
  fetch/upload; moving into the always-empty Private space) still no-op, either via `demoGuard()`
  (`actions/_shared.ts`, throws -- only used by `uploads.ts`, whose callers already catch and show
  the message) or a silent `isDemoMode()` early-return (private/thumbnail actions, whose callers
  don't wrap them in try/catch).
- **Shows a fixed banner** -- `components/DemoBanner.tsx` renders a purple fixed-top bar
  labelled "Demo Mode -- data is fictional, no changes are saved" so visitors know they
  are looking at a showcase.
- **Recommended credentials** -- when demoing publicly, set `APP_PASSWORD=login` and `PIN=123456`
  (auth still gates every route; demo mode does not bypass it). The login page and the Private PIN
  screen display these values on-screen (`login/LoginForm.tsx`, `components/PrivateLock.tsx`, both
  passed `demo={isDemoMode()}` from their server page) so visitors can sign in without asking.

Seeder data (`lib/demo.ts`) covers: multi-part archives, versioned families, media (video/image/
audio/PDF, each with a colored placeholder `thumb`), nested folders, an empty folder, a trashed
folder, starred items, and trashed items -- enough to exercise every UI view (Main grid, Recent,
Favorites, Trash, Folder navigation).

---

## 8. Tech stack & deployment

- **Web:** Next.js 15 (App Router, React 19, server actions), Tailwind, `pg`.
  Deployed on Vercel **or** run on the laptop (`npm run dev`). Note: watcher control and the
  laptop file browser (`fs-actions.ts`) only work when the web server runs **on the laptop**,
  since they spawn processes / read the local disk.
- **Bot/Watcher/Worker:** Python 3.11, `python-telegram-bot` (bot), `Telethon` (watcher/worker,
  MTProto for >50 MB uploads), `psycopg`.
- **DB:** self-hosted **PostgreSQL 16** (the `postgres` compose service). Access goes through a thin
  compat shim that preserves the old `?` placeholder call sites: `web/lib/db.ts` wraps `pg`
  (rewrites `?`→`$n`), `bot/pg_db.py` wraps `psycopg` (rewrites `?`→`%s`). SQL is Postgres dialect
  (`now_text()` for UTC text timestamps, `ON CONFLICT`, `lower()`). Connection via `DATABASE_URL`.
- **Server/VPS:** the whole stack ships as Docker (`docker-compose.yml` + `web/Dockerfile` +
  `bot/Dockerfile`). web, watcher **& bot** share the `staging` volume (bot for remote-download);
  the bot image bundles `rclone` and bind-mounts the host `rclone.conf` (`RCLONE_CONFIG_DIR`) for
  the remote-download feature. A self-hosted **`openlist`** container (image `openlistteam/openlist`
  — community fork, NOT AList) mounts Chinese drives (Baidu, later Quark/115) and re-exposes them
  over WebDAV so the bot's rclone can pull from them (`openlist:` remote); its UI is bound to
  `127.0.0.1:5244` only. See [`infra/openlist/`](../infra/openlist/README.md). The `streamer`
  service gets a `cache` volume for expendable video chunks and a `seekpreviews` volume for persistent seek-preview sprite sheets. An optional `telegram-bot-api` local
  server container runs in `--local` mode to bypass the 3Mbps download throttle, sharing its data
  folder (`telegram-bot-api-data`) with the `streamer`, `bot`, and `web` containers (enabling direct filesystem reading of video chunks and thumbnails instead of HTTP downloads). bot, watcher, & streamer run as
  always-on services. In the watcher service container, `index_history.py` automatically runs on startup before `watcher.py` to back-fill any offline changes. `web/Dockerfile` receives `DATABASE_URL`
  as build args (Next.js pre-renders API routes at build time). Portable to any host — full guide
  in [`DEPLOYMENT.md`](./DEPLOYMENT.md).
  Under Docker the web's watcher/bot start-stop buttons are inert (processes are compose-managed).

See [`CODE-MAP.md`](./CODE-MAP.md) for a file-by-file function reference and
[`BUSINESS-FLOWS.md`](./BUSINESS-FLOWS.md) for step-by-step operational flows.
