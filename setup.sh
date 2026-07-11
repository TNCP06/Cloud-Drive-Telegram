#!/usr/bin/env bash
# =============================================================================
# Telegram Cloud Drive — one-command setup for a FRESH Linux VPS (Docker).
#
# What it does, idempotently:
#   1. Installs Docker + the Compose plugin (via get.docker.com) if missing.
#   2. Creates .env from .env.example (and lets you edit it) if missing.
#   3. Runs the one-time Telethon logins → bot/worker.session + bot/streamer.session.
#   4. Builds and starts the whole stack: docker compose up -d --build. The self-hosted
#      postgres service applies bot/schema.sql automatically on first init.
#
# Usage:   bash setup.sh        (run from the repository root)
# Re-run any time — it skips steps already done.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

c_green='\033[0;32m'; c_yellow='\033[1;33m'; c_red='\033[0;31m'; c_blue='\033[0;36m'; c_off='\033[0m'
say()  { echo -e "${c_blue}==>${c_off} $*"; }
ok()   { echo -e "${c_green}✓${c_off} $*"; }
warn() { echo -e "${c_yellow}!${c_off} $*"; }
die()  { echo -e "${c_red}✗ $*${c_off}" >&2; exit 1; }

[ -f docker-compose.yml ] || die "Run this from the repository root (docker-compose.yml not found)."

SUDO=""
if [ "$(id -u)" -ne 0 ]; then command -v sudo >/dev/null 2>&1 && SUDO="sudo"; fi

# --- 1. Docker -------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker (get.docker.com)…"
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker 2>/dev/null || true
  if [ -n "${SUDO}" ] && [ -n "${USER:-}" ]; then
    $SUDO usermod -aG docker "$USER" 2>/dev/null || true
    warn "Added $USER to the 'docker' group — log out/in later to use docker without sudo."
  fi
  ok "Docker installed."
else
  ok "Docker already installed ($(docker --version))."
fi

# Resolve a working "docker compose" (plugin) or "docker-compose" (legacy).
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else die "Docker Compose not available. Install the compose plugin and re-run."; fi
# Prefix with sudo if the current user can't talk to the daemon yet.
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="$SUDO docker"; DC="$SUDO $DC"; fi
ok "Using: $DC"

# --- 2. .env ---------------------------------------------------------------
if [ ! -f .env ]; then
  say "Creating .env from .env.example…"
  cp .env.example .env
  warn "Fill in .env (BOT_TOKEN, TG_API_ID/HASH, STORAGE_CHANNEL_ID, OWNER_USER_ID, POSTGRES_PASSWORD, DATABASE_URL, APP_PASSWORD…)."
  if [ -t 0 ]; then
    read -r -p "Open .env in an editor now? [Y/n] " a
    [ "${a:-Y}" = "n" ] || [ "${a:-Y}" = "N" ] || "${EDITOR:-nano}" .env
  fi
fi

# Load .env and verify the essentials are present.
set -a; . ./.env; set +a
missing=""
for v in BOT_TOKEN TG_API_ID TG_API_HASH STORAGE_CHANNEL_ID OWNER_USER_ID POSTGRES_PASSWORD DATABASE_URL; do
  [ -n "${!v:-}" ] || missing="$missing $v"
done
[ -z "$missing" ] || die "Missing required .env values:$missing — edit .env and re-run."
ok ".env looks complete."

# --- 3. Telethon sessions --------------------------------------------------
# A bind-mounted session file must exist as a FILE before compose starts, else
# Docker creates a directory in its place. Build a helper image and log in.
need_login=0
[ -f bot/worker.session ]   || need_login=1
[ -f bot/streamer.session ] || need_login=1
if [ "$need_login" -eq 1 ]; then
  say "Building helper image for one-time Telethon login…"
  $DOCKER build -t tcd-login -f bot/Dockerfile . >/dev/null
  if [ ! -t 0 ]; then
    warn "No interactive terminal — skipping Telethon login. Run later:"
    warn "  $DOCKER run --rm -it --env-file .env -v \"\$PWD/bot:/login\" -w /login tcd-login python login.py worker"
    warn "  $DOCKER run --rm -it --env-file .env -v \"\$PWD/bot:/login\" -w /login tcd-login python login.py streamer"
  else
    for sess in worker streamer; do
      if [ ! -f "bot/$sess.session" ]; then
        say "Telethon login for '$sess' (phone + code; 2FA if enabled)…"
        $DOCKER run --rm -it --env-file .env -v "$PWD/bot:/login" -w /login tcd-login python login.py "$sess"
      fi
    done
    ok "Telethon sessions ready."
  fi
else
  ok "Telethon sessions already present."
fi

# --- 4. Build & start (postgres applies bot/schema.sql on first init) -------
say "Building and starting the stack…"
$DC up -d --build
ok "Stack is up (PostgreSQL schema auto-applied on first init)."

ip="$(curl -fsS https://api.ipify.org 2>/dev/null || echo "<server-ip>")"
echo
ok "Done! Dashboard: http://${ip}:3000"
echo "   • Logs:    $DC logs -f"
echo "   • Stop:    $DC down"
echo "   • Update:  git pull && $DC up -d --build"
