# Telegram Cloud Drive ☁️

> Personal, effectively-unlimited cloud storage with a clean web dashboard — built on a private **Telegram channel** for bytes, **Turso (libSQL)** for metadata, and **Next.js** for the UI.

Files are stored as messages in a private Telegram channel (free, no size cap for your data). A Turso database holds the metadata (titles, tags, sizes, the pointer back to each message). A Next.js dashboard lets you browse, search, tag, upload, download, and **stream video** from any device — without opening Telegram.

---

## ✨ Features

- **Unlimited storage on Telegram** — your files live as channel messages; only tiny metadata lives in Turso.
- **Automatic indexing** — the bot indexes new posts in real time via a simple caption contract (`Title | part/total | tags`). Files dropped to the bot are indexed inline too.
- **Web dashboard** — grid/list browse, search, favorites, trash + restore, folders, tag library, **light & dark mode**.
- **Upload from anywhere** — resumable browser upload (single file, **multiple files, or a whole folder**), Bot Drop via PM, or a host-path picker in laptop mode. Folders are recreated as nested folders in the app.
- **YouTube-style video streaming** — HTTP range streaming with a disk cache; with a local Bot API server it bypasses Telegram's download throttle.
- **Background video compression** — first view streams the original instantly while a background job transcodes a smaller, same-resolution H.264 copy; later views serve the compressed one to save bandwidth.
- **WebP thumbnails**, **case-insensitive tags**, soft-delete with a 7-day purge, and shared-password auth.

---

## 🏗️ Architecture (one minute)

Three processes that talk **only** through Turso tables:

| Component | Runs on | Role |
|---|---|---|
| **Web** (`web/`, Next.js 15) | Vercel **or** the server | Dashboard + server actions (reads/writes Turso; proxies video) |
| **Bot** (`bot/bot.py`) | Always-on host | Index channel posts, serve downloads, Bot Drop, daily purge |
| **Watcher** (`bot/watcher.py`) | Laptop **or** server | Execute the upload queue (split + push to Telegram via MTProto) |
| **Streamer** (`bot/streamer.py`) | Server | Range-stream video; background compression |
| **Turso** (libSQL) | Managed cloud | All metadata |

Deep dives: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/BUSINESS-FLOWS.md`](docs/BUSINESS-FLOWS.md) · [`docs/CODE-MAP.md`](docs/CODE-MAP.md) · [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

**Tech:** Next.js 15 / React 19 / Tailwind · Python 3.11 (python-telegram-bot, Telethon, FastAPI) · Turso · Docker.

---

## ✅ Prerequisites (the manual bits — do these first)

These can't be automated; gather the values, then the setup scripts handle the rest.

1. **Telegram bot** — message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **`BOT_TOKEN`**.
2. **Private storage channel** — create a private channel, add your bot as **Admin** (post + edit + delete). Get the **channel id** (`-100…`): forward a channel message to [@userinfobot](https://t.me/userinfobot), or open it in Telegram Web and read the id from the URL.
3. **Your Telegram user id** — DM [@userinfobot](https://t.me/userinfobot) → **`OWNER_USER_ID`** (access control + notifications).
4. **Telegram API credentials** — [my.telegram.org](https://my.telegram.org) → *API development tools* → **`TG_API_ID`** + **`TG_API_HASH`** (needed by Telethon for uploads/streaming).
5. **Turso database** — sign up at [turso.tech](https://turso.tech), create a DB, then grab:
   - `TURSO_DATABASE_URL` (`libsql://…`)
   - `TURSO_AUTH_TOKEN` (`turso db tokens create <db>`)

Keep these handy for the next step. (The schema is applied automatically by the setup scripts.)

---

## 🚀 Install

### Option A — Server / VPS (recommended): one command

On a **fresh Linux VPS** (Amazon Linux, Ubuntu, Debian…):

```bash
git clone <your-repo-url> cloud-drive && cd cloud-drive
bash setup.sh
```

`setup.sh` will:
1. Install **Docker + Compose** if missing.
2. Create `.env` from `.env.example` and open it for you to paste the values from *Prerequisites*.
3. Run the one-time **Telethon logins** (phone + code) → `bot/worker.session`, `bot/streamer.session`.
4. Apply the **Turso schema** (idempotent).
5. **Build and start** everything: `docker compose up -d --build`.

When it finishes, open `http://<server-ip>:3000`. Re-run `bash setup.sh` any time — it skips completed steps.

> Useful: `docker compose logs -f` · `docker compose down` · update with `git pull && docker compose up -d --build`.

### Option B — Windows laptop: one script

```bat
git clone <your-repo-url> cloud-drive
cd cloud-drive
setup.bat
```

`setup.bat` installs Python + web dependencies, creates `bot/.env` and `web/.env.local` (opens them in Notepad to fill in), runs the Telethon logins, and applies the schema. Then start:

```bat
bot\run-all.cmd            REM bot + watcher + streamer (minimized)
cd web && npm run dev      REM dashboard at http://localhost:3000
```

### Option C — Manual (any OS)

<details>
<summary>Expand for manual steps</summary>

```bash
# 1. Env
cp .env.example .env                      # fill in all values
cp web/.env.local.example web/.env.local  # (laptop dev only)

# 2. Bot/watcher/streamer deps + Telethon login
cd bot
pip install -r requirements.txt
python login.py worker      # phone + code
python login.py streamer
python run-migration.py schema.sql            # one-time
python run-migration.py migration-folders.sql # one-time
cd ..

# 3a. Docker (server):
docker compose up -d --build

# 3b. OR run processes directly:
#   bot:      python bot/bot.py
#   watcher:  python bot/watcher.py
#   streamer: python bot/streamer.py
#   web:      cd web && npm install && npm run dev
```
</details>

---

## ⚙️ Configuration

All settings live in **`.env`** (see [`.env.example`](.env.example) for the annotated list). Highlights:

| Variable | Purpose |
|---|---|
| `BOT_TOKEN`, `STORAGE_CHANNEL_ID`, `OWNER_USER_ID` | Telegram bot + channel + owner |
| `TG_API_ID`, `TG_API_HASH` | Telethon (watcher + streamer) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Metadata DB |
| `APP_PASSWORD` | Dashboard password (empty = auth disabled) |
| `NEXT_PUBLIC_BOT_USERNAME` | Builds the download deep link (no `@`) |
| `TELEGRAM_API_URL` | Local Bot API server → bypasses the download throttle + enables compression |
| `VIDEO_COMPRESS`, `VIDEO_CRF`, `VIDEO_PRESET`, … | Background compression tuning (see `.env.example`) |

---

## 📖 Usage

- **Upload:** dashboard → *Upload files* → pick a file, many files, or a folder (resumable). Or DM/forward a file to the bot and finish the title/tags in Telegram or on the web.
- **Caption contract:** files posted to the channel must use `Title | part/total | tag1, tag2` (archives require it; media can omit it). Use `Folder/Sub/Name` titles to auto-create nested folders.
- **Download:** item ⋮ → *Download* → the bot copies it straight to your Telegram chat (full speed, any device).
- **Stream:** click a video to play it in the browser.
- **Theme:** toggle light/dark with the sun/moon button in the top bar.

---

## 📄 License

MIT — built for personal use.
