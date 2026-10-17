@echo off
cd /d "%~dp0"
if not exist main.js (
  echo Wrong folder: main.js was not found next to this file.
  echo Unpack the WHOLE wayfire-app.zip and run this file from inside the unpacked folder.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org - the LTS button, then run this file again.
  pause
  exit /b 1
)
set CSC_IDENTITY_AUTO_DISCOVERY=false
if not exist node_modules\electron (
  echo Downloading Electron. This takes a few minutes...
  call npm install --save-dev electron
)
if not exist node_modules\electron-builder (
  echo Downloading the installer builder. This takes a few minutes...
  call npm install --save-dev electron-builder
)
echo Building the Windows installer...
call npx electron-builder --win
if errorlevel 1 (
  echo.
  echo BUILD FAILED.
  echo If you see "Cannot create symbolic link": right-click this file and choose "Run as administrator",
  echo or turn on Developer Mode in Windows Settings - For developers, then run it again.
  pause
  exit /b 1
)
echo.
echo Done. The installer is in the "dist" folder: Wayfire-1.0.0-win.exe
start "" dist
pause
