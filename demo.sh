#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export DEMO_MODE=1
export PIN="${PIN:-123456}"
cd "$SCRIPT_DIR/web"
exec npm run dev
