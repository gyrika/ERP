@echo off
rem Runs at login (shortcut in the Startup folder). Waits for the server, then opens the POS
rem full screen. The first time, it opens the one-time pairing link instead (left by install.ps1).
setlocal
set URL=http://localhost:8080/
set PAIR="%~dp0pairing-link.txt"
if exist %PAIR% set /p URL=<%PAIR%

for /l %%i in (1,1,120) do (
  curl.exe -s -o nul http://localhost:8080/api/v1/health && goto up
  timeout /t 1 /nobreak > nul
)
:up
if exist %PAIR% del %PAIR%

set BROWSER=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set BROWSER="%ProgramFiles%\Google\Chrome\Application\chrome.exe" --kiosk --no-first-run
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set BROWSER="%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --kiosk --no-first-run
if not defined BROWSER set BROWSER="%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --kiosk --edge-kiosk-type=fullscreen --no-first-run
start "" %BROWSER% "%URL%"
