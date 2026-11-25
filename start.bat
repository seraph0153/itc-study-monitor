@echo off
rem Starts the Study Monitor supervisor server and opens the dashboard. Close this window to stop.
title Study Monitor
cd /d "%~dp0supervisor"
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo         Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
rem The server opens the dashboard by itself once it is ready.
set SM_OPEN=1
node server.js
pause
