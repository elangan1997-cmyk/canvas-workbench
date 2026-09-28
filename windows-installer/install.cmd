@echo off
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo Installation failed. See the message above and the DSH canvas log.
  pause
  exit /b 1
)
echo Installation completed. Restart DSH Desktop.
pause
