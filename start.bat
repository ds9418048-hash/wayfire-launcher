@echo off
cd /d "%~dp0"
if not exist main.js (
  echo Wrong folder: main.js was not found next to start.bat.
  echo Unpack the WHOLE wayfire-app.zip and run start.bat from inside the unpacked folder.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org - the LTS button, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules\electron (
  echo First start: downloading Electron. This takes a few minutes...
  call npm install --save-dev electron
)
call npx electron .
pause
