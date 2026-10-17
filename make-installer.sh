#!/bin/sh
# Сборка установщика Wayfire для той системы, на которой запущен файл.
# Windows: make-installer.bat. Здесь: Linux (AppImage) и macOS (dmg).
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Сначала установи Node.js: https://nodejs.org (LTS)."; exit 1; }
[ -d node_modules/electron ] || npm install --save-dev electron
[ -d node_modules/electron-builder ] || npm install --save-dev electron-builder
case "$(uname -s)" in
  Darwin) npx electron-builder --mac ;;
  Linux)  npx electron-builder --linux ;;
  *) echo "Для Windows запусти make-installer.bat"; exit 1 ;;
esac
echo "Готово. Установщик лежит в папке dist."
