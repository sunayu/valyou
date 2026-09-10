#!/usr/bin/env bash
#
# Render valyou store promotional assets from HTML to pixel-exact PNGs.
#
# Uses headless Chrome at 2x device scale for supersampled anti-aliasing, then
# downsamples with sips to the exact store dimensions. Dependency-free beyond a
# Chrome install and macOS's built-in sips.
#
#   ./web/store-assets/render.sh
#
set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SRC="$(cd "$(dirname "$0")/src" && pwd)"
OUT="$(cd "$(dirname "$0")" && pwd)/out"
TMP="$(mktemp -d)"
mkdir -p "$OUT"

# name  width  height  outfile
render() {
  local name="$1" w="$2" h="$3" outfile="$4"
  local w2=$((w * 2)) h2=$((h * 2))
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-sandbox \
    --force-device-scale-factor=2 --window-size="${w},${h}" \
    --default-background-color=0A0C11FF \
    --screenshot="$TMP/${name}.png" "file://$SRC/${name}.html" >/dev/null 2>&1
  # downsample 2x -> exact size
  sips -z "$h" "$w" "$TMP/${name}.png" --out "$OUT/${outfile}" >/dev/null
  echo "  $outfile  (${w}x${h})"
}

echo "rendering store assets -> $OUT"
render promo-small   440  280  promo-tile-440x280.png
render marquee      1400  560  marquee-1400x560.png
render shot-feed    1280  800  screenshot-1-feed-1280x800.png
render shot-settings 1280 800  screenshot-2-categories-1280x800.png
render shot-video   1280  800  screenshot-3-video-1280x800.png
render shot-privacy 1280  800  screenshot-4-privacy-1280x800.png
rm -rf "$TMP"
echo "done."
