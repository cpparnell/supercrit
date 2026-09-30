#!/bin/sh
# Zips what Chrome loads, and nothing else, for upload to the Chrome Web Store:
# dist/supercrit-<version>.zip. Tests, build scripts, docs and dump/ stay out.
set -eu
cd "$(dirname "$0")/.."

version=$(node -p 'require("./manifest.json").version')
out="dist/supercrit-$version.zip"
files="manifest.json background.js content.js content.css popup.html popup.js popup.css lib"
[ -d icons ] && files="$files icons"

mkdir -p dist
rm -f "$out"
zip -rqX "$out" $files -x '*.DS_Store'
echo "$out"
unzip -l "$out" | tail -n +4 | sed '$d' | sed '$d'
