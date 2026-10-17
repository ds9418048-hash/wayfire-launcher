#!/bin/sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Сначала установи Node.js: https://nodejs.org (версия LTS), потом запусти этот файл ещё раз."
  exit 1
fi
if [ ! -d node_modules/electron ]; then
  echo "Первый запуск: скачиваю Electron, это займёт пару минут..."
  npm install --save-dev electron
fi
npx electron .
