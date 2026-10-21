#!/bin/bash
# Double-click to start OpenSign on macOS (or run ./start.command on Linux). Requires Node.js (https://nodejs.org, LTS).
cd "$(dirname "$0")/server" || exit 1
[ -d node_modules ] || npm install --omit=dev
node index.js
