@echo off
rem Opens the POS full screen once the server answers (at login, and from the desktop icon).
rem Alt+F4 closes it.
setlocal
for /l %%i in (1,1,120) do (
  curl.exe -s -o nul http://localhost:8080/api/v1/health && goto up
  timeout /t 1 /nobreak > nul
)
:up
set BROWSER=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set BROWSER="%ProgramFiles%\Google\Chrome\Application\chrome.exe" --kiosk --no-first-run
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set BROWSER="%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --kiosk --no-first-run
if not defined BROWSER set BROWSER="%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --kiosk --edge-kiosk-type=fullscreen --no-first-run
start "" %BROWSER% "http://localhost:8080/"
