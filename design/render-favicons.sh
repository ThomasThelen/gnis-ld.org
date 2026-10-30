#!/bin/bash
# Renders export/favicon.svg to the PNG sizes the website uses, with Chrome.
# Usage: design/render-favicons.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

for size in 16 32 180 512; do
  page="$DIR/export/render-$size.html"
  printf '<!doctype html><html><body style="margin:0;background:transparent"><img src="favicon.svg" width="%s" height="%s" style="display:block"></body></html>' "$size" "$size" > "$page"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --user-data-dir="$PROFILE" --window-size="$size,$size" --screenshot="$DIR/export/favicon-$size.png" "file://$page" 2>/dev/null
  rm "$page"
done
