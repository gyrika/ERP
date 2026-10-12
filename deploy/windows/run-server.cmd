@echo off
rem Started by the "CheesyBeez POS server" task when Windows starts (as SYSTEM).
rem Keeps the server running: if it ever stops, it starts again 5 seconds later.
rem Output goes to C:\CheesyBeez\logs\server.log.
cd /d "%~dp0..\.."
if not exist "C:\CheesyBeez\logs" mkdir "C:\CheesyBeez\logs"
set NODE=node
if exist "%ProgramFiles%\nodejs\node.exe" set NODE="%ProgramFiles%\nodejs\node.exe"
:loop
echo [%date% %time%] starting server >> "C:\CheesyBeez\logs\server.log"
%NODE% --experimental-strip-types --no-warnings --env-file-if-exists=server/.env server/main.ts >> "C:\CheesyBeez\logs\server.log" 2>&1
echo [%date% %time%] server stopped (exit %errorlevel%), restarting in 5 s >> "C:\CheesyBeez\logs\server.log"
timeout /t 5 /nobreak > nul
goto loop
