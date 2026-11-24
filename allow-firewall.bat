@echo off
rem Optional. Run as administrator ONLY if student PCs cannot connect.
rem Allows other devices on the same local network to reach Study Monitor on this PC
rem (TCP 47800 for screens, UDP 47801 for auto-discovery). Nothing outside the local subnet is allowed.
net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="Study Monitor" >nul 2>&1
netsh advfirewall firewall add rule name="Study Monitor" dir=in action=allow protocol=TCP localport=47800 remoteip=localsubnet profile=any
netsh advfirewall firewall add rule name="Study Monitor" dir=in action=allow protocol=UDP localport=47801 remoteip=localsubnet profile=any
echo.
echo [OK] Firewall rules added. To remove them later, run:
echo      netsh advfirewall firewall delete rule name="Study Monitor"
pause
