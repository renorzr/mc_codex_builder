@echo off
setlocal
chcp 65001 >nul
set "LAUNCHER=%~dp0launcher\Minecraft-Codex-Launcher.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%" -Action StopGateway -NoPause
set "CODE=%ERRORLEVEL%"
echo.
pause
endlocal & exit /b %CODE%