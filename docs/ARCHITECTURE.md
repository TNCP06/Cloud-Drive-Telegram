# Architecture — Telegram Cloud Drive

> Single source of truth for **how the system actually works today** (the code, not the
> design phase). For the original Indonesian design rationale see
> [`../arsitektur-telegram-storage.md`](../arsitektur-telegram-storage.md); for the early
> UI mockup see `web-cloud-drive-design/` (mockup only — not authoritative).

---

## 1. One-paragraph summary

Files live as messages in a **private Telegram channel** (effectively unlimited, free
storage). A **Turso (libSQL)** database is the metadata brain — titles, tags, sizes, and
the `channel_msg_id` pointer back to each Telegram message. A **Next.js dashboard**
(Vercel) reads/writes Turso only; it never touches Telegram directly for storage. Two
**Python processes** bridge to Telegram: a long-running **bot** (`bot.py`, indexes new
channel posts + serves downloads + purges trash) and a laptop-side **watcher**
(`watcher.py`, executes the web's upload queue via MTProto). The glue that makes
auto-indexing work is a single **caption contract**: `Title | part/total | tag1, tag2`.

---

## 2. Components & responsibilities

| Component | Runs on | File(s) | Responsibility |
|---|---|---|---|
| **Storage channel** | Telegram | — | Holds the actual file bytes (one message per part). Bot is admin. |
| **Bot (indexer/server)** | Any always-on host (VPS or laptop) | `bot/bot.py` | Index `channel_post` → Turso; serve downloads via `copy_message`; daily trash purge; Bot Drop intake. |
| **Watcher** | Laptop **or** server (VPS/EC2) | `bot/watcher.py` | Polls `upload_jobs`. `local` jobs read a path (7-Zip split for games); `upload` jobs read a browser-staged file and **raw streaming split** it (<2 GB/part, no 7-Zip), deleting each part + the staged file as it goes; heartbeat. |
| **Worker (CLI)** | The laptop | `bot/worker.py` | Manual/standalone version of the watcher's upload logic (argparse CLI). Watcher imports its helpers. |
| **Web dashboard** | Vercel (or localhost) | `web/` (Next.js 15) | Browse/search/edit/delete metadata; trigger download/upload; control watcher; Bot Drop form. |
| **Turso** | Cloud (free tier) | schema in `bot/schema.sql` | All metadata. Always-on, SQLite-compatible. |

> **Process topology matters.** `bot.py` and `watcher.py` are **separate processes** that
> only communicate through Turso tables — they never call each other. `bot/run-all.cmd`
> starts both (minimized) on the laptop. The web app can start/stop both the *watcher* and
> the *bot* (via `startBot`/`stopBot` server actions) when running on the same machine.

---

## 3. Data flow (the big picture)

```
                    ┌───────────────────────── Turso (libSQL) ─────────────────────────┐
                    │  items · parts · tags · item_tags · thumbnails · jobs ·           │
                    │  upload_jobs · watcher_heartbeat · bot_heartbeat                  │
                    └──▲───────────▲──────────────▲──────────────▲────────────▲─────────┘
   read/write metadata │           │ index result │ claim job    │ heartbeat  │ read grid
   (instant, no TG)    │           │              │ + progress   │            │
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

Regex ([`bot/bot.py`](../bot/bot.py) `CAPTION_RE`):

```
^(?P<title>.+?)\s*\|\s*(?P<part>\d+)\s*/\s*(?P<total>\d+)\s*\|\s*(?P<tags>.*)$
```

- **Games** REQUIRE a valid caption — `title` is the grouping key across parts, `part/total`
  is the assembly order. Invalid caption on a game → bot DMs the owner (file is **not** lost,
  just not indexed).
- **Media** caption is OPTIONAL — `derive_media_meta()` falls back to caption first line →
  filename → date, so media is never lost.

---

## 5. Two item kinds

| Kind | Example | Storage shape | Thumbnail | Slug strategy |
|---|---|---|---|---|
| `game` | Ren'Py archive | `.7z` split into ~1.5 GB parts → many messages, one item | none | `slugify(title)` — stable, groups parts |
| `media` | single video/image | one whole file (Telegram makes a thumbnail) | yes (harvested per-part) | single: `slug-<msgid>`; album: `album-<media_group_id>` |

`detect_kind()` decides: photo/video/animation or `image/*`/`video/*` document → `media`;
any other document (`.7z`, `.zip`, split parts) → `game`.

**Albums** (Telegram media groups) collapse into ONE multi-part `media` item keyed by
`media_group_id`; each photo/video becomes a part with its own thumbnail (the web gallery).

---

## 6. Identity & idempotency invariants

These are load-bearing — break them and indexing/downloads break:

- **`parts.channel_msg_id` is UNIQUE** → it's both the idempotency key for re-indexing and
  the direct target of `copy_message` on download. Re-processing the same post is a no-op.
- **`items.slug` is immutable after creation.** `updateMetadata()` deliberately does NOT
  change the slug on rename — it's the multi-part grouping key (`ON CONFLICT` during
  indexing) and the download deep-link target. `family`/`version` are re-derived from the
  title at read time so a rename still shows in the UI.
- **Soft delete:** `items.deleted_at` set → vanishes from UI instantly; the real Telegram
  message survives until the bot's daily purge (>7 days), so restore is lossless. The Trash
  view can also purge a single item on demand via `purgeNow()` (irreversible).
- **Thumbnails are per-part** (`thumbnails.part_id`). An item's cover = thumbnail of the part
  with the smallest `channel_msg_id` (computed in `getDriveData()`); the full gallery loads
  on demand via `getGallery()`.

---

## 7. Auth

Single shared password (`APP_PASSWORD` env). Cookie `tcd_auth` stores `SHA-256(password)`,
verified in [`web/middleware.ts`](../web/middleware.ts) (edge) and login server action.
**If `APP_PASSWORD` is unset, auth is disabled (open).** Telegram-side access control is
separate: the bot only obeys `/start` downloads and Bot Drop from `OWNER_USER_ID`.

---

## 8. Tech stack & deployment

- **Web:** Next.js 15 (App Router, React 19, server actions), Tailwind, `@libsql/client`.
  Deployed on Vercel **or** run on the laptop (`npm run dev`). Note: watcher control and the
  laptop file browser (`fs-actions.ts`) only work when the web server runs **on the laptop**,
  since they spawn processes / read the local disk.
- **Bot/Watcher/Worker:** Python 3.11, `python-telegram-bot` (bot), `Telethon` (watcher/worker,
  MTProto for >50 MB uploads), `libsql-client`.
- **DB:** Turso (libSQL). Bot connects over **HTTPS** (Hrana-over-HTTP) — `libsql://` URLs are
  rewritten to `https://` because the WebSocket transport is rejected (HTTP 400).
- **Server/VPS:** the whole stack ships as Docker (`docker-compose.yml` + `web/Dockerfile` +
  `bot/Dockerfile`). web & watcher share a `staging` volume for browser uploads; bot & watcher
  run as always-on services. `web/Dockerfile` receives `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
  as build args (Next.js pre-renders API routes at build time). Portable to any host — full guide
  in [`DEPLOYMENT.md`](./DEPLOYMENT.md).
  Under Docker the web's watcher/bot start-stop buttons are inert (processes are compose-managed).

See [`CODE-MAP.md`](./CODE-MAP.md) for a file-by-file function reference and
[`BUSINESS-FLOWS.md`](./BUSINESS-FLOWS.md) for step-by-step operational flows.
