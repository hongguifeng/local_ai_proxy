@echo off
setlocal

where node >nul 2>nul || (
  echo Node.js 24 is required.
  exit /b 1
)

if not exist dist-node\src\main.js (
  call npm run build || exit /b 1
)

node --enable-source-maps dist-node\src\main.js --no-browser %*
