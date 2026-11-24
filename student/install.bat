@echo off
rem Builds the agent (if needed), registers it to start at Windows login, and starts it now.
cd /d "%~dp0"
taskkill /im StudentAgent.exe /f >nul 2>&1
call build.bat
if errorlevel 1 (
  pause
  exit /b 1
)
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v StudyMonitorStudent /t REG_SZ /d "\"%~dp0StudentAgent.exe\"" /f >nul
start "" "%~dp0StudentAgent.exe"
echo.
echo [OK] Installed. The agent is running (see the tray icon) and will start at every login.
echo      Do not move or delete this folder. To remove, run uninstall.bat.
echo.
pause
