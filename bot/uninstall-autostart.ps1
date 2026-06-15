# Lepas auto-start (hapus shortcut di folder Startup).
# Jalankan:  powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'TelegramCloudDrive.lnk'
if (Test-Path $lnkPath) {
    Remove-Item $lnkPath -Force
    Write-Host "OK: auto-start dilepas."
} else {
    Write-Host "Tidak ada auto-start terpasang."
}
