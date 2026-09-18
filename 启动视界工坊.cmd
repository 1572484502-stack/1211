@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-vista.ps1"
if errorlevel 1 (
  echo.
  echo Vista Studio failed to start.
  echo Please keep this window open and send the error message to support.
  pause
)
endlocal
