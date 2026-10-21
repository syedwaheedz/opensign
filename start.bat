@echo off
REM Double-click to start OpenSign on Windows. Requires Node.js (https://nodejs.org, LTS).
cd /d "%~dp0server"
if not exist node_modules call npm install --omit=dev
node index.js
pause
