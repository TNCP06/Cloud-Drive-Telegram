@echo off
REM ============================================================================
REM Telegram Cloud Drive - one-shot setup for LAPTOP mode on Windows.
REM
REM Installs Python + Node deps, creates env files, asks which feature set you
REM want, runs the one-time Telethon logins, and applies the PostgreSQL schema
REM (set DATABASE_URL to your Postgres). After it finishes, start everything with:
REM     bot\run-all.cmd          (bot + watcher + streamer)
REM     cd web ^&^& npm run dev   (dashboard at http://localhost:3000)
REM
REM Usage:  double-click setup.bat, or run it from the repo root in a terminal.
REM         setup.bat --mvp    core features only, no questions
REM         setup.bat --full   everything (transcoding + subtitles)
REM Re-run any time - it skips what is already done.
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "MODE="
if /i "%~1"=="--mvp"  set "MODE=mvp"
if /i "%~1"=="--full" set "MODE=full"

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
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [!] ffmpeg not found in PATH - thumbnails, video compression, subtitles and
  echo     seek previews will be skipped. Install from https://ffmpeg.org to enable them.
) else (
  echo [ok] ffmpeg found.
)

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
  echo [!] Created bot\.env - FILL IN the values (BOT_TOKEN, TG_API_ID/HASH, STORAGE_CHANNEL_ID, OWNER_USER_ID, DATABASE_URL).
  set NEED_EDIT=1
)
if not exist web\.env.local (
  copy /y web\.env.local.example web\.env.local >nul
  echo [!] Created web\.env.local - FILL IN the values (DATABASE_URL, NEXT_PUBLIC_BOT_USERNAME, BOT_TOKEN, STORAGE_CHANNEL_ID).
  set NEED_EDIT=1
)
if defined NEED_EDIT (
  echo.
  echo Opening env files in Notepad - fill them in, save, then continue.
  start /wait notepad bot\.env
  start /wait notepad web\.env.local
)
echo [ok] Env files present.

REM --- 2b. Optional features ------------------------------------------------
REM Laptop mode has no Docker profiles (no openlist / cloudflared containers); the
REM optional parts are the streamer's disk/CPU-heavy jobs, flagged in bot\.env.
echo.
echo The core - upload, index, download, dashboard, video streaming - is always installed.
echo Optional on top: full-copy streaming ^(seek previews + transcoding^) and subtitles.
REM Questions are asked through the :ask subroutine and chained with goto - a
REM "set /p" nested inside a parenthesised block loses piped/redirected input.
if not defined MODE (
  call :ask "Install the MVP only, or pick optional features one by one? [mvp/pick] (default mvp): "
  if /i "!ANS!"=="p" ( set "MODE=pick" ) else ( set "MODE=mvp" )
)
if "!MODE!"=="mvp"  goto :feat_mvp
if "!MODE!"=="full" goto :feat_full
goto :feat_pick

:feat_mvp
call :setflag STREAM_LOCAL_ORIGINAL 0
call :setflag VIDEO_COMPRESS 0
call :setflag SUBTITLE_GEN 0
echo [ok] MVP only - video streams straight from Telegram in chunks, nothing is
echo      transcoded and no subtitles are generated.
goto :feat_done

:feat_full
call :setflag STREAM_LOCAL_ORIGINAL 1
call :setflag VIDEO_COMPRESS 1
call :setflag SUBTITLE_GEN 1
echo [ok] All optional features on - set GROQ_API_KEYS in bot\.env or subtitles stay idle.
goto :feat_done

:feat_pick
echo.
echo   Streaming works either way: by default only the chunks you actually watch are
echo   proxied and cached. A full local copy is what seek previews/transcoding need.
call :ask "  Cache the FULL video on disk while streaming? [y/N] "
if /i not "!ANS!"=="y" goto :feat_nolocal
call :setflag STREAM_LOCAL_ORIGINAL 1
call :ask "  Background video compression (ffmpeg H.264 re-encode; CPU-heavy)? [y/N] "
if /i "!ANS!"=="y" ( call :setflag VIDEO_COMPRESS 1 ) else ( call :setflag VIDEO_COMPRESS 0 )
goto :feat_subs

:feat_nolocal
call :setflag STREAM_LOCAL_ORIGINAL 0
call :setflag VIDEO_COMPRESS 0

:feat_subs
call :ask "  Automatic subtitles (Groq Whisper STT + translation)? [y/N] "
if /i not "!ANS!"=="y" goto :feat_nosubs
call :setflag SUBTITLE_GEN 1
echo   [!] Set GROQ_API_KEYS in bot\.env or subtitle generation stays idle.
goto :feat_done

:feat_nosubs
call :setflag SUBTITLE_GEN 0

:feat_done

REM --- 3. Telethon logins (one-time) ---------------------------------------
echo.
if not exist bot\worker.session (
  echo --^> Telethon login for the WATCHER (phone + code; 2FA if enabled)...
  pushd bot
  python login.py worker
  set "RC=!errorlevel!"
  popd
  if not "!RC!"=="0" ( echo [X] Telethon login for the watcher failed. & pause & exit /b 1 )
) else (
  echo [ok] bot\worker.session already exists.
)
if not exist bot\streamer.session (
  echo --^> Telethon login for the STREAMER...
  pushd bot
  python login.py streamer
  set "RC=!errorlevel!"
  popd
  if not "!RC!"=="0" ( echo [X] Telethon login for the streamer failed. & pause & exit /b 1 )
) else (
  echo [ok] bot\streamer.session already exists.
)

REM --- 4. PostgreSQL schema (idempotent; needs DATABASE_URL reachable) ------
echo.
echo --^> Applying PostgreSQL schema (safe to re-run)...
pushd bot
python apply_schema.py
set "RC=!errorlevel!"
popd
if not "!RC!"=="0" (
  echo [X] Could not apply the schema - check DATABASE_URL in bot\.env and that PostgreSQL is running.
  pause & exit /b 1
)
echo [ok] Schema applied.

REM --- 5. Web dependencies --------------------------------------------------
echo.
echo --^> Installing web dependencies (npm install)...
pushd web
call npm install
set "RC=!errorlevel!"
popd
if not "!RC!"=="0" ( echo [X] npm install failed. & pause & exit /b 1 )
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
exit /b 0

REM --- helper: prompt, keep the first character of the answer in ANS ---------
:ask
set "ANS="
set /p ANS=%~1
REM Slicing an UNDEFINED var yields the literal "~0,1", so only slice a real answer.
if not defined ANS exit /b 0
set "ANS=!ANS:~0,1!"
exit /b 0

REM --- helper: set KEY=VALUE in bot\.env (replace the line, or append it) ----
:setflag
REM Redirect first: "echo KEY=1>> file" would parse the 1 as a stream number.
findstr /b /v /c:"%~1=" bot\.env > bot\.env.tmp
>> bot\.env.tmp echo %~1=%~2
move /y bot\.env.tmp bot\.env >nul
exit /b 0
