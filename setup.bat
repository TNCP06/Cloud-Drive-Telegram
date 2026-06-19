@echo off
REM ============================================================================
REM Telegram Cloud Drive - one-shot setup for LAPTOP mode on Windows.
REM
REM Installs Python + Node deps, creates env files, runs the one-time Telethon
REM logins, and applies the Turso schema. After it finishes, start everything with:
REM     bot\run-all.cmd          (bot + watcher + streamer)
REM     cd web ^&^& npm run dev   (dashboard at http://localhost:3000)
REM
REM Usage:  double-click setup.bat, or run it from the repo root in a terminal.
REM Re-run any time - it skips what is already done.
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo === Telegram Cloud Drive - Windows laptop setup ===
echo.

REM --- Prerequisites --------------------------------------------------------
where python >nul 2>&1
if errorlevel 1 (
  echo [X] Python not found. Install Python 3.11+ from https://python.org and re-run.
  pause & exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js not found. Install Node 18+ from https://nodejs.org and re-run.
  pause & exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  echo [X] npm not found (comes with Node.js). Re-install Node and re-run.
  pause & exit /b 1
)
echo [ok] Python and Node.js found.

REM --- 1. Python dependencies (bot) ----------------------------------------
echo.
echo --^> Installing Python dependencies...
python -m pip install --upgrade pip >nul
python -m pip install -r bot\requirements.txt
if errorlevel 1 ( echo [X] pip install failed. & pause & exit /b 1 )
echo [ok] Python dependencies installed.

REM --- 2. Env files ---------------------------------------------------------
if not exist bot\.env (
  copy /y bot\.env.example bot\.env >nul
  echo [!] Created bot\.env - FILL IN the values (BOT_TOKEN, TG_API_ID/HASH, STORAGE_CHANNEL_ID, OWNER_USER_ID, TURSO_*).
  set NEED_EDIT=1
)
if not exist web\.env.local (
  copy /y web\.env.local.example web\.env.local >nul
  echo [!] Created web\.env.local - FILL IN the values (TURSO_*, NEXT_PUBLIC_BOT_USERNAME, BOT_TOKEN, STORAGE_CHANNEL_ID).
  set NEED_EDIT=1
)
if defined NEED_EDIT (
  echo.
  echo Opening env files in Notepad - fill them in, save, then continue.
  start /wait notepad bot\.env
  start /wait notepad web\.env.local
)
echo [ok] Env files present.

REM --- 3. Telethon logins (one-time) ---------------------------------------
echo.
if not exist bot\worker.session (
  echo --^> Telethon login for the WATCHER (phone + code; 2FA if enabled)...
  pushd bot & python login.py worker & popd
) else (
  echo [ok] bot\worker.session already exists.
)
if not exist bot\streamer.session (
  echo --^> Telethon login for the STREAMER...
  pushd bot & python login.py streamer & popd
) else (
  echo [ok] bot\streamer.session already exists.
)

REM --- 4. Turso schema (idempotent) ----------------------------------------
echo.
echo --^> Applying Turso schema (safe to re-run)...
pushd bot
python run-migration.py schema.sql
python run-migration.py migration-folders.sql
popd
echo [ok] Schema applied.

REM --- 5. Web dependencies --------------------------------------------------
echo.
echo --^> Installing web dependencies (npm install)...
pushd web & call npm install & popd
if errorlevel 1 ( echo [X] npm install failed. & pause & exit /b 1 )
echo [ok] Web dependencies installed.

echo.
echo ============================================================
echo  Setup complete. To start:
echo    1) bot\run-all.cmd            (bot + watcher + streamer)
echo    2) cd web ^&^& npm run dev     (dashboard: http://localhost:3000)
echo ============================================================
echo.
pause
endlocal
