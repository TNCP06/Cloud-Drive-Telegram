#!/usr/bin/env bash
# =============================================================================
# Telegram Cloud Drive — one-command setup for a FRESH Linux VPS (Docker).
#
# What it does, idempotently:
#   1. Installs Docker + the Compose plugin (via get.docker.com) if missing.
#   2. Asks which feature set you want (MVP or full) and records it in .env.
#   3. Creates .env from .env.example (and lets you edit it) if missing.
#   4. Runs the one-time Telethon logins → bot/worker.session + bot/streamer.session.
#   5. Builds and starts the stack: docker compose up -d --build. The self-hosted
#      postgres service applies bot/schema.sql automatically on first init.
#
# Usage:   bash setup.sh              (run from the repository root, asks the questions)
#          bash setup.sh --mvp        (core only, no questions — good for CI/unattended)
#          bash setup.sh --full       (core + cloud-drive download + Cloudflare Tunnel)
# Re-run any time — it skips steps already done.
# =============================================================================
set -euo pipefail

MODE=""
for arg in "$@"; do
  case "$arg" in
    --mvp)  MODE="mvp" ;;
    --full) MODE="full" ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (use --mvp, --full or no option)" >&2; exit 2 ;;
  esac
done

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
case "${DATABASE_URL:-}" in
  *CHANGEME*) die "DATABASE_URL still has the CHANGEME placeholder — set it to your POSTGRES_PASSWORD and re-run." ;;
esac
ok ".env looks complete."

# --- 2b. Feature set: MVP or full -----------------------------------------
# Optional containers are behind compose profiles; COMPOSE_PROFILES in .env decides
# which ones `docker compose up` (here AND in CI/CD) starts.
set_env() {  # set_env KEY VALUE — replace the line in .env, or append it.
  local k="$1" v="$2"
  if grep -qE "^[[:space:]]*${k}=" .env; then
    # ponytail: sed in place; .env keys are simple identifiers, values have no newlines.
    sed -i -E "s|^[[:space:]]*${k}=.*|${k}=${v}|" .env
  else
    printf '%s=%s\n' "$k" "$v" >> .env
  fi
}

ask() {  # ask "question" default(y|n) → 0 = yes. --mvp/--full answer everything for you.
  case "$MODE" in
    mvp)  return 1 ;;
    full) return 0 ;;
  esac
  if [ ! -t 0 ]; then
    case "$2" in y) return 0 ;; *) return 1 ;; esac
  fi
  local hint="[y/N]" a
  if [ "$2" = "y" ]; then hint="[Y/n]"; fi
  read -r -p "  $1 $hint " a
  case "${a:-$2}" in [Yy]*) return 0 ;; *) return 1 ;; esac
}
dflt() {  # dflt VAR → the y/n default for a re-run: whatever .env says now.
  case "${!1:-}" in 1|true|yes|on) echo y ;; *) echo n ;; esac
}
has_profile() { case ",${COMPOSE_PROFILES:-}," in *",$1,"*) echo y ;; *) echo n ;; esac; }

if [ -n "$MODE" ]; then
  say "Feature set: $MODE (answering every optional feature $([ "$MODE" = full ] && echo yes || echo no))."
elif [ ! -t 0 ]; then
  warn "No terminal — keeping the current .env answers for every optional feature."
fi
echo
echo "The core — upload, index, download, dashboard, video streaming — is always installed."
echo "On top of it there are optional features: cloud-drive remote download, a Cloudflare"
echo "Tunnel, full-copy streaming (seek previews + transcoding) and automatic subtitles."
echo
if [ -z "$MODE" ] && [ -t 0 ]; then
  # An install that already has optional features on defaults to "pick", so a re-run
  # can't silently switch them off.
  scope_default="mvp"
  if [ -n "${COMPOSE_PROFILES:-}" ] || [ "${STREAM_LOCAL_ORIGINAL:-0}" = "1" ] || [ "${SUBTITLE_GEN:-0}" = "1" ]; then
    scope_default="pick"
  fi
  read -r -p "Install the MVP only, or pick optional features one by one? [mvp/pick] (default $scope_default): " scope
  case "${scope:-$scope_default}" in [Pp]*) MODE="" ;; *) MODE="mvp" ;; esac
fi
if [ "$MODE" = "mvp" ]; then
  say "MVP only — skipping the optional features."
  if [ -n "${COMPOSE_PROFILES:-}" ]; then
    warn "This turns OFF the currently enabled optional containers: $COMPOSE_PROFILES"
    warn "(they keep running until you 'docker compose down' them)."
  fi
else
  echo "Answer each one (defaults = your current .env, so pressing Enter changes nothing):"
fi

# 1. Cloud-drive remote download (openlist container + rclone remotes).
profiles=""
if ask "Cloud-drive remote download (/pikpak, /baidu via rclone + OpenList WebDAV)?" "$(has_profile cloud)"; then
  profiles="cloud"
  ok "  enabled — set the drives up in the 'openlist' container (infra/openlist/README.md)."
fi

# 2. Cloudflare Tunnel (public HTTPS streamer for a dashboard hosted off the VPS).
if ask "Cloudflare Tunnel (public HTTPS streamer for an off-VPS dashboard)?" "$(has_profile tunnel)"; then
  profiles="${profiles:+$profiles,}tunnel"
  [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ] || warn "  CLOUDFLARE_TUNNEL_TOKEN is empty — the connector idles until you set it in .env."
fi
set_env COMPOSE_PROFILES "$profiles"

# 3. Full-copy streaming. Off by default: playback proxies sparse chunks straight from
#    Telegram, so a watched video never has to land on the VPS disk in full.
if [ "$MODE" != "mvp" ] && [ -t 0 ]; then
  echo "  (Streaming works either way. By default only the chunks you actually watch are"
  echo "   proxied and cached; a full local copy is what seek previews and transcoding need.)"
fi
if ask "Cache the FULL video on the VPS while streaming?" "$(dflt STREAM_LOCAL_ORIGINAL)"; then
  set_env STREAM_LOCAL_ORIGINAL 1
  # 4. Background transcoding — only meaningful with a full local copy.
  if ask "Background video compression (ffmpeg H.264 re-encode; CPU-heavy)?" "$(dflt VIDEO_COMPRESS)"; then
    set_env VIDEO_COMPRESS 1
  else
    set_env VIDEO_COMPRESS 0
  fi
else
  set_env STREAM_LOCAL_ORIGINAL 0
  set_env VIDEO_COMPRESS 0
  ok "  API-only streaming: sparse chunks, LRU-evicted. No seek previews, no transcoding."
fi

# 5. Subtitles (downloads each video once in the background, then Whisper + translate).
if ask "Automatic subtitles (Groq Whisper STT + translation; downloads each video once)?" "$(dflt SUBTITLE_GEN)"; then
  set_env SUBTITLE_GEN 1
  [ -n "${GROQ_API_KEYS:-}" ] || warn "  GROQ_API_KEYS is empty — subtitles stay idle until you set it in .env."
else
  set_env SUBTITLE_GEN 0
fi

set -a; . ./.env; set +a   # re-load so $COMPOSE_PROFILES applies to the compose calls below
ok "Optional features: ${COMPOSE_PROFILES:-none}, STREAM_LOCAL_ORIGINAL=$STREAM_LOCAL_ORIGINAL, VIDEO_COMPRESS=$VIDEO_COMPRESS, SUBTITLE_GEN=$SUBTITLE_GEN"

# --- 3. Telethon sessions --------------------------------------------------
# A bind-mounted session file must exist as a FILE before compose starts, else
# Docker creates a directory in its place. Build a helper image and log in.
for sess in worker streamer; do
  if [ -d "bot/$sess.session" ]; then
    die "bot/$sess.session is a DIRECTORY (compose created it because it ran before the login). Remove it (sudo rm -rf bot/$sess.session) and re-run."
  fi
done
need_login=0
[ -f bot/worker.session ]   || need_login=1
[ -f bot/streamer.session ] || need_login=1
if [ "$need_login" -eq 1 ]; then
  say "Building helper image for one-time Telethon login…"
  $DOCKER build -t tcd-login -f bot/Dockerfile . >/dev/null
  if [ ! -t 0 ]; then
    # Do NOT continue to `compose up`: the bind mounts would create worker.session /
    # streamer.session as DIRECTORIES and the watcher+streamer would crash-loop.
    warn "No interactive terminal — the Telethon login needs one. Run these, then re-run setup.sh:"
    warn "  $DOCKER run --rm -it --env-file .env -v \"\$PWD/bot:/login\" -w /login tcd-login python login.py worker"
    warn "  $DOCKER run --rm -it --env-file .env -v \"\$PWD/bot:/login\" -w /login tcd-login python login.py streamer"
    die "Stopping before 'compose up' — missing session files must exist as files first."
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
echo "   • Features: ${COMPOSE_PROFILES:-core only (MVP)}"
echo "   • Logs:    $DC logs -f"
echo "   • Stop:    $DC down"
echo "   • Update:  git pull && $DC up -d --build"
echo "   • Add optional features later: bash setup.sh --full"
