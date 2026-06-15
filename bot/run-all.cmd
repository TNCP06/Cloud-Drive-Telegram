@echo off
REM Jalankan bot (index real-time) + watcher (eksekusi antrian upload dari web) sekaligus.
REM Keduanya minimized, output ke bot.log / watcher.log. Tutup window untuk berhenti.
cd /d "%~dp0"
start "TCD Bot" /min cmd /c "python -u bot.py >> bot.log 2>&1"
start "TCD Watcher" /min cmd /c "python -u watcher.py >> watcher.log 2>&1"
echo Bot + Watcher dijalankan (minimized). Log: bot.log / watcher.log
