@echo off
rem Stops the agent and removes it from Windows startup.
taskkill /im StudentAgent.exe /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v StudyMonitorStudent /f >nul 2>&1
echo [OK] Study Monitor agent stopped and removed from startup. You can delete this folder now.
pause
