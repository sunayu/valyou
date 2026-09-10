#!/usr/bin/env bash
#
# Mux the captured frames + the licensed soundtrack into upload-ready MP4s.
#   ./encode.sh
# Produces a 1080p master (YouTube-ready) and a 720p companion, plus a poster.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"

FRAMES="frames/frame-%05d.png"
AUDIO="promo-audio.m4a"
OUT="valyou-promo-1080p.mp4"
OUT720="valyou-promo-720p.mp4"

echo "encoding 1080p master ..."
ffmpeg -y -hide_banner -loglevel error \
  -framerate 30 -i "$FRAMES" -i "$AUDIO" \
  -c:v libx264 -profile:v high -level 4.2 -pix_fmt yuv420p -crf 18 -preset slow \
  -c:a aac -b:a 256k -ar 48000 \
  -shortest -movflags +faststart "$OUT"

echo "encoding 720p companion ..."
ffmpeg -y -hide_banner -loglevel error \
  -framerate 30 -i "$FRAMES" -i "$AUDIO" \
  -vf "scale=1280:720:flags=lanczos" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 20 -preset slow \
  -c:a aac -b:a 192k -ar 48000 \
  -shortest -movflags +faststart "$OUT720"

echo "poster frame ..."
ffmpeg -y -hide_banner -loglevel error -i "$OUT" -ss 34.6 -frames:v 1 poster.png

echo "---"
for f in "$OUT" "$OUT720"; do
  d=$(ffprobe -v error -show_entries format=duration:stream=width,height -of csv=p=0 "$f" | tr '\n' ' ')
  sz=$(ls -lh "$f" | awk '{print $5}')
  echo "$f  [$sz]  $d"
done
