@echo off
REM Helper menjalankan Next.js di folder yang mengandung '&' (npm run/npx rusak di sini).
REM Pakai: nx dev | nx build | nx start | nx lint
cd /d "%~dp0"
node node_modules\next\dist\bin\next %*
