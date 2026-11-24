# ITC Study Monitor - student PC installer (Windows)
# Copy the exact command from the teacher dashboard (it contains the connection key), paste it into PowerShell and press Enter:
#   [Net.ServicePointManager]::SecurityProtocol=3072; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/seraph0153/itc-study-monitor/main/install-student.ps1))) -Code <key>
# Options: -Server <teacher PC IP>  -Name <display name>  -Uninstall
param(
  [string]$Code = '',
  [string]$Server = '',
  [string]$Name = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Repo = 'seraph0153/itc-study-monitor'
$Dir = Join-Path $env:LOCALAPPDATA 'ITCStudyMonitorStudent'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'StudyMonitorStudent'

Write-Host ''
Write-Host '=== ITC Study Monitor - student setup ===' -ForegroundColor Cyan

Get-Process StudentAgent -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

if ($Uninstall) {
  Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
  Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host '[OK] Removed.' -ForegroundColor Green
  return
}

$Code = $Code.Trim().ToLower()
if ($Code -notmatch '^[a-f0-9]{16}$') {
  Write-Host 'The connection key is missing or wrong. Copy the full command from the teacher dashboard again.' -ForegroundColor Red
  return
}
if ($Server -and $Server -notmatch '^[A-Za-z0-9.\-:]+$') { Write-Host 'Wrong -Server value.' -ForegroundColor Red; return }
$Name = ($Name -replace '[\r\n=]', '').Trim()

# 1. Download
$tmp = Join-Path $env:TEMP ('itcsm_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host 'Downloading...'
  Invoke-WebRequest "https://github.com/$Repo/archive/refs/heads/main.zip" -OutFile "$tmp\src.zip" -UseBasicParsing
  Expand-Archive "$tmp\src.zip" -DestinationPath $tmp -Force
  $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  Copy-Item -Path (Join-Path $src.FullName 'student\*') -Destination $Dir -Recurse -Force
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# 2. Settings
$cfg = @(
  '# Study Monitor - student agent settings',
  "code=$Code",
  "server=$Server",
  "name=$Name"
)
[IO.File]::WriteAllLines((Join-Path $Dir 'config.txt'), $cfg)

# 3. Build with the C# compiler that ships with Windows
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { Write-Host '.NET Framework 4 compiler not found on this PC.' -ForegroundColor Red; return }
Write-Host 'Building...'
& $csc /nologo /codepage:65001 /target:winexe /optimize+ "/out:$Dir\StudentAgent.exe" `
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "$Dir\StudentAgent.cs"
if ($LASTEXITCODE -ne 0) { Write-Host 'Build failed. Send the messages above to the developer.' -ForegroundColor Red; return }

# 4. Start at every login, and start now
Set-ItemProperty -Path $RunKey -Name $RunName -Value ('"' + "$Dir\StudentAgent.exe" + '"')
Start-Process "$Dir\StudentAgent.exe"

Write-Host ''
Write-Host '[OK] Installed. This PC will appear on the teacher dashboard in a few seconds.' -ForegroundColor Green
Write-Host '     It starts automatically at every login. You can close this window.'
