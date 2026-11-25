# ITC Study Monitor - teacher PC installer / updater (Windows)
# Run in PowerShell:
#   [Net.ServicePointManager]::SecurityProtocol=3072; irm https://raw.githubusercontent.com/seraph0153/itc-study-monitor/main/install-teacher.ps1 | iex
# Re-running it (or double-clicking the "ITC Study Monitor Update" desktop shortcut) updates the program
# and keeps your settings, connection key and records.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Repo = 'seraph0153/itc-study-monitor'
$Dir = Join-Path $env:LOCALAPPDATA 'ITCStudyMonitor'

Write-Host ''
Write-Host '=== ITC Study Monitor - teacher setup ===' -ForegroundColor Cyan

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Node.js is not installed. Installing Node.js LTS with winget...'
    winget install -e --id OpenJS.NodeJS.LTS
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js is required. Install the LTS version from https://nodejs.org, then run this command again.' -ForegroundColor Red
    Start-Process 'https://nodejs.org'
    return
  }
}
Write-Host ('Node.js ' + (node --version) + ' found.')

# 2. Stop the monitor if it is running (so the new version starts cleanly)
try {
  Get-NetTCPConnection -LocalPort 47800 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
    Where-Object { $_.ProcessName -eq 'node' } | Stop-Process -Force
} catch { }
cmd /c 'taskkill /fi "WINDOWTITLE eq Study Monitor*" /f >nul 2>&1'

# 3. Download the latest version
$tmp = Join-Path $env:TEMP ('itcsm_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host 'Downloading...'
  Invoke-WebRequest "https://github.com/$Repo/archive/refs/heads/main.zip" -OutFile "$tmp\src.zip" -UseBasicParsing
  Expand-Archive "$tmp\src.zip" -DestinationPath $tmp -Force
  $src = Get-ChildItem $tmp -Directory | Select-Object -First 1

  # Copy over the old version. config.json (connection key, settings) and data\ (records) are not in the download, so they are kept.
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  Copy-Item -Path (Join-Path $src.FullName '*') -Destination $Dir -Recurse -Force
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "Installed to $Dir"

# 4. Desktop shortcuts: start, and update (runs this same installer again)
$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desktop 'ITC Study Monitor.lnk'))
$lnk.TargetPath = Join-Path $Dir 'start.bat'
$lnk.WorkingDirectory = $Dir
$lnk.Save()
$upd = $ws.CreateShortcut((Join-Path $desktop 'ITC Study Monitor Update.lnk'))
$upd.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$upd.Arguments = '-NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol=3072; irm https://raw.githubusercontent.com/' + $Repo + '/main/install-teacher.ps1 | iex } catch { Write-Host $_ -ForegroundColor Red }; Write-Host; Read-Host ''Press Enter to close''"'
$upd.WorkingDirectory = $Dir
$upd.Description = 'Update ITC Study Monitor to the latest version'
$upd.Save()
Write-Host 'Desktop shortcuts "ITC Study Monitor" and "ITC Study Monitor Update" created.'

# 5. Start
Write-Host ''
Write-Host 'Starting the monitor. If Windows Firewall asks, check BOTH Private and Public networks and click Allow.' -ForegroundColor Yellow
Write-Host 'From now on, double-click "ITC Study Monitor" on the desktop to start it.'
Start-Process (Join-Path $Dir 'start.bat') -WorkingDirectory $Dir
