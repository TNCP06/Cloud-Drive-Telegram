<p align="center">
  <img src="assets/logo.png" alt="Telegram Cloud Drive Logo" width="120" />
</p>

# Telegram Cloud Drive

> Personal, effectively-unlimited cloud storage with a clean web dashboard — built on a private **Telegram channel** for bytes, **self-hosted PostgreSQL** for metadata, and **Next.js** for the UI.

Files are stored as messages in a private Telegram channel (free, no size cap for your data). A self-hosted PostgreSQL database holds the metadata (titles, tags, sizes, the pointer back to each message). A Next.js dashboard lets you browse, search, tag, upload, download, and **stream video** from any device — without opening Telegram.

---

## ✨ Features

- **Unlimited storage on Telegram** — your files live as channel messages; only tiny metadata lives in PostgreSQL.
- **Automatic indexing** — the bot indexes new posts in real time via a simple caption contract (`Title | part/total | tags`). Files dropped to the bot are indexed inline too.
- **Optimistic web dashboard** — grid/list browse, search, favorites, trash + restore, folders, tag library, **light & dark mode**. Rename / star / move / trash / create-folder update instantly (optimistic UI), reconciling with the server in the background.
- **Daily database backups to Telegram** — every night the bot `pg_dump`s the metadata DB, gzips it, and uploads it to the channel, auto-indexed in the dashboard under **Backup → CDT DB** (dated filename, history kept).
- **Upload from anywhere** — resumable browser upload (single file, **multiple files, or a whole folder**), Bot Drop via PM, or a host-path picker in laptop mode. Folders are recreated as nested folders in the app.
- **PikPak remote-download** — from Telegram, pull a file off a PikPak (rclone) remote onto the server and feed it into the normal upload pipeline. Browse & download entirely by **inline buttons** (`/menu` → ☁️ PikPak), or type `/pikpak <path>`; live download `%` in the bot chat, `/pikpak_ls` to browse, `/pikpak_jobs` to track. Lands in a `pikpak/` folder mirroring the remote path. Oversized files (> 2 GB) are rejected up front — no splitting.
- **YouTube-style video streaming** — HTTP range streaming with a disk cache; with a local Bot API server it bypasses Telegram's download throttle.
- **Background video compression** — first view streams the original instantly while a background job transcodes a smaller, same-resolution H.264 copy; later views serve the compressed one to save bandwidth.
- **WebP thumbnails**, **case-insensitive tags**, soft-delete with a 7-day purge, and shared-password auth.

---

## 🏗️ Architecture (one minute)

Processes that talk **only** through PostgreSQL tables:

| Component | Runs on | Role |
|---|---|---|
| **Web** (`web/`, Next.js 15) | Vercel **or** the server | Dashboard + server actions (reads/writes Postgres; proxies video) |
| **Bot** (`bot/bot.py`) | Always-on host | Index channel posts, serve downloads, Bot Drop, daily purge, daily DB backup, PikPak remote-download |
| **Watcher** (`bot/watcher.py`) | Laptop **or** server | Execute the upload queue (split + push to Telegram via MTProto) |
| **Streamer** (`bot/streamer.py`) | Server | Range-stream video; background compression |
| **PostgreSQL** | Docker (same host) | All metadata (self-hosted; backed up daily to Telegram) |

Deep dives: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/BUSINESS-FLOWS.md`](docs/BUSINESS-FLOWS.md) · [`docs/CODE-MAP.md`](docs/CODE-MAP.md) · [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

**Tech:** Next.js 15 / React 19 / Tailwind · Python 3.11 (python-telegram-bot, Telethon, FastAPI) · PostgreSQL (`pg` / `psycopg`) · Docker.

---

## ✅ Prerequisites (the manual bits — do these first)

These can't be automated; gather the values, then the setup scripts handle the rest.

1. **Telegram bot** — message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **`BOT_TOKEN`**.
2. **Private storage channel** — create a private channel, add your bot as **Admin** (post + edit + delete). Get the **channel id** (`-100…`): forward a channel message to [@userinfobot](https://t.me/userinfobot), or open it in Telegram Web and read the id from the URL.
3. **Your Telegram user id** — DM [@userinfobot](https://t.me/userinfobot) → **`OWNER_USER_ID`** (access control + notifications).
4. **Telegram API credentials** — [my.telegram.org](https://my.telegram.org) → *API development tools* → **`TG_API_ID`** + **`TG_API_HASH`** (needed by Telethon for uploads/streaming).
5. **Database password** — pick a strong **`POSTGRES_PASSWORD`**. The PostgreSQL database itself runs in a Docker container (the `postgres` service); nothing to sign up for. `DATABASE_URL` is assembled from it in `.env`.

Keep these handy for the next step. (The schema is applied automatically on first DB start.)

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
4. **Build and start** everything: `docker compose up -d --build`. The `postgres` service applies `bot/schema.sql` automatically on first init.

When it finishes, open `http://<server-ip>:3000`. Re-run `bash setup.sh` any time — it skips completed steps.

> Useful: `docker compose logs -f` · `docker compose down` · update with `git pull && docker compose up -d --build`.

### Option B — Windows laptop: one script

```bat
git clone <your-repo-url> cloud-drive
cd cloud-drive
setup.bat
```

`setup.bat` installs Python + web dependencies, creates `bot/.env` and `web/.env.local` (opens them in Notepad to fill in), runs the Telethon logins, and points you at a local/remote PostgreSQL (`DATABASE_URL`). Then start:

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
cd ..

# 3a. Docker (server) — the postgres service applies bot/schema.sql on first init:
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
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Self-hosted Postgres credentials (the `postgres` service) |
| `DATABASE_URL` | What every process connects with (`postgresql://…@postgres:5432/…`) |
| `APP_PASSWORD` | Dashboard password (empty = auth disabled) |
| `NEXT_PUBLIC_BOT_USERNAME` | Builds the download deep link (no `@`) |
| `TELEGRAM_API_URL` | Local Bot API server → bypasses the download throttle + enables compression |
| `VIDEO_COMPRESS`, `VIDEO_CRF`, `VIDEO_PRESET`, … | Background compression tuning (see `.env.example`) |
| `RCLONE_CONFIG_DIR`, `PIKPAK_*` | PikPak remote-download (optional): host rclone-config dir bind-mounted into the bot + limits/remote name (see `.env.example`) |

### PikPak remote-download (optional)

To enable `/pikpak`, install rclone **on the server host** and configure a remote:

```bash
curl https://rclone.org/install.sh | sudo bash   # if rclone isn't installed
rclone config                                     # create a remote named "pikpak" (type: pikpak)
```

The bot container ships its own rclone and **bind-mounts your host `rclone.conf`** so the remote +
token are reused. If your config lives outside `/home/ec2-user/.config/rclone` (e.g. Ubuntu:
`/home/ubuntu/.config/rclone`, or root: `/root/.config/rclone`), set `RCLONE_CONFIG_DIR` in `.env`
to that directory, then `docker compose up -d --build`. Tune limits with the `PIKPAK_*` vars in
[`.env.example`](.env.example). Feature is off unless the remote resolves — the bot tells you to run
`rclone config` if it can't.

---

## 📖 Usage

- **Upload:** dashboard → *Upload files* → pick a file, many files, or a folder (resumable). Or DM/forward a file to the bot and finish the title/tags in Telegram or on the web.
- **Caption contract:** files posted to the channel must use `Title | part/total | tag1, tag2` (archives require it; media can omit it). Use `Folder/Sub/Name` titles to auto-create nested folders.
- **Download:** item ⋮ → *Download* → the bot copies it straight to your Telegram chat (full speed, any device).
- **PikPak remote-download:** open `/menu` → **☁️ PikPak** → **Browse & download** to navigate the remote and tap a file — no typing. Or type `/pikpak <path>` to fetch, `/pikpak_ls [folder]` to browse, `/pikpak_jobs` to see recent jobs (progress edits live). Requires rclone installed + a remote configured with `rclone config` **on the server** (see below); the bot image ships rclone and mounts your host `rclone.conf`.
- **Stream:** click a video to play it in the browser.
- **Theme:** toggle light/dark with the sun/moon button in the top bar.

---

## 📄 License

MIT — built for personal use.
