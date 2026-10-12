#!/bin/sh
# Builds sidecar/dist/sidecar.mjs for the Mac app (Xcode pre-build phase and `make sidecar`).
#
# - npm dependencies are installed (`npm ci`) only when node_modules is missing or package-lock.json's
#   dependencies differ from the ones the tree was installed from. scripts/lock-hash.mjs hashes the
#   lockfile without the root's and the workspaces' own "version" fields (`make version` rewrites
#   only those) and the whole file; both go into node_modules/.reviewgate-stamp
#   (`deps-sha256=<hex>`, `lock-sha256=<hex>`) after a successful install and are compared on every
#   build: the same dependencies under another whole-file hash (a version bump) only re-record the
#   stamp. File times are not compared: a fresh checkout or worktree has a new package-lock.json
#   mtime with the same content.
# - optional dependencies are installed too: `--omit=optional` dropped esbuild's platform binary
#   (@esbuild/<os>-<cpu>), leaving the build to esbuild's install script fetching it again — which
#   fails with scripts disabled (ignore-scripts) or offline with a cold npm cache.
# - an older stamp with the whole file's hash only (`lock-sha256`): still equal → only the new
#   hashes are recorded; different → dependencies are installed (it cannot tell a version bump).
# - an older stamp without a hash (one date line), or none at all (npm's own
#   node_modules/.package-lock.json stands in for it): package-lock.json not newer than it → the
#   tree is taken as current and only the hashes are recorded; newer → dependencies are installed.
# - node_modules as a symbolic link (a worktree sharing another checkout's dependencies) is never
#   installed into or stamped, RG_FORCE_INSTALL included: npm ci would wipe the shared tree. A
#   warning says so (and whether the shared tree looks stale) and the bundle is built from it.
# - the sidecar bundle is rebuilt every time (esbuild, well under a second).
# - SKIP_SIDECAR_BUILD=YES skips everything.
# - RG_FORCE_INSTALL=1 forces the install step (never into a linked node_modules).
# - RG_DRY_RUN=1 prints the decision (`sidecar: decision=<install|skip|record|linked> — <reason>`)
#   and exits 0: nothing is installed, stamped or bundled.
# - On failure: CONFIGURATION=Debug only warns (the app reports the missing engine at runtime);
#   anything else (Release, or no CONFIGURATION = make / CI) fails.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${SKIP_SIDECAR_BUILD:-NO}" = "YES" ]; then
  echo "SKIP_SIDECAR_BUILD=YES — skipping sidecar build"
  exit 0
fi

fail() {
  if [ "${CONFIGURATION:-}" = "Debug" ]; then
    echo "warning: sidecar not ready: $1 (Debug build continues; the app will report it at runtime)"
    exit 0
  fi
  echo "error: sidecar build failed: $1 — a Release build needs sidecar/dist/sidecar.mjs"
  exit 1
}

# find-node's own "error:" lines are folded into fail()'s message (a Debug build must only warn).
NODE_DIR="$("$ROOT/scripts/find-node.sh" 2>&1)" || fail "$(printf '%s' "$NODE_DIR" | sed 's/^error: //' | tr '\n' ' ')"
PATH="$NODE_DIR:$PATH"
export PATH
cd "$ROOT" || fail "cannot cd to $ROOT"
[ -f sidecar/package.json ] || fail "sidecar/package.json missing"
[ -f package-lock.json ] || fail "package-lock.json missing"

HASHES="$(node "$ROOT/scripts/lock-hash.mjs" package-lock.json)" || fail "cannot hash package-lock.json"
DEPS_HASH="$(printf '%s\n' "$HASHES" | sed -n 's/^deps=//p')"
HASH="$(printf '%s\n' "$HASHES" | sed -n 's/^full=//p')"
{ [ -n "$DEPS_HASH" ] && [ -n "$HASH" ]; } || fail "cannot hash package-lock.json"

STAMP=node_modules/.reviewgate-stamp
stamped() { sed -n "s/^$1=//p" "$STAMP" 2>/dev/null | head -n 1; }

if [ ! -e node_modules ] && [ ! -L node_modules ]; then
  action=install; reason="node_modules missing"
elif [ -n "$(stamped deps-sha256)" ]; then
  if [ "$(stamped deps-sha256)" != "$DEPS_HASH" ]; then
    action=install; reason="package-lock.json dependencies changed"
  elif [ "$(stamped lock-sha256)" != "$HASH" ]; then
    action=record; reason="dependencies unchanged (only the workspace versions moved) — recording the new hashes"
  else
    action=skip; reason="package-lock.json unchanged"
  fi
elif [ -n "$(stamped lock-sha256)" ]; then
  # A stamp from before the dependency hash: the whole file's hash only.
  if [ "$(stamped lock-sha256)" = "$HASH" ]; then
    action=record; reason="stamp with the whole file's hash, unchanged — recording the dependency hash"
  else
    action=install; reason="package-lock.json changed"
  fi
else
  REF="$STAMP"
  [ -f "$REF" ] || REF=node_modules/.package-lock.json
  if [ ! -f "$REF" ]; then
    action=install; reason="no install stamp"
  elif [ package-lock.json -nt "$REF" ]; then
    action=install; reason="package-lock.json newer than the stamp without a hash"
  else
    action=record; reason="stamp without a hash, package-lock.json not newer — recording its hash"
  fi
fi

forced=""
if [ "${RG_FORCE_INSTALL:-0}" = "1" ] && [ "$action" != install ]; then
  action=install; reason="RG_FORCE_INSTALL=1"; forced=1
fi

if [ -L node_modules ]; then
  # A shared tree: never npm ci (it empties the link's target for every checkout using it), never stamp.
  note="node_modules is a symbolic link to $(readlink node_modules) — npm ci is never run here"
  [ "${RG_FORCE_INSTALL:-0}" = "1" ] && note="$note (RG_FORCE_INSTALL=1 ignored)"
  if [ "$action" = install ] && [ -z "$forced" ]; then
    note="$note; the shared tree may be stale ($reason): install in the checkout that owns it"
  fi
  action=linked; reason="$note"
fi

echo "sidecar: decision=$action — $reason"
if [ "${RG_DRY_RUN:-0}" = "1" ]; then
  echo "sidecar: RG_DRY_RUN=1 — nothing installed, stamped or bundled"
  exit 0
fi

write_stamp() {
  printf 'deps-sha256=%s\nlock-sha256=%s\nnode=%s\nat=%s\n' "$DEPS_HASH" "$HASH" "$(node -v)" "$(date)" > "$STAMP" \
    || echo "warning: sidecar: cannot write $STAMP (the next build decides again)"
}

case "$action" in
  install)
    echo "sidecar: installing npm dependencies ($reason)"
    npm ci || fail "npm ci failed"
    write_stamp
    ;;
  record)
    write_stamp
    echo "sidecar: node_modules up to date ($(node -v)) — skipping npm ci"
    ;;
  linked)
    echo "warning: sidecar: $reason"
    ;;
  *)
    echo "sidecar: node_modules up to date ($(node -v)) — skipping npm ci"
    ;;
esac

npm run build -w sidecar || fail "esbuild failed"
