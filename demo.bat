@echo off
setlocal
set "DEMO_MODE=1"
if not defined PIN set "PIN=123456"
set "WEB_DIR=%~dp0web"
if not exist "%WEB_DIR%\package.json" (
  echo [X] web\package.json not found under "%~dp0"
  exit /b 1
)
pushd "%WEB_DIR%" || exit /b 1
npm --prefix "%WEB_DIR%" run dev
