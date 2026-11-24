@echo off
rem Builds StudentAgent.exe with the C# compiler that ships with Windows (.NET Framework 4).
cd /d "%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [ERROR] .NET Framework 4 compiler not found on this PC.
  exit /b 1
)
"%CSC%" /nologo /codepage:65001 /target:winexe /optimize+ /out:StudentAgent.exe /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll StudentAgent.cs
if errorlevel 1 (
  echo [ERROR] Build failed.
  exit /b 1
)
echo [OK] StudentAgent.exe built.
exit /b 0
