# Pasang auto-start: bot + watcher jalan otomatis tiap kali login Windows.
# Caranya membuat shortcut ke run-all.cmd di folder Startup.
# Jalankan sekali:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1
$ErrorActionPreference = "Stop"
$startup = [Environment]::GetFolderPath('Startup')
$target = Join-Path $PSScriptRoot 'run-all.cmd'
$lnkPath = Join-Path $startup 'TelegramCloudDrive.lnk'

$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($lnkPath)
$lnk.TargetPath = $target
$lnk.WorkingDirectory = $PSScriptRoot
$lnk.WindowStyle = 7          # minimized
$lnk.Description = "Telegram Cloud Drive - bot + watcher"
$lnk.Save()

Write-Host "OK: auto-start terpasang -> $lnkPath"
Write-Host "Bot + watcher akan berjalan otomatis setiap login."
Write-Host "Lepas dengan: powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1"
