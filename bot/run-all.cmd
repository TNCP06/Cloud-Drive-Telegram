@echo off
REM Jalankan bot, watcher, dan streamer sekaligus.
REM Ketiganya minimized. Tutup window untuk berhenti.
cd /d "%~dp0"
start "TCD Bot" /min cmd /c "python -u bot.py >> bot.log 2>&1"
start "TCD Watcher" /min cmd /c "python -u watcher.py >> watcher.log 2>&1"
start "TCD Streamer" /min cmd /c "python -u streamer.py >> streamer.log 2>&1"
echo Bot + Watcher + Streamer dijalankan (minimized). Log: bot.log / watcher.log / streamer.log
