#!/bin/bash
# §36.8: verifies the installed Claude CLI with every real-CLI driver and, when all of them pass, adds its version to
# <data dir>/verified-cli.json — the engine reads that file at each session start, so a new CLI needs no new app release.
#   make verify-cli            the installed CLI (CLAUDE_PATH, default ~/.local/bin/claude)
#   make verify-cli IF_NEW=1   nothing to do when that version is already verified (for a scheduled run)
# The drivers use the CLI's own login (sessions under ~/.claude) and RG_MODEL=haiku; each gets its own scratch data dir,
# so the app's records are not touched — only verified-cli.json is written, after the last driver passed. About 7 minutes.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
CLAUDE=${CLAUDE_PATH:-$HOME/.local/bin/claude}
DATA=${REVIEWGATE_DATA_DIR:-$HOME/.reviewgate}
DRIVERS=${DRIVERS:-crash hookblock peer perms gate review2 why agents session flow follow}
SIDECAR=$REPO/sidecar/dist/sidecar.mjs
NODE_DIR=$("$REPO/scripts/find-node.sh") || exit 1
export PATH="$NODE_DIR:$PATH"

VER=$("$CLAUDE" --version 2>/dev/null | sed -n 's/^v\{0,1\}\([0-9][0-9.]*\) (Claude Code).*/\1/p' | head -1)
[ -n "$VER" ] || { echo "verify-cli: no Claude Code version from $CLAUDE --version" >&2; exit 1; }
[ -f "$SIDECAR" ] || { echo "verify-cli: $SIDECAR is missing — run make sidecar" >&2; exit 1; }
[ -n "$(echo $DRIVERS)" ] || { echo "verify-cli: no drivers to run" >&2; exit 1; }

# Already verified: inside the built-in range (engine/src/session/cliVersion.ts) or listed in verified-cli.json.
VERIFIED=$(node "$REPO/scripts/verified-cli.mjs" check "$DATA" "$VER")
if [ "$VERIFIED" = yes ]; then
  echo "verify-cli: Claude Code $VER is already verified"
  [ -n "${IF_NEW:-}" ] && exit 0
fi

RUN=$(mktemp -d "${TMPDIR:-/tmp}/rg-verify-cli-$VER-XXXX")
echo "verify-cli: Claude Code $VER — drivers: $DRIVERS (logs: $RUN)"
cd "$REPO" || exit 1
failed=""
for d in $DRIVERS; do
  W=$RUN/$d
  mkdir -p "$W" "$W-data"
  start=$(date +%s)
  CLAUDE_PATH=$CLAUDE RG_MODEL=haiku REVIEWGATE_DATA_DIR=$W-data \
    perl -e 'alarm 900; exec @ARGV' node "sidecar/test/driver-$d.mjs" "$W" "$SIDECAR" > "$RUN/$d.log" 2>&1
  rc=$?
  echo "  $d rc=$rc $(( $(date +%s) - start ))s"
  [ $rc -eq 0 ] || failed="$failed $d"
done

if [ -n "$failed" ]; then
  echo "verify-cli: FAILED on Claude Code $VER:$failed — not recorded (logs: $RUN)" >&2
  exit 1
fi

node "$REPO/scripts/verified-cli.mjs" record "$DATA" "$VER" "$(cat "$REPO/VERSION")" $DRIVERS || exit 1
rm -rf "$RUN"
echo "verify-cli: Claude Code $VER verified — recorded in $DATA/verified-cli.json (new sessions take it; restart a running one)"
