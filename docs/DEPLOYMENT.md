# Deployment Guide — VPS / AWS EC2 (Docker)

This guide explains how to run **Telegram Cloud Drive** on an always-on server so it's
reachable from any device, large uploads are handled server-side ("upload one file, the
server splits it into <2 GB parts and pushes them to Telegram"), and videos stream in the
browser. It's written for anyone deploying their own copy — not just the original author.

> Concepts: [`ARCHITECTURE.md`](./ARCHITECTURE.md) · flows: [`BUSINESS-FLOWS.md`](./BUSINESS-FLOWS.md)
> · file map: [`CODE-MAP.md`](./CODE-MAP.md). For the fastest path, just run `setup.sh` (§5).

---

## 1. What runs (Docker Compose services)

| Service | Port | Role |
|---|---|---|
| `web` | 3000 | Next.js dashboard + server actions + upload/stream API |
| `telegram-bot-api` | 8081 (internal) | Local Telegram Bot API server in `--local` mode → bypasses the 3 Mbps download throttle; shares a data volume with bot/web/streamer |
| `bot` | — | Indexes channel posts, serves downloads (`copy_message`), Bot Drop, daily purge |
| `watcher` | — | Runs `index_history.py` (back-fill) then `watcher.py` (executes the upload queue via MTProto) |
| `streamer` | 8080 (internal) | Range-streams video; background H.264 compression to a persistent volume |

**Volumes:** `pgdata` (**persistent** PostgreSQL data), `staging` (browser uploads, web↔watcher),
`cache` (expendable video chunks), `compressed` (**persistent** compressed videos),
`telegram-bot-api-data` (local Bot API files, shared by bot/web/streamer). File bytes live in
Telegram; the only user-critical disk state is `pgdata`, which the bot **backs up daily to Telegram**
(folder Backup → CDT DB) — so the VPS stays effectively disposable.

---

## 2. Prerequisites (gather these once — see the project README §Prerequisites)

- A Telegram **bot token**, a private **storage channel** (bot is admin) + its `-100…` id, your
  **Telegram user id**, and **`TG_API_ID`/`TG_API_HASH`** from [my.telegram.org](https://my.telegram.org).
- A strong **`POSTGRES_PASSWORD`** (and matching `DATABASE_URL`) — the PostgreSQL database is
  self-hosted as the `postgres` compose service, nothing to sign up for.
- A server (EC2 or any VPS) with SSH access. Open inbound **22** (SSH) and **3000** (dashboard);
  add 80/443 only if you put a reverse proxy in front.

---

## 3. The upload path (why a dropped connection won't corrupt or restart)

```
Browser (any device)                 Server (EC2/VPS)                 Telegram
  pick file(s) ──16 MB chunks──▶  /api/upload (append, resumable)
       (connection drops? resume from the last offset — NOT from zero)
  done ───────────────────────▶  /api/upload/complete → upload_jobs
                                   watcher: streaming split <2 GB
                                     part 1 ─ send ─ delete ─┐
                                     part 2 ─ send ─ delete ─┼──▶ messages in channel
                                     …       checkpoint/part ─┘
                                   success → delete the staged file
```

Two protections against flaky links:
1. **Resumable device→server.** 16 MB chunks; on a drop the browser asks `GET /api/upload` for the
   bytes already received and continues (a stray chunk gets a `409` + the real offset). No restart,
   no corruption.
2. **Per-part checkpoint server→Telegram.** `parts_done` records pushed parts; **Retry** resumes
   from the next part, not the whole file.

Folders and multiple files are supported: the browser uploads each file (a folder's files keep
their relative path as the title, which the bot recreates as nested folders — Telegram has no
folders). You no longer need to zip a folder first.

---

## 4. AWS EC2 Free Tier reality (read before picking a size)

- **Disk is the bottleneck.** Free tier includes only **30 GB EBS**. Streaming split keeps disk use
  to roughly *staged file + 1 part*, so a ~20 GB upload peaks around ~21.5 GB — fits 30 GB but with
  little margin. For routinely large files, attach **45–50 GB**. The `cache`/`compressed`/local Bot
  API volumes also consume disk (tune `CACHE_MAX_SIZE_GB`, `COMPRESSED_MAX_SIZE_GB`).
- **RAM:** 1 GB (`t2/t3.micro`) is tight for web+bot+watcher+streamer+local Bot API and the Next.js
  build. Prefer **2 GB (`t3.small`)**, or add a 2 GB swap file (below).
- **Egress ~100 GB/month** free. Uploads (server→Telegram) count as egress; downloads use
  `copy_message` (Telegram-side) = **0 egress**.

---

## 5. Deploy — the easy way (`setup.sh`)

On a fresh Linux VPS:

```bash
git clone <your-repo-url> tcd && cd tcd
bash setup.sh
```

`setup.sh` installs Docker + Compose (via get.docker.com, works on Amazon Linux/Ubuntu/Debian),
creates `.env` from `.env.example` (opens it for you to fill in), runs the one-time Telethon logins
(→ `bot/worker.session`, `bot/streamer.session`), runs `docker compose up -d --build` (the
`postgres` service applies `bot/schema.sql` on first init), and optionally imports old Turso data.
Re-run it any time; it skips completed steps.

Then open `http://<server-ip>:3000` (log in with `APP_PASSWORD`).

> Low-RAM tip — add swap before building if you're on 1 GB:
> ```bash
> sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
> ```

---

## 6. Deploy — the manual way

```bash
# 1) Install Docker (cross-distro)
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER" && newgrp docker

# 2) Get the code + config
git clone <your-repo-url> tcd && cd tcd
cp .env.example .env && nano .env        # fill in every credential

# 3) One-time Telethon logins (creates the two session files the watcher + streamer bind-mount)
#    Build a helper image, then log in interactively (phone + code, 2FA if enabled):
docker build -t tcd-login -f bot/Dockerfile .
docker run --rm -it --env-file .env -v "$PWD/bot:/login" -w /login tcd-login python login.py worker
docker run --rm -it --env-file .env -v "$PWD/bot:/login" -w /login tcd-login python login.py streamer

# 4) Build + start (the postgres service applies bot/schema.sql on first init)
docker compose up -d --build
docker compose logs -f                   # confirm postgres is healthy, bot/watcher/streamer connect, web is ready

# 5) (Optional) one-time import of existing Turso data into Postgres
#    Set TURSO_DATABASE_URL/TURSO_AUTH_TOKEN in .env first; runs on the compose network.
docker compose run --rm bot python migrate_turso_to_pg.py
```

Notes:
- The local Bot API server (`telegram-bot-api`) and `TELEGRAM_API_URL=http://telegram-bot-api:8081`
  are already wired in `docker-compose.yml` — no manual setup.
- The bot/watcher start/stop buttons were removed from the UI, and the watcher heartbeat
  (`watcher_heartbeat`) was removed entirely; processes are managed by Compose (`restart: unless-stopped`).
- For a domain + HTTPS, put **Caddy/Nginx** in front of the `web` service (port 3000). Large uploads
  must go through this server, never through a serverless host (small body limit).

---

## 7. Moving to another VPS later

Everything is Docker; file bytes stay in Telegram. The only state to carry is the Postgres data —
either restore the latest daily backup from the drive (Backup → CDT DB) on the new host, or copy the
`pgdata` volume across. Steps:

```bash
# from the old server — capture a fresh dump (or just download the latest Backup/CDT DB file):
docker compose exec -T postgres pg_dump --clean --if-exists --no-owner --no-privileges \
  -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > cdt-db.sql.gz
scp .env bot/worker.session bot/streamer.session cdt-db.sql.gz user@new-vps:~/tcd/

# on the new VPS:
git clone <your-repo-url> tcd && cd tcd
# place .env + the two .session files, then bring up the DB + stack:
docker compose up -d --build
# restore the data:
gunzip -c cdt-db.sql.gz | docker compose exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB"
```

No file migration (Telegram stays). Repoint your domain to the
new IP. The `compressed` videos are rebuilt on demand, so they don't need migrating.

---

## 8. Pros & caveats

**Pros:** access from any device; "upload one file, server splits + sends + cleans up";
resilient to drops (resumable chunks + per-part checkpoint); disk-light streaming split; portable
(`docker compose up`); light bot (downloads via `copy_message`, no byte streaming); free download
egress; in-browser video streaming with background compression to cut repeat-view bandwidth.

**Caveats:**
- 30 GB free-tier disk is tight for ~20 GB files (peak ~21.5 GB) — prefer 45–50 GB EBS.
- 100 GB/month egress caps total upload volume (downloads don't count).
- 1 GB RAM is tight → use `t3.small` or add swap.
- Free Tier is time-limited → you'll migrate eventually (made easy in §7).
- Download reassembly for **new** uploads is a plain concat, not `7z x` (older 7-Zip archives still
  use `7z x`).
- Uploads still traverse 2 hops (device→server→Telegram); the first hop depends on your link
  (resumable mitigates it, doesn't remove it).
- `worker.session` / `streamer.session` are full Telegram account credentials — never commit them
  (already in `.gitignore` / `.dockerignore`).

---

## 9. Environment variables (summary)

See [`.env.example`](../.env.example). Key ones for server mode:

| Var | Used by | Note |
|---|---|---|
| `DATABASE_URL` | all | Postgres connection (metadata brain) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | postgres, all | self-hosted DB credentials (must match `DATABASE_URL`) |
| `BOT_TOKEN`, `STORAGE_CHANNEL_ID`, `OWNER_USER_ID` | bot, web | index / download / purge |
| `TG_API_ID`, `TG_API_HASH` | watcher, streamer | Telethon (MTProto) |
| `NEXT_PUBLIC_BOT_USERNAME` | web (build) | download deep link — inlined at build time |
| `APP_PASSWORD` | web | dashboard login; empty = auth disabled |
| `TELEGRAM_API_URL` | bot, web, streamer | local Bot API endpoint (compose sets `http://telegram-bot-api:8081`) |
| `UPLOAD_STAGING_DIR` / `WORKER_OUT_DIR` | web, watcher | compose sets `/staging` + `/staging/_parts` |
| `VIDEO_COMPRESS`, `VIDEO_CRF`, `VIDEO_PRESET`, `COMPRESSED_MAX_SIZE_GB` | streamer | background compression tuning |

---

## 10. Automatic deploys (CI/CD via GitHub Actions)

- **CI** ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) runs **on Pull Requests** to
  `main`: web lint + typecheck + build, and a Python syntax check.
- **CD** ([.github/workflows/cd.yml](../.github/workflows/cd.yml)) runs **on push/merge** to `main`:
  it SSHes into the VPS, runs `git pull origin main`, `docker compose up -d --build`, and
  `docker image prune -f`.

> Direct pushes to `main` skip CI and go straight to deploy — so build/lint locally first, and keep
> the VPS working tree clean (the deploy does `git pull`; uncommitted changes there block it).

### A. GitHub repository secrets
**Settings → Secrets and variables → Actions → Repository secrets:**
1. `VPS_SSH_HOST` — public IP or DNS of the VPS.
2. `VPS_SSH_USERNAME` — SSH user (`ubuntu` for Ubuntu, `ec2-user` for Amazon Linux).
3. `VPS_SSH_KEY` — the full private key (`.pem` contents, including the `-----BEGIN/END-----` lines).
4. `VPS_DEPLOY_PATH` — repo path on the VPS (e.g. `/home/ec2-user/tcd`).
5. `VPS_SSH_PORT` *(optional)* — defaults to `22`.

### B. Deploy key on the VPS (for `git pull` on a private repo)
```bash
ssh-keygen -t ed25519 -C "vps-deploy-key"   # press Enter through the prompts (no passphrase)
cat ~/.ssh/id_ed25519.pub                    # add this at GitHub → repo → Settings → Deploy keys
ssh -T git@github.com                        # accept the host fingerprint once
```
Read-only access is enough; do **not** tick "Allow write access".

### C. Flow
- PR to `main` → CI (build/lint/syntax). No deploy.
- Push/merge to `main` → CD: SSH → `git pull` → `docker compose up -d --build` → prune old images.
