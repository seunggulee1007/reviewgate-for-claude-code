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
# - the engine's data dir is a fresh folder under SHOTS_DIR (never ~/.reviewgate);
# - the managed workbench folder is the fixture /Users/Shared/acme-workbenches (the "Run as Task" / new workbench sheet shows
#   it; the tour creates no workbench), and every PNG is read (scripts/png-home-check.swift, Vision text recognition on this Mac): one showing
#   the home folder's path fails the run (HOME PATH);
# - the session loads no user settings (no ~/.claude skills, plugins, hooks, MCP servers or CLAUDE.md); the app starts
#   from launchd (`open`), not with this shell's environment, in English (SHOTS_LANG=ko: in Korean, layout check only);
# - a layout on the fake claude (SHOTS_LAYOUT=terminal, composerbar, settings, demo) never reads ~/.claude at all: the app and its engine get
#   CLAUDE_CONFIG_DIR=SHOTS_DIR/claude-config, a fresh folder whose settings.json holds only a harmless status line
#   (`printf TOUR`) for the terminal chat's status line tee (§57.13) to wrap — the fake runs it only when it is exactly that;
# - the layouts on the real claude (the README run and every other SHOTS_LAYOUT, composer among them) keep the user's
#   config dir — the CLI needs its login — and never run the user's status line: the build's showStatusLine is off (no
#   status line under the chat, §44.2) and the tour opens chats only (newChatKind chat), never a terminal chat whose TUI
#   or tee (§57.13) would run it;
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
#                  row's frame, or a text taller than its frame, is an OVERLAP (`overlap` lines, overlap-<n>.png); first it
#                  scrolls down from far up (the "Latest" pill showing) to the end and back up, checked after every step:
#                  the end moving away from the reader by more than 40 pt is ENDLESS, rows shown moving under the reader
#                  JUMP (`scrollfeel` lines); last, ⌘F to a row far before the rows shown and "↓ Latest" back (LOST when
#                  either does not end on its row).
#                  composer: the message box against the terminal's input — 한글 composed as an input method sends it
#                  (the marked syllable kept through SwiftUI's updates while idle, reviewing and working, then committed;
#                  `composer ime` lines), ⌘V of an image from a private pasteboard
#                  (a screenshot, Preview, a browser, a Finder copy; never the user's clipboard), "/" opening the slash
#                  palette with every source and filtering it, the queue bar with what waits in Claude's turn and its
#                  edit / take-back tools, ↑ in an empty box bringing everything waiting back, Esc giving the queue back in
#                  front of the typed text, /btw asked of the live session and its answer over the box, /mcp's list over
#                  two servers added to the live session for it (a tiny node stdio server the tour writes, and one that
#                  cannot start): reconnect, off and on, the typed `/mcp disable|enable <name>`, the filter and the empty
#                  state (`composer` lines; also part of SHOTS_LAYOUT=1); then a regular chat's review at 1000 × 637 and
#                  900 × 512, its diff header's Accept inside the ~300 pt diff pane (`diff header` lines; CUT past its
#                  edge; diff-header-*.png).
#                  terminal: the terminal chat and the bottom shell panel (§57) on a fake `claude` this script writes to
#                  SHOTS_DIR/fakebin (never the real one; `claudePath` in the build's own defaults) under a plain /bin/sh
#                  (REVIEWGATE_TERMINAL_SHELL: no login or interactive shell, no dotfiles): the banner, a prompt typed into
#                  the PTY becoming a review, a reject named in the next prompt's context, the shell tab's folder, the
#                  input method in `cat` (한글, a commit on focus loss, Hanja, the #825 mask), copy without the pasteboard,
#                  ⌃`, /exit and Restart resuming the same conversation, the layout at the laptop's 1000 × 637 (the terminal
#                  80 columns or more without a review, the review panel opening as a drawer over it — no SIGWINCH, the
#                  keyboard kept — for each review and closing, side by side at 1440 × 900 with the split moved and never
#                  under 80 columns, the window resized), the first chat and ⌘T's being terminal chats by default (§57.7) with the PTY's winsize following each time (the fake's `size` /
#                  `winsize` lines, `stty size` in the shell), Settings' Restart now restarting the PTY (a new
#                  pid, the same conversation, its hooks still reviewed), Stage 2 (§57.10–57.15: the status line's cost in
#                  the strip, a WebFetch wait cleared by its PostToolUse, a permission card answered from the app, Request
#                  changes in the next prompt's context, a switch away and back keeping the same PTY with its unsent text
#                  while a write from the background is denied), and no claude starting again once the window's
#                  terminals were stopped (`terminal:` lines; terminal-chat-*.png, shell-panel-*.png).
#                  composerbar: the rows around the classic chat's message box at 1000 × 637, dark, on the fake claude (its
#                  chat session starts — initialize answered — and never runs a turn): a fresh chat, the box focused, text
#                  typed, Claude at work after two turns, a review pending, the mode offer, decided permission cards and a
#                  question in the transcript, folded and opened (`composerbar` lines: the transcript's height, TALLER when the
#                  window's content is laid out taller than the window; composerbar-*.png); then 0.5.29's §67 / §68: the
#                  "Directories N" chip and its list (idle, and while Claude works), the box in `!` shell mode, the running and
#                  finished `!` rows with the caption over the box, the branch's ↑↓ and the line under it after a fetch, a
#                  pull and a refused pull (with a crop of the header), a fetch running, the branch menu's items as
#                  `composerbar branch-menu` lines (a menu is not captured), and the commit sheet's "Other changes" on the
#                  demo project's own edits — with a review and alone (composerbar-commit-*.png); then §70: the ⌃R search
#                  bar over the box (a match, an older one, no match, no history, a match taken into the box;
#                  composerbar-history-*.png), the thinking chip off, for a model that always thinks and after ⌥T
#                  (composerbar-thinking-*.png), and /export's sheet with the lines after a save and a refusal
#                  (composerbar-export-*.png); then §71, dark and light: /usage's sheet (a subscription's windows, none
#                  yet, one reached; composerbar-usage-*-<appearance>.png), the to-do checklist over the box (idle, while
#                  Claude works, hidden, none yet; composerbar-todos-*-<appearance>.png) and /tasks' sheet with each task's
#                  output tail and with nothing running (composerbar-tasks-*-<appearance>.png).
#                  settings: the Settings window (§55.11) on the same fake claude — each pane at its first size and its
#                  smallest, the search, a jump to a row and the restart banner, dark and light (`settings` lines;
#                  settings-*.png; TALLER when the window with its title bar is taller than 637 pt); then §69's window with
#                  no project at 1000 × 637 and 900 × 460, the New Project sheet (empty, typed, a long Korean prompt, an engine before §69) and
#                  the task's project picker over three fixture repositories in DEMO_DIR-recent (`noproject` lines;
#                  noproject-*.png).
#                  demo: the README's demo GIF frames (demo-<nn>-<step>.png; scripts/make-gif.swift puts them together) on the
#                  fake claude in its demo script (a `fake-demo` file next to it): a prompt typed into the terminal chat at
#                  1360 × 850, dark, Claude editing four files, the review beside the terminal, one file accepted, one
#                  rejected, Accept N & Continue, and Claude carrying on with the next file. With SHOTS_LANG=ko the prompt is
#                  Korean and so are Claude's lines.
#                  A shot marked TALLER, CUT, OUT OF THE WINDOW, LOST, BLANK, SILENT, JUMP, OVERLAP or ENDLESS in tour.log fails the run (exit 1)
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
case "${SHOTS_LAYOUT:-}" in terminal|composerbar|settings|demo) ;; *) command -v claude >/dev/null || die "the Claude Code CLI is missing";; esac
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
CLAUDE_BIN=claude
if [ "${SHOTS_LAYOUT:-}" = terminal ] || [ "${SHOTS_LAYOUT:-}" = composerbar ] || [ "${SHOTS_LAYOUT:-}" = settings ] \
   || [ "${SHOTS_LAYOUT:-}" = demo ]; then
  # §57 terminal tour (and the composer bar check, and §55.11's settings shots, whose window opens a terminal chat on it): a fake claude. --version passes the engine's preflight; in the terminal chat's PTY it prints its
  # session, and for each line typed posts the hooks a real turn would (UserPromptSubmit, a Write to notes.txt in its cwd,
  # Stop) to the URL in its --settings with the token from RG_HOOK_TOKEN. It prints its terminal's size (the PTY's winsize)
  # on each SIGWINCH (`winsize CxR`) and when a line is `size` (`size CxR COLUMNS=…`, no turn). It never reads or writes
  # ~/.claude. Run as the app's chat CLI (stream-json) it fails at once — but for composerbar, below.
  mkdir -p "$SHOTS_DIR/fakebin"
  rm -f "$SHOTS_DIR/fakebin/fake-chat" "$SHOTS_DIR/fakebin/fake-demo"   # a marker from an earlier layout
  CLAUDE_BIN="$SHOTS_DIR/fakebin/claude"
  cat > "$CLAUDE_BIN" <<'EOF'
#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const readline = require("node:readline");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("2.1.325 (Claude Code)"); process.exit(0); }
if (argv.some((a) => a.includes("stream-json"))) {
  // SHOTS_LAYOUT=composerbar (a `fake-chat` file next to the fake): the chat session starts — initialize answered, the
  // permission mode and the model switched — and never runs a turn; every other request is refused. Else it fails at once.
  if (!require("node:fs").existsSync(join(__dirname, "fake-chat"))) { console.error("fake-claude: only the terminal chat is faked"); process.exit(1); }
  const reply = (id, ok, response = {}) => process.stdout.write(JSON.stringify({ type: "control_response",
    response: ok ? { subtype: "success", request_id: id, response } : { subtype: "error", request_id: id, error: "fake-claude: not faked" } }) + "\n");
  readline.createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "control_request") return;
    const kind = msg.request?.subtype;
    if (kind === "initialize") reply(msg.request_id, true, { commands: [], agents: [], models: [], output_style: "default", available_output_styles: ["default"], account: {} });
    else reply(msg.request_id, ["set_permission_mode", "set_model", "interrupt"].includes(kind));
  });
  return;
}
// `--flag value` or `--flag=value` (the engine joins the session id to its flag).
const value = (flag) => { const i = argv.indexOf(flag); if (i >= 0) return argv[i + 1]; return argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1); };
const resume = argv.some((a) => a === "--resume" || a.startsWith("--resume="));
const session = value(resume ? "--resume" : "--session-id");
let url;
let settings = {};
try { settings = JSON.parse(value("--settings") ?? "{}"); url = settings.hooks.Stop[0].hooks[0].url; } catch { url = undefined; }
const token = process.env.RG_HOOK_TOKEN ?? "";
if (!session || !url) { console.error("fake-claude: no session or hook url"); process.exit(2); }
// SHOTS_LAYOUT=demo (a `fake-demo` file next to the fake): the README demo's script, below, instead of these lines.
const demo = require("node:fs").existsSync(join(__dirname, "fake-demo"));
if (!demo) console.log(`fake-claude session=${session} resume=${resume}`);
// §57.11: the MCP servers ReviewGate passed on (`--mcp-config <file>`; inline JSON too), by name.
try { const mcp = value("--mcp-config"); if (mcp && !demo) console.log(`mcp=${Object.keys(JSON.parse(mcp.trim().startsWith("{") ? mcp : require("node:fs").readFileSync(mcp, "utf8")).mcpServers ?? {}).join(",")}`); } catch { console.log("mcp=unreadable"); }
const post = async (body) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "X-ReviewGate-Token": token },
    body: JSON.stringify({ session_id: session, cwd: process.cwd(), ...body }) });
  return res.json().catch(() => ({}));
};
// §57.10–57.15 lines (no turn): `status` runs the settings' statusLine command (the tee) as the CLI does (/bin/sh -c, the
// status input on stdin) and prints what it printed (`status: … printed "TOUR"`) — the whole command only when its own
// part is the tour's fixture (`printf TOUR`, from the tour's own CLAUDE_CONFIG_DIR), else only the tee's post, so no
// status line of the user's can ever run here; `perm` asks a PermissionRequest (Bash `echo hi`) and prints the decision; `bgwrite` asks
// a PreToolUse Write and prints allow / deny and the reason; `wait` posts a permission Notification and `webfetch` a
// WebFetch PostToolUse (the wait clears).
const extra = {
  status: async () => {
    const command = settings.statusLine?.command;
    if (!command) return "status: no statusLine";
    const [tee, ...own] = command.split("\n");
    const fixture = own.length === 1 && own[0].endsWith("| /bin/sh -c 'printf TOUR'");
    const input = JSON.stringify({ session_id: session, cwd: process.cwd(), cost: { total_cost_usd: 0.0123 },
      model: { id: "claude-acme-test", display_name: "Acme" },
      context_window: { context_window_size: 200000, current_usage: { input_tokens: 40000, cache_creation_input_tokens: 0, cache_read_input_tokens: 10000 } } });
    const out = require("node:child_process").spawnSync("/bin/sh", ["-c", fixture ? command : tee], { input, encoding: "utf8", timeout: 10000 });
    if (fixture) return `status: ran the tee (exit ${out.status}), printed ${JSON.stringify((out.stdout ?? "").trim())}`;
    return `status: ran the tee's post only (exit ${out.status})${own.length ? ", a status line that is not the tour's not run" : ""}`;
  },
  perm: async () => {
    const answer = await post({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo hi" } });
    const decision = answer.hookSpecificOutput?.decision;
    return `perm: ${decision?.behavior ?? "none"}${decision?.message ? ` ${decision.message}` : ""}`;
  },
  bgwrite: async () => {
    const file = join(process.cwd(), "background.txt");
    const answer = await post({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file, content: "x" },
      tool_use_id: `toolu_bg_${randomUUID()}` });
    const out = answer.hookSpecificOutput ?? {};
    return `bgwrite: ${out.permissionDecision ?? "allow"} ${out.permissionDecisionReason ?? ""}`;
  },
  wait: async () => {
    await post({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use WebFetch" });
    return "wait: posted";
  },
  webfetch: async () => {
    await post({ hook_event_name: "PostToolUse", tool_name: "WebFetch", tool_input: { url: "https://example.com" },
      tool_response: { code: 200 }, tool_use_id: `toolu_web_${randomUUID()}` });
    return "webfetch: posted";
  },
};
// The README demo's script (SHOTS_LAYOUT=demo): the first prompt edits four files of the demo project — the discount codes
// asked for and a version bump nobody asked for —, every later one reads the review's summary in its context and documents
// the codes in README.md. Each edit is a real write and a PostToolUse, as a turn's would be. A prompt with Korean in it
// makes the whole script Korean (SHOTS_LANG=ko).
if (demo) {
  const fs = require("node:fs");
  const bold = (s) => `\x1b[1m${s}\x1b[22m`, dim = (s) => `\x1b[2m${s}\x1b[22m`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const say = (text) => process.stdout.write(`\r\n\x1b[37m⏺\x1b[39m ${text.replace(/\n/g, "\r\n  ")}\r\n`);
  const prompt = () => process.stdout.write("\r\n\x1b[2m>\x1b[22m ");
  let ko = false, turns = 0, calls = 0;
  const t = (en, kr) => (ko ? kr : en);
  // edit(promptId, path, [[from, to], …] or a string appended, the line under the call)
  const edit = async (promptId, rel, change, summary) => {
    const file = join(process.cwd(), rel);
    let text = fs.readFileSync(file, "utf8");
    if (typeof change === "string") text += change;
    else for (const [from, to] of change) {
      if (!text.includes(from)) throw new Error(`${rel}: no ${JSON.stringify(from.slice(0, 40))}`);
      text = text.replace(from, to);
    }
    fs.writeFileSync(file, text);
    process.stdout.write(`\r\n\x1b[32m⏺\x1b[39m ${bold("Update")}(${rel})\r\n  ${dim("⎿")}  ${summary}\r\n`);
    calls += 1;
    await post({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file },
      tool_response: { filePath: file }, tool_use_id: `toolu_demo_${calls}`, prompt_id: promptId });
    await sleep(900);
  };
  const first = async (promptId) => {
    say(t("I'll keep the codes in src/pricing.ts, apply them in the cart and add tests.",
          "코드는 src/pricing.ts에 두고, 장바구니에 적용하고, 테스트를 추가할게요."));
    await sleep(900);
    await edit(promptId, "src/pricing.ts", [["export const TAX_RATE = 0.08;\n", `export const TAX_RATE = 0.08;

/** Discount codes: a share of the subtotal off, or free shipping. */
export const DISCOUNT_CODES = {
  SAVE10: { percentOff: 10 },
  FREESHIP: { freeShipping: true },
} as const;

export type DiscountCode = keyof typeof DISCOUNT_CODES;

export function isDiscountCode(code: string): code is DiscountCode {
  return Object.hasOwn(DISCOUNT_CODES, code);
}
`]], t("Added 12 lines", "12줄 추가"));
    await edit(promptId, "src/cart.ts", [
      ['import { shippingFor, taxFor } from "./pricing.ts";', 'import { DISCOUNT_CODES, isDiscountCode, shippingFor, taxFor, type DiscountCode } from "./pricing.ts";'],
      ["  private readonly items = new Map<string, LineItem>();\n", "  private readonly items = new Map<string, LineItem>();\n  private code?: DiscountCode;\n"],
      ["  remove(sku: string): void {", `  applyCode(code: string): void {
    if (!isDiscountCode(code)) throw new RangeError(\`unknown discount code: \${code}\`);
    this.code = code;
  }

  remove(sku: string): void {`],
      [`    const shipping = shippingFor(subtotal);
    const tax = taxFor(subtotal);
    return { subtotal, shipping, tax, total: subtotal + shipping + tax };`,
       `    const discount = this.code ? DISCOUNT_CODES[this.code] : undefined;
    const off = discount && "percentOff" in discount ? Math.round((subtotal * discount.percentOff) / 100) : 0;
    const shipping = discount && "freeShipping" in discount ? 0 : shippingFor(subtotal);
    const tax = taxFor(subtotal - off);
    return { subtotal, shipping, tax, total: subtotal - off + shipping + tax };`],
    ], t("Added 10 lines, removed 3 lines", "10줄 추가, 3줄 삭제"));
    await edit(promptId, "test/cart.test.ts", `
test("SAVE10 takes 10% off the subtotal", () => {
  const cart = new Cart();
  cart.add(tee);
  cart.applyCode("SAVE10");
  assert.equal(cart.totals().total, 4800 - 480 + 599 + 346);
});

test("FREESHIP removes shipping", () => {
  const cart = new Cart();
  cart.add(mug);
  cart.applyCode("FREESHIP");
  assert.equal(cart.totals().shipping, 0);
});

test("rejects unknown codes", () => {
  assert.throws(() => new Cart().applyCode("HALFOFF"), /unknown discount code/);
});
`, t("Added 18 lines", "18줄 추가"));
    await edit(promptId, "package.json", [['"version": "0.3.0"', '"version": "0.4.0"']], t("Updated 1 line", "1줄 수정"));
    say(t("SAVE10 and FREESHIP are in, with tests. I also bumped the version to 0.4.0.",
          "SAVE10과 FREESHIP을 넣고 테스트도 추가했어요. 버전도 0.4.0으로 올렸어요."));
  };
  const next = async (promptId, context) => {
    const rejected = /Rejected[^\]]*package\.json/.test(context);
    say(rejected
      ? t("Got it: keeping the codes and tests, not the version bump.\nNext, the README.",
          "알겠어요. 코드와 테스트는 두고 버전은 0.3.0 그대로 둘게요.\n이어서 README를 쓸게요.")
      : t("Next, the README.", "이어서 README를 쓸게요."));
    await sleep(900);
    await edit(promptId, "README.md", t(`
## Discount codes

| Code | Effect |
| --- | --- |
| \`SAVE10\` | 10% off the subtotal |
| \`FREESHIP\` | No shipping charge |

\`cart.applyCode(code)\` throws on an unknown code.
`, `
## 할인 코드

| 코드 | 효과 |
| --- | --- |
| \`SAVE10\` | 상품 금액 10% 할인 |
| \`FREESHIP\` | 배송비 없음 |

없는 코드를 넣으면 \`cart.applyCode(code)\`가 오류를 던져요.
`), t("Added 9 lines", "9줄 추가"));
    say(t("The README lists both codes now.", "README에 두 코드를 적었어요."));
  };
  // As a TUI does: raw input echoed by the script itself, and bracketed paste on (the app's Accept N & Continue pastes
  // "Continue." only into a program that turned it on); the paste markers are dropped.
  process.stdout.write(`\x1b[?2004h\x1b[38;5;173m✻\x1b[39m ${bold("Claude Code")} ${dim("· scripted demo · " + process.cwd())}\r\n`);
  prompt();
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let typed = "", busy = false;
  process.stdin.on("data", (chunk) => {
    for (const ch of chunk.toString("utf8").replace(/\x1b\[20[01]~/g, "")) {
      if (ch === "\x03" || ch === "\x04") process.exit(0);
      if (busy) continue;
      if (ch === "\r" || ch === "\n") { const line = typed; typed = ""; process.stdout.write("\r\n"); turn(line); }
      else if (ch === "\x7f") { if (typed) { typed = typed.slice(0, -1); process.stdout.write("\b \b"); } }
      else if (ch >= " ") { typed += ch; process.stdout.write(ch); }
    }
  });
  const turn = async (line) => {
    if (line.trim() === "/exit") process.exit(0);
    if (!line.trim()) { prompt(); return; }
    busy = true;
    if (turns === 0) ko = /[가-힣]/.test(line);
    const promptId = randomUUID();
    const answer = await post({ hook_event_name: "UserPromptSubmit", prompt: line, prompt_id: promptId });
    const context = (answer.hookSpecificOutput?.additionalContext ?? "").replace(/\s+/g, " ");
    try {
      if (turns === 0) await first(promptId); else await next(promptId, context);
    } catch (e) {
      say(`demo: ${e.message}`);
    }
    turns += 1;
    await post({ hook_event_name: "Stop", prompt_id: promptId, stop_hook_active: false });
    prompt();
    busy = false;
  };
  return;
}
let n = 0;
const winsize = () => `${process.stdout.columns}x${process.stdout.rows}`;
process.stdout.on("resize", () => console.log(`winsize ${winsize()}`));
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  rl.pause();
  if (line.trim() === "/exit") process.exit(0);
  if (line.trim() === "size") { console.log(`size ${winsize()} COLUMNS=${process.env.COLUMNS ?? "-"}`); rl.resume(); return; }
  if (extra[line.trim()]) { console.log(await extra[line.trim()]().catch((e) => `${line.trim()}: failed ${e}`)); rl.resume(); return; }
  const promptId = randomUUID();
  const answer = await post({ hook_event_name: "UserPromptSubmit", prompt: line, prompt_id: promptId });
  if (answer.decision === "block") { console.log(`blocked: ${answer.reason}`); rl.resume(); return; }
  const context = (answer.hookSpecificOutput?.additionalContext ?? "").replace(/\s+/g, " ");
  console.log(context ? `context: ${context.slice(0, 400)}` : "context: none");
  const file = join(process.cwd(), "notes.txt");
  n += 1;
  appendFileSync(file, `note ${n}: ${line}\n`);
  const toolUseId = `toolu_fake_${n}`;
  await post({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file, content: line },
    tool_response: { filePath: file }, tool_use_id: toolUseId, prompt_id: promptId });
  await post({ hook_event_name: "Stop", prompt_id: promptId, stop_hook_active: false });
  console.log("done");
  rl.resume();
});
EOF
  chmod +x "$CLAUDE_BIN"
  [ "${SHOTS_LAYOUT:-}" != composerbar ] || touch "$SHOTS_DIR/fakebin/fake-chat"   # its chat session starts (no turn)
  [ "${SHOTS_LAYOUT:-}" != demo ] || touch "$SHOTS_DIR/fakebin/fake-demo"   # the README demo's script
fi
# A layout on the fake claude: the app and its engine get a Claude Code config dir of their own (CLAUDE_CONFIG_DIR), so
# nothing reads the user's ~/.claude — no user settings, hooks, status line, skills, plugins, plans, MCP servers or
# conversations. Its settings.json has a harmless status line (`printf TOUR`) for §57.13's tee to wrap; the tour checks
# that its output passes through the tee.
TOUR_CLAUDE_CONFIG=""
if [ "$CLAUDE_BIN" != claude ]; then
  TOUR_CLAUDE_CONFIG="$SHOTS_DIR/claude-config"
  rm -rf "$TOUR_CLAUDE_CONFIG"
  mkdir -p "$TOUR_CLAUDE_CONFIG"
  printf '%s\n' '{"statusLine":{"type":"command","command":"printf TOUR"}}' > "$TOUR_CLAUDE_CONFIG/settings.json"
fi
CLI_VERSION="$("$CLAUDE_BIN" --version | awk '{print $1}')"
ENGINE_VERSION="$(sed -n 's/.*ENGINE_VERSION = "\(.*\)".*/\1/p' "$ROOT/engine/src/version.ts")"
node "$ROOT/scripts/verified-cli.mjs" record "$DATA" "$CLI_VERSION" "$ENGINE_VERSION" tour   # no "unverified CLI" banner

# §69 (SHOTS_LAYOUT=settings): the window with no project lists recent projects and "Start from a task" picks one by its git
# remote — three repositories in a folder of their own next to the demo project (only ever deleted when it carries the
# marker), one with the task's repository (acme/widgets) as its remote, not the most recent; New Project previews its
# folders in the same place (never a folder under the home folder).
RECENT_DIR="$DEMO_DIR-recent"
if [ "${SHOTS_LAYOUT:-}" = settings ]; then
  if [ -e "$RECENT_DIR" ]; then
    [ -f "$RECENT_DIR/$MARKER" ] || die "$RECENT_DIR exists and is not this script's (no $MARKER) — refusing to delete it"
    rm -rf "$RECENT_DIR"
  fi
  mkdir -p "$RECENT_DIR"
  touch "$RECENT_DIR/$MARKER"
  for name in billing widgets docs-site; do
    mkdir -p "$RECENT_DIR/$name"
    git -C "$RECENT_DIR/$name" -c init.defaultBranch=main init -q
    git -C "$RECENT_DIR/$name" remote add origin "https://github.com/acme/$name.git"
  done
fi

defaults delete "$BUNDLE_ID" >/dev/null 2>&1 || true
w() { defaults write "$BUNDLE_ID" "$@"; }
w loadUserSettings -bool false               # settingSources ["project"]: nothing from ~/.claude
w showStatusLine -bool false
w checkForUpdatesAutomatically -bool false
w notificationsEnabled -bool false           # never asks macOS for the notification permission
w notificationsOffNoticeDismissed -bool true
w confirmCloseWhileWorking -bool false       # the tour's quit never waits on an alert
w reopenLastProjects -bool false
w worktreeRoot -string /Users/Shared/acme-workbenches   # shown in the sheets: never a path under $HOME (SHOTS_DIR may be)
[ "$CLAUDE_BIN" = claude ] || w claudePath -string "$CLAUDE_BIN"   # §57 terminal tour: the fake, never the real one
if [ "${SHOTS_LAYOUT:-}" = settings ]; then   # §69: most recent first; the demo project goes in front when it opens
  w recentProjects -array "$RECENT_DIR/billing" "$RECENT_DIR/widgets" "$RECENT_DIR/docs-site"
  w newProjectParent -string "$RECENT_DIR"
fi
w defaultModeOffered -data "$(printf '["%s"]' "$DEMO_DIR" | xxd -p | tr -d '\n')"

# --- the build --------------------------------------------------------------------------------------------------------

say "building (Debug, $BUNDLE_ID) → $DERIVED"
"$ROOT/scripts/build-sidecar.sh"
(cd "$ROOT" && xcodegen generate --quiet)
xcodebuild -project "$ROOT/ReviewGate.xcodeproj" -scheme ReviewGate -configuration Debug -derivedDataPath "$DERIVED" -skipPackagePluginValidation \
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
# Signed with the Apple Development certificate when there is one: macOS then knows every build as the same app and
# asks once for a folder the claude it starts reads (a Desktop folder in the user's Claude Code settings). An ad hoc
# signature is a new app to macOS each build, and it asked again after every build.
codesign --force --sign "Apple Development" "$APP" 2>/dev/null \
  || codesign --force --sign - "$APP" 2>/dev/null || die "cannot re-sign $APP"
codesign -d -r- "$APP" 2>&1 | grep -q 'cdhash H"' && say "signed ad hoc: macOS may ask again for folders after this build"

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
set --
[ -z "$TOUR_CLAUDE_CONFIG" ] || set -- --env "CLAUDE_CONFIG_DIR=$TOUR_CLAUDE_CONFIG"
env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" SHELL="${SHELL:-/bin/zsh}" TMPDIR="${TMPDIR:-/tmp}" \
  PATH="$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  open $OPEN_FLAGS -a "$APP" --stdout "$SHOTS_DIR/app.log" --stderr "$SHOTS_DIR/app.log" \
  --env "LANG=$UI_LOCALE.UTF-8" --env "REVIEWGATE_PROJECT=$DEMO_DIR" --env "REVIEWGATE_DATA_DIR=$DATA" \
  --env "REVIEWGATE_SCREENSHOT_QUIET=$QUIET" \
  --env "REVIEWGATE_SCREENSHOT_TOUR=$RAW" --env "REVIEWGATE_SCREENSHOT_PROMPT=${SHOTS_PROMPT:-}" \
  --env "REVIEWGATE_SCREENSHOT_MODEL=${SHOTS_MODEL:-}" --env "REVIEWGATE_SCREENSHOT_LAYOUT=${SHOTS_LAYOUT:-}" \
  --env "REVIEWGATE_TERMINAL_SHELL=/bin/sh" ${1+"$@"} \
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
# No PNG may show the real home folder's path (a sheet's folder, a data dir under SHOTS_DIR, …).
xcrun swift "$ROOT/scripts/png-home-check.swift" "$RAW"/*.png || die "a PNG shows the home folder's path (HOME PATH above; $RAW)"

if [ -n "${SHOTS_LAYOUT:-}" ]; then   # the layout / scroll check: its PNGs stay in the scratch folder, never in docs/images
  say "layout shots: $(ls "$RAW"/*.png | tr '\n' ' ')"
  # What the check marks fails the run (§49.2, §45.1): a part taller than the window, a card cut, the send button out of
  # the window, a typed message lost, a transcript that shows none of its rows.
  marked="$(grep -E 'TALLER|— CUT|OUT OF THE WINDOW|LOST|BLANK|SILENT|— JUMP|— OVERLAP|— ENDLESS' "$RAW/tour.log" || true)"
  if [ -n "$marked" ]; then
    printf '%s\n' "$marked" >&2
    die "the layout check failed: $(printf '%s\n' "$marked" | wc -l | tr -d ' ') marked (TALLER / CUT / OUT OF THE WINDOW / LOST / BLANK / SILENT / JUMP / OVERLAP / ENDLESS; log: $RAW/tour.log)"
  fi
  say "layout check: nothing marked (TALLER / CUT / OUT OF THE WINDOW / LOST / BLANK / SILENT / JUMP / OVERLAP / ENDLESS)"
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
