#!/bin/sh
# Prints the directory of a Node.js >= 24 `node` binary on stdout, or explains on stderr and exits 1.
# Works from Xcode build phases and make, where the interactive shell's PATH (nvm, Homebrew, volta,
# fnm, asdf…) is not loaded. Order: $NODE_BIN (override), `node` on PATH, nvm's default alias,
# the newest nvm install, volta, fnm, asdf, Homebrew, /usr/local.
#   NODE_BIN="$(scripts/find-node.sh)" || exit 1; PATH="$NODE_BIN:$PATH"
MIN_MAJOR=24

major_of() { # $1 = node binary → its major version, or empty
  v="$("$1" -p 'process.versions.node' 2>/dev/null)" || return 1
  echo "${v%%.*}"
}

try() { # $1 = directory that may contain node
  [ -n "$1" ] && [ -x "$1/node" ] || return 1
  m="$(major_of "$1/node")"
  [ -n "$m" ] && [ "$m" -ge "$MIN_MAJOR" ] 2>/dev/null || { tried="$tried $1(v$m)"; return 1; }
  echo "$1"
  exit 0
}

tried=""
if [ -n "${NODE_BIN:-}" ]; then
  try "$NODE_BIN"
  echo "error: NODE_BIN=$NODE_BIN has no node >= $MIN_MAJOR (found:${tried:- none})" >&2
  exit 1
fi

p="$(command -v node 2>/dev/null)" && try "$(dirname "$p")"

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -d "$NVM_DIR/versions/node" ]; then
  versions="$(ls "$NVM_DIR/versions/node" 2>/dev/null | sed -n 's/^v//p' | sort -t. -k1,1nr -k2,2nr -k3,3nr)"
  # the default alias is a version prefix ("24", "v24.12.0") — the newest install matching it first;
  # "node" / "lts/*" match nothing and fall through to the newest install
  alias="$(cat "$NVM_DIR/alias/default" 2>/dev/null)"
  alias="${alias#v}"
  if [ -n "$alias" ]; then
    for v in $versions; do
      case "$v" in "$alias" | "$alias".*) try "$NVM_DIR/versions/node/v$v/bin" ;; esac
    done
  fi
  for v in $versions; do try "$NVM_DIR/versions/node/v$v/bin"; done
fi

try "${VOLTA_HOME:-$HOME/.volta}/bin"
for d in $(ls -d "$HOME/Library/Application Support/fnm/node-versions/"*/installation/bin "$HOME/.local/share/fnm/node-versions/"*/installation/bin 2>/dev/null | sort -r); do try "$d"; done
try "$HOME/.asdf/shims"
try /opt/homebrew/bin
try /opt/homebrew/opt/node/bin
try /usr/local/bin

echo "error: Node.js >= $MIN_MAJOR not found (looked at PATH, nvm, volta, fnm, asdf, Homebrew, /usr/local; too old:${tried:- none})." >&2
echo "       Install Node $MIN_MAJOR+ (e.g. \`nvm install 24\` or \`brew install node\`) or set NODE_BIN=/path/to/node/bin." >&2
exit 1
