#!/bin/sh
# Writes the Homebrew cask for release X.Y.Z (packaging/homebrew/reviewgate.rb, and the tap's Casks/reviewgate.rb when
# HOMEBREW_TAP_DIR points at a checkout of github.com/seunggulee1007/homebrew-tap). The checksum comes from
# build/dist/ReviewGate-X.Y.Z.dmg.sha256 when the release was built here, else from the release's own .sha256 asset.
# Nothing is committed or pushed: the tap's commit and push stay with the maintainer.
#
#   scripts/update-cask.sh 0.5.26
set -eu
V="${1:?usage: scripts/update-cask.sh X.Y.Z}"
case "$V" in *[!0-9.]*|"") echo "not a version: $V" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL="$ROOT/build/dist/ReviewGate-$V.dmg.sha256"
if [ -f "$LOCAL" ]; then
  SHA="$(cut -d' ' -f1 "$LOCAL")"
else
  SHA="$(curl -fsSL "https://github.com/seunggulee1007/reviewgate-for-claude-code/releases/download/v$V/ReviewGate-$V.dmg.sha256" | cut -d' ' -f1)"
fi
case "$SHA" in *[!0-9a-f]*|"") echo "no checksum for $V" >&2; exit 1;; esac
[ "${#SHA}" -eq 64 ] || { echo "bad checksum for $V: $SHA" >&2; exit 1; }
CASK="$ROOT/packaging/homebrew/reviewgate.rb"
sed -i '' -e "s/^  version \".*\"/  version \"$V\"/" -e "s/^  sha256 \".*\"/  sha256 \"$SHA\"/" "$CASK"
echo "packaging/homebrew/reviewgate.rb -> $V ($SHA)"
if [ -n "${HOMEBREW_TAP_DIR:-}" ]; then
  mkdir -p "$HOMEBREW_TAP_DIR/Casks"
  cp "$CASK" "$HOMEBREW_TAP_DIR/Casks/reviewgate.rb"
  echo "copied to $HOMEBREW_TAP_DIR/Casks/reviewgate.rb — commit and push the tap to publish it"
fi
