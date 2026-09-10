#!/usr/bin/env bash
#
# Sync the canonical Chrome/Web extension source into the Safari Xcode project.
#
# The Safari converter COPIED the extension into the Xcode project, so that copy
# drifts whenever you edit the real extension. Run this after any change to
# manifest.json / icons / src to refresh the Safari build's resources — no need
# to re-run the converter (which would regenerate the whole project).
#
#   ./safari/sync.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="$ROOT/safari/xcode/valyou/Shared (Extension)/Resources"

if [ ! -d "$RES" ]; then
  echo "Safari project not found at: $RES" >&2
  echo "Generate it first (see safari/README.md)." >&2
  exit 1
fi

# Mirror the code + icons. --delete keeps the copy exact.
rsync -a --delete "$ROOT/src/"   "$RES/src/"
rsync -a --delete "$ROOT/icons/" "$RES/icons/"
# The manifest is NOT a straight copy: Safari needs a non-persistent background
# PAGE instead of Chrome's service worker. build-manifest.js derives the Safari
# manifest from the canonical one, swapping only the background block.
node "$(dirname "$0")/build-manifest.js"

echo "Synced icons/ and src/, and generated the Safari manifest."
echo "Rebuild in Xcode (or: xcodebuild -scheme 'valyou (macOS)') to pick up changes."
