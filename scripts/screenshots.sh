#!/bin/sh
# README screenshots of the Mac app (`make screenshots`): a demo project, a Debug build under a bundle id of its own, one
# real Claude Code turn driven in-process by the DEBUG-only tour (App/Debug/ScreenshotTour.swift), and the window's PNGs
# — review, why, budget, agents; dark and light — scaled into docs/images/. A ReviewGate window shows for a few minutes
# and stays above the other windows for the last few seconds (the shots).
#
# It never touches the installed app or the user's data:
# - the build is io.github.seunggulee1007.reviewgate.screenshots: its own defaults domain (reset on every run, the tour's
#   settings written there), no reviewgate:// scheme or folder role in its Info.plist, and unregistered from
#   LaunchServices afterwards;
# - the engine's data dir is a fresh folder under SHOTS_DIR (never ~/.reviewgate); workbenches would go there too;
# - the session loads no user settings (no ~/.claude skills, plugins, hooks, MCP servers or CLAUDE.md); the app starts
#   from launchd (`open`), not with this shell's environment, in English (SHOTS_LANG=ko: in Korean, layout check only);
# - the demo project is only ever deleted when it carries the marker this script wrote into its .git folder.
# The turn leaves a session record under ~/.claude/projects (as any Claude Code run in that folder does).
# On macOS 26 the build runs in the compatibility design (what macOS 15 shows): a window rendering itself cannot draw
# Liquid Glass, and capturing the screen instead would need the screen-recording permission.
#
#   SHOTS_DIR      scratch folder: derived data, data dir, raw PNGs, logs (default: $TMPDIR/reviewgate-screenshots)
#   DEMO_DIR       the demo project (default /Users/Shared/acme-shop; not under /tmp, where the app shows a banner)
#   SHOTS_PROMPT   the prompt (default: the tour's own)       SHOTS_MODEL    default haiku
#   SHOTS_WIDTH    image width in pixels (default 1600)        SHOTS_TIMEOUT  seconds for the tour (default 600)
#   SHOTS_LAYOUT   1: no turn — the chat column in short windows, the "Run as Task" sheet and the transcript through
#                  ⇧⇥ and reviews (made-up rows), PNGs left in SHOTS_DIR/raw; scroll: only the transcript's scroll check
#                  (subagents' rows coming in above the bottom, following and scrolled up; `scroll:` lines in tour.log);
#                  blank: the chat column in windows taller than the laptop's (a turn, agents, the diff pane, a review, hidden,
#                  minimised, another display, a new chat and back; `chat:` / `column:` lines, BLANK / OUT OF THE WINDOW);
#                  cpu: the main thread's CPU while Claude works with agents, streaming or not, in front and behind
#                  another app, a new chat's time to its rows and the chat's back from the PRs tab (`cpu:` lines; cpulong:
#                  the same after 45 more turns in the open chat); cards: the composer's shots (a review,
#                  Claude's question and a permission card above the composer) six times over the layout check's transcript;
#                  scrolldown: a long chat scrolled down to its end as a trackpad does, idle and streaming (`scrolldown:` lines,
#                  a JUMP when the view went further from the newest row than the reader took it);
#                  open: Open Project… / Switch Project… / Open in New Window… in each state a window can be in (`open` lines).
#                  overlap: a long session of rich turns (a question answered, MCP and Bash calls, answers with tables, turn
#                  summaries) while turns begin and stream, the reader scrolls up and down, the window resizes and the diff pane
#                  opens; after each step two rows on screen laid out over one another, an answer's text or table in no
#                  row's frame, or a text taller than its frame, still so 1.5 s later, is an OVERLAP (`overlap` lines,
#                  overlap-<n>.png).
#                  composer: the message box against the terminal's input — ⌘V of an image from a private pasteboard
#                  (a screenshot, Preview, a browser, a Finder copy; never the user's clipboard), "/" opening the slash
#                  palette with every source and filtering it, the queue bar with what waits in Claude's turn and its
#                  edit / take-back tools, ↑ in an empty box bringing the last waiting message back (`composer` lines;
#                  also part of SHOTS_LAYOUT=1).
#                  A shot marked TALLER, CUT, OUT OF THE WINDOW, LOST, BLANK, SILENT, JUMP or OVERLAP in tour.log fails the run (exit 1)
#   SHOTS_LANG     en (default) or ko: the app's language — ko only with SHOTS_LAYOUT (docs/images stays English), for
#                  checking the Korean words at the laptop size
#   SHOTS_VISIBLE  1: a SHOTS_LAYOUT run shows its windows and comes to the front as the README run does. By default it is
#                  quiet: launched in the background (`open -g`), an accessory app (no Dock icon, never the active app),
#                  its windows transparent and click-through — the captures render the views, not the screen
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_ID=io.github.seunggulee1007.reviewgate.screenshots
SHOTS_DIR="${SHOTS_DIR:-${TMPDIR:-/tmp}/reviewgate-screenshots}"
SHOTS_DIR="${SHOTS_DIR%/}"
DEMO_DIR="${DEMO_DIR:-/Users/Shared/acme-shop}"
WIDTH="${SHOTS_WIDTH:-1600}"
TIMEOUT="${SHOTS_TIMEOUT:-600}"
UI_LANG="${SHOTS_LANG:-en}"
MARKER=reviewgate-screenshots-demo
DERIVED="$SHOTS_DIR/DerivedData"
DATA="$SHOTS_DIR/data"
RAW="$SHOTS_DIR/raw"
APP="$DERIVED/Build/Products/Debug/ReviewGate.app"
OUT="$ROOT/docs/images"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

die() { echo "screenshots: $*" >&2; exit 1; }
say() { echo "screenshots: $*"; }

case "$DEMO_DIR" in /tmp/*|/private/tmp/*|/var/folders/*|/private/var/*) die "DEMO_DIR must not be a temporary folder: $DEMO_DIR";; /*) ;; *) die "DEMO_DIR must be absolute";; esac
case "$SHOTS_DIR" in /*) ;; *) die "SHOTS_DIR must be absolute";; esac
case "$UI_LANG" in en) UI_LOCALE=en_US;; ko) UI_LOCALE=ko_KR;; *) die "SHOTS_LANG must be en or ko";; esac
[ "$UI_LANG" = en ] || [ -n "${SHOTS_LAYOUT:-}" ] || die "SHOTS_LANG=$UI_LANG is for the layout check (SHOTS_LAYOUT): docs/images stays in English"
case "$(cd "$SHOTS_DIR" 2>/dev/null && pwd -P || echo "$SHOTS_DIR")/" in
  "$HOME/"|"$HOME/.reviewgate/"*|//) die "SHOTS_DIR must be a scratch folder of its own (not \$HOME, not ~/.reviewgate)";;
esac
command -v xcodegen >/dev/null || die "xcodegen missing (brew install xcodegen)"
command -v claude >/dev/null || die "the Claude Code CLI is missing"
NODE_DIR="$("$ROOT/scripts/find-node.sh")" || die "Node.js >= 24 not found"
PATH="$NODE_DIR:$PATH"

# --- the demo project ------------------------------------------------------------------------------------------------

if [ -e "$DEMO_DIR" ]; then
  [ -f "$DEMO_DIR/.git/$MARKER" ] || die "$DEMO_DIR exists and is not this script's demo project (no .git/$MARKER) — refusing to delete it"
  rm -rf "$DEMO_DIR"
fi
say "demo project → $DEMO_DIR"
mkdir -p "$DEMO_DIR/src" "$DEMO_DIR/test"
git -C "$DEMO_DIR" -c init.defaultBranch=main init -q
touch "$DEMO_DIR/.git/$MARKER"
git -C "$DEMO_DIR" config user.name "Acme Dev"
git -C "$DEMO_DIR" config user.email dev@acme.example
git -C "$DEMO_DIR" config commit.gpgsign false
git -C "$DEMO_DIR" config core.hooksPath /dev/null

commit() {   # commit <date> <message>
  git -C "$DEMO_DIR" add -A
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git -C "$DEMO_DIR" commit -q -m "$2"
}

cat > "$DEMO_DIR/package.json" <<'EOF'
{
  "name": "acme-shop",
  "version": "0.3.0",
  "private": true,
  "description": "Cart and pricing logic for the Acme storefront.",
  "type": "module",
  "scripts": {
    "test": "node --test \"test/**/*.test.ts\""
  },
  "engines": {
    "node": ">=22.18"
  }
}
EOF
cat > "$DEMO_DIR/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "test"]
}
EOF
printf 'node_modules/\ndist/\n' > "$DEMO_DIR/.gitignore"
cat > "$DEMO_DIR/README.md" <<'EOF'
# acme-shop

Cart and pricing logic for the Acme storefront. Amounts are integers in cents.

```
npm test
```
EOF
cat > "$DEMO_DIR/src/pricing.ts" <<'EOF'
/** Flat shipping per order, in cents. */
export const FLAT_SHIPPING = 599;
/** Sales tax applied to the subtotal. */
export const TAX_RATE = 0.08;

export function shippingFor(subtotal: number): number {
  return subtotal === 0 ? 0 : FLAT_SHIPPING;
}

export function taxFor(amount: number): number {
  return Math.round(amount * TAX_RATE);
}
EOF
cat > "$DEMO_DIR/src/cart.ts" <<'EOF'
import { shippingFor, taxFor } from "./pricing.ts";

export interface LineItem {
  sku: string;
  name: string;
  /** In cents. */
  unitPrice: number;
  quantity: number;
}

export interface Totals {
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
}

export class Cart {
  private readonly items = new Map<string, LineItem>();

  add(item: LineItem): void {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new RangeError(`quantity must be a positive integer, got ${item.quantity}`);
    }
    const existing = this.items.get(item.sku);
    if (existing) existing.quantity += item.quantity;
    else this.items.set(item.sku, { ...item });
  }

  remove(sku: string): void {
    this.items.delete(sku);
  }

  get lines(): LineItem[] {
    return [...this.items.values()];
  }

  totals(): Totals {
    const subtotal = this.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
    const shipping = shippingFor(subtotal);
    const tax = taxFor(subtotal);
    return { subtotal, shipping, tax, total: subtotal + shipping + tax };
  }
}
EOF
cat > "$DEMO_DIR/test/cart.test.ts" <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cart } from "../src/cart.ts";

const mug = { sku: "MUG-01", name: "Enamel mug", unitPrice: 1450, quantity: 1 };
const tee = { sku: "TEE-02", name: "Logo tee", unitPrice: 2400, quantity: 2 };

test("sums line items and merges repeated SKUs", () => {
  const cart = new Cart();
  cart.add(mug);
  cart.add(mug);
  cart.add(tee);
  assert.equal(cart.lines.length, 2);
  assert.equal(cart.totals().subtotal, 2 * 1450 + 2 * 2400);
});

test("an empty cart costs nothing", () => {
  assert.deepEqual(new Cart().totals(), { subtotal: 0, shipping: 0, tax: 0, total: 0 });
});

test("rejects non-positive quantities", () => {
  assert.throws(() => new Cart().add({ ...mug, quantity: 0 }), RangeError);
});
EOF
commit "2026-10-14T10:12:00+0000" "Cart with line items, shipping and tax"

cat > "$DEMO_DIR/src/format.ts" <<'EOF'
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** 1999 → "$19.99". */
export function formatPrice(cents: number): string {
  return usd.format(cents / 100);
}
EOF
cat >> "$DEMO_DIR/src/cart.ts" <<'EOF'

/** The order confirmation's lines: one per item, then the totals. */
export function receipt(cart: Cart): string[] {
  const { subtotal, shipping, tax, total } = cart.totals();
  return [
    ...cart.lines.map((line) => `${line.quantity} × ${line.name}  ${formatPrice(line.unitPrice * line.quantity)}`),
    `Subtotal  ${formatPrice(subtotal)}`,
    `Shipping  ${shipping === 0 ? "Free" : formatPrice(shipping)}`,
    `Tax  ${formatPrice(tax)}`,
    `Total  ${formatPrice(total)}`,
  ];
}
EOF
sed -i '' 's|^import { shippingFor, taxFor } from "./pricing.ts";$|import { formatPrice } from "./format.ts";\
import { shippingFor, taxFor } from "./pricing.ts";|' "$DEMO_DIR/src/cart.ts"
commit "2026-10-16T15:40:00+0000" "Receipt lines for the order confirmation"

cat > "$DEMO_DIR/src/pricing.ts" <<'EOF'
/** Flat shipping per order, in cents. */
export const FLAT_SHIPPING = 599;
/** Orders from this subtotal ship free, in cents. */
export const FREE_SHIPPING_FROM = 5000;
/** Sales tax applied to the subtotal. */
export const TAX_RATE = 0.08;

export function shippingFor(subtotal: number): number {
  return subtotal === 0 || subtotal >= FREE_SHIPPING_FROM ? 0 : FLAT_SHIPPING;
}

export function taxFor(amount: number): number {
  return Math.round(amount * TAX_RATE);
}
EOF
cat >> "$DEMO_DIR/test/cart.test.ts" <<'EOF'

test("ships free from $50", () => {
  const cart = new Cart();
  cart.add({ ...tee, quantity: 3 });
  assert.equal(cart.totals().shipping, 0);
});
EOF
commit "2026-10-21T09:05:00+0000" "Free shipping from \$50"

# --- the data dir and the dev build's settings ------------------------------------------------------------------------

rm -rf "$DATA" "$RAW"
mkdir -p "$DATA" "$RAW"
CLI_VERSION="$(claude --version | awk '{print $1}')"
ENGINE_VERSION="$(sed -n 's/.*ENGINE_VERSION = "\(.*\)".*/\1/p' "$ROOT/engine/src/version.ts")"
node "$ROOT/scripts/verified-cli.mjs" record "$DATA" "$CLI_VERSION" "$ENGINE_VERSION" tour   # no "unverified CLI" banner

defaults delete "$BUNDLE_ID" >/dev/null 2>&1 || true
w() { defaults write "$BUNDLE_ID" "$@"; }
w loadUserSettings -bool false               # settingSources ["project"]: nothing from ~/.claude
w showStatusLine -bool false
w checkForUpdatesAutomatically -bool false
w notificationsEnabled -bool false           # never asks macOS for the notification permission
w notificationsOffNoticeDismissed -bool true
w confirmCloseWhileWorking -bool false       # the tour's quit never waits on an alert
w reopenLastProjects -bool false
w worktreeRoot -string "$DATA/worktrees"
w defaultModeOffered -data "$(printf '["%s"]' "$DEMO_DIR" | xxd -p | tr -d '\n')"

# --- the build --------------------------------------------------------------------------------------------------------

say "building (Debug, $BUNDLE_ID) → $DERIVED"
"$ROOT/scripts/build-sidecar.sh"
(cd "$ROOT" && xcodegen generate --quiet)
xcodebuild -project "$ROOT/ReviewGate.xcodeproj" -scheme ReviewGate -configuration Debug -derivedDataPath "$DERIVED" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= SKIP_SIDECAR_BUILD=YES \
  build > "$SHOTS_DIR/xcodebuild.log" 2>&1 || { tail -30 "$SHOTS_DIR/xcodebuild.log"; die "xcodebuild failed (log: $SHOTS_DIR/xcodebuild.log)"; }
[ -f "$APP/Contents/Resources/dist/sidecar.mjs" ] || die "the build has no sidecar"
# This build never answers reviewgate:// links or opens folders handed to "ReviewGate". The tour renders the window
# in-process, which cannot draw macOS 26's Liquid Glass (the sidebar and toolbar come out blank): the compatibility design.
plist() { /usr/libexec/PlistBuddy -c "$1" "$APP/Contents/Info.plist" >/dev/null 2>&1 || true; }
plist "Delete :CFBundleURLTypes"
plist "Delete :CFBundleDocumentTypes"
plist "Delete :UIDesignRequiresCompatibility"
[ "$(sw_vers -productVersion | cut -d. -f1)" -lt 26 ] || plist "Add :UIDesignRequiresCompatibility bool true"
codesign --force --sign - "$APP" 2>/dev/null || die "cannot re-sign $APP"

# --- the tour ---------------------------------------------------------------------------------------------------------

OPEN_PID=""
cleanup() {
  # Only what this run opened: processes running this build's own executable (never the installed app).
  for pid in $(pgrep -f "$APP/Contents/MacOS/ReviewGate" || true); do kill "$pid" 2>/dev/null || true; done
  if [ -n "$OPEN_PID" ]; then kill "$OPEN_PID" 2>/dev/null || true; fi
  [ -d "$APP" ] && "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Quiet (SHOTS_LAYOUT runs unless SHOTS_VISIBLE=1): nothing of the tour shows or takes the focus while the user works.
QUIET=""
[ -z "${SHOTS_LAYOUT:-}" ] || [ "${SHOTS_VISIBLE:-}" = 1 ] || QUIET=1
OPEN_FLAGS="-n -W"
[ -z "$QUIET" ] || OPEN_FLAGS="-g -n -W"
if [ -n "$QUIET" ]; then
  say "running the tour quietly (nothing shows; SHOTS_VISIBLE=1 to watch it; log: $RAW/tour.log)"
else
  say "running the tour (a ReviewGate window opens for a few minutes; log: $RAW/tour.log)"
fi
# `open` (a launch the app is activated for) hands its own environment to the app: a minimal one, so nothing of this
# shell (a Claude Code session's CLAUDE_* variables included) reaches the app, its engine or the claude it starts.
env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" SHELL="${SHELL:-/bin/zsh}" TMPDIR="${TMPDIR:-/tmp}" \
  PATH="$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  open $OPEN_FLAGS -a "$APP" --stdout "$SHOTS_DIR/app.log" --stderr "$SHOTS_DIR/app.log" \
  --env "LANG=$UI_LOCALE.UTF-8" --env "REVIEWGATE_PROJECT=$DEMO_DIR" --env "REVIEWGATE_DATA_DIR=$DATA" \
  --env "REVIEWGATE_SCREENSHOT_QUIET=$QUIET" \
  --env "REVIEWGATE_SCREENSHOT_TOUR=$RAW" --env "REVIEWGATE_SCREENSHOT_PROMPT=${SHOTS_PROMPT:-}" \
  --env "REVIEWGATE_SCREENSHOT_MODEL=${SHOTS_MODEL:-}" --env "REVIEWGATE_SCREENSHOT_LAYOUT=${SHOTS_LAYOUT:-}" \
  --args -AppleLanguages "($UI_LANG)" -AppleLocale "$UI_LOCALE" -ApplePersistenceIgnoreState YES &
OPEN_PID=$!
waited=0
while kill -0 "$OPEN_PID" 2>/dev/null; do
  [ "$waited" -lt "$TIMEOUT" ] || die "the tour took longer than ${TIMEOUT}s (log: $RAW/tour.log)"
  if [ -f "$RAW/activate" ]; then   # the tour is about to shoot: bring the running instance forward (no new one)
    rm -f "$RAW/activate"
    [ -n "$QUIET" ] || env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin open -a "$APP" || true
  fi
  sleep 1; waited=$((waited + 1))
done
OPEN_PID=""
[ ! -f "$RAW/tour-failed.txt" ] || die "the tour failed: $(cat "$RAW/tour-failed.txt") (log: $RAW/tour.log)"
ls "$RAW"/*.png >/dev/null 2>&1 || die "the tour wrote no images (log: $RAW/tour.log)"

if [ -n "${SHOTS_LAYOUT:-}" ]; then   # the layout / scroll check: its PNGs stay in the scratch folder, never in docs/images
  say "layout shots: $(ls "$RAW"/*.png | tr '\n' ' ')"
  # What the check marks fails the run (§49.2, §45.1): a part taller than the window, a card cut, the send button out of
  # the window, a typed message lost, a transcript that shows none of its rows.
  marked="$(grep -E 'TALLER|— CUT|OUT OF THE WINDOW|LOST|BLANK|SILENT|— JUMP|— OVERLAP' "$RAW/tour.log" || true)"
  if [ -n "$marked" ]; then
    printf '%s\n' "$marked" >&2
    die "the layout check failed: $(printf '%s\n' "$marked" | wc -l | tr -d ' ') marked (TALLER / CUT / OUT OF THE WINDOW / LOST / BLANK / SILENT / JUMP / OVERLAP; log: $RAW/tour.log)"
  fi
  say "layout check: nothing marked (TALLER / CUT / OUT OF THE WINDOW / LOST / BLANK / SILENT / JUMP / OVERLAP)"
  exit 0
fi

# --- docs/images ------------------------------------------------------------------------------------------------------

mkdir -p "$OUT"
for raw in "$RAW"/*.png; do
  name="$(basename "$raw")"
  if [ "$(sips -g pixelWidth "$raw" | awk '/pixelWidth/ {print $2}')" -gt "$WIDTH" ]; then
    sips --resampleWidth "$WIDTH" "$raw" --out "$OUT/$name" >/dev/null
  else
    cp "$raw" "$OUT/$name"   # a crop narrower than WIDTH keeps its pixels
  fi
  # sRGB for the web, and no display profile (it names this Mac's monitor) in the published file.
  sips --matchTo "/System/Library/ColorSync/Profiles/sRGB Profile.icc" "$OUT/$name" >/dev/null
  if command -v pngquant >/dev/null; then
    pngquant --force --skip-if-larger --quality 70-95 --output "$OUT/$name" "$OUT/$name" || true
  fi
  size=$(stat -f %z "$OUT/$name")
  say "$OUT/$name ($((size / 1024)) KB)"
  [ "$size" -lt 1048576 ] || echo "screenshots: warning: $name is over 1 MB" >&2
done
