#!/usr/bin/env node
// Real-CLI check of docs/PROTOCOL.md §33.10 (r2-chats-cards M25): a deny stops like the terminal's "No".
//
//   node sidecar/test/driver-denystop.mjs <scratch-dir> [sidecar.mjs]
//   RG_MODEL=haiku (default) — three short turns in all.
//
// A scratch repository is made in <scratch-dir> (never under /tmp: the CLI is told not to work there). Each turn asks for
// two shell commands in order — `touch <a>`, then `touch <b>`, one Bash call each — and the first call's card is answered:
//   1. 거부 — permission_response {allow: false} without a message: the engine tells Claude the CLI's own "No … STOP …
//      wait for the user". Expected: no tool call after it (no `touch <b>`, no workaround such as a Write), <b> not made,
//      the turn ends by itself (not interrupted).
//   2. 건너뛰고 계속 — {allow: false, skip: true}. Expected: Claude goes on without it — a card for `touch <b>` (allowed,
//      so <b> is made), <a> not made.
//   3. 거부하고 멈추기 — {allow: false, interrupt: true}. Expected: the turn ends `interrupted`, no tool call after it,
//      no error.
// The scratch repository, the engine's data folder (REVIEWGATE_DATA_DIR, in the scratch folder) and the CLI's
// ~/.claude/projects/<its key> folder are removed at the end; prints JSON (exit 1 when a check failed).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2];
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const MODEL = process.env.RG_MODEL ?? "haiku";
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const STEP_TIMEOUT_MS = 180_000;
if (!SCRATCH || /^\/(private\/)?tmp\b|^\/var\/folders\b/.test(SCRATCH)) {
  process.stderr.write("usage: driver-denystop.mjs <scratch-dir outside /tmp> [sidecar.mjs]\n");
  process.exit(2);
}

const t0 = Date.now();
const log = (msg) => process.stderr.write(`[denystop +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const REPO = join(SCRATCH, `denystop-${process.pid}`);
// The engine's app-wide records (§36.8 cli-versions.json …) go to the scratch folder, never the user's ~/.reviewgate.
const DATA = join(SCRATCH, `denystop-data-${process.pid}`);
const cliProjectDir = (cwd) => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
const failures = [];
const check = (cond, msg) => {
  if (cond) log(`ok: ${msg}`);
  else {
    failures.push(msg);
    log(`CHECK FAILED: ${msg}`);
  }
};

mkdirSync(REPO, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "driver@example.com");
git("config", "user.name", "driver");
writeFileSync(join(REPO, "README.md"), "# denystop scratch\n");
git("add", "-A");
git("commit", "-qm", "init");

let state = null;
let nextId = 1;
const waiters = [];
const replies = new Map();
/** The turn being watched: its cards, the tool calls after the first card was answered, its text and how it ended. */
let turn = null;
const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, REVIEWGATE_DATA_DIR: DATA } });
const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");
createInterface({ input: child.stdout }).on("line", (line) => {
  const ev = JSON.parse(line);
  if (ev.type === "state") state = ev.state;
  else if (ev.type === "permission_request") {
    const command = typeof ev.input?.command === "string" ? ev.input.command : JSON.stringify(ev.input);
    log(`card ${ev.toolName}: ${command}`);
    if (!turn) send({ type: "permission_response", requestId: ev.requestId, allow: false });
    else {
      turn.cards.push(`${ev.toolName}: ${command}`);
      if (turn.cards.length === 1) {
        turn.firstCall = ev.toolUseId ?? null;
        turn.answered = true;
      }
      send({ type: "permission_response", requestId: ev.requestId, ...turn.answer(turn.cards.length) });
    }
  } else if (ev.type === "tool_use" && turn?.answered && ev.id !== turn.firstCall) {
    turn.toolsAfter.push(`${ev.name}: ${typeof ev.input?.command === "string" ? ev.input.command : (ev.file ?? "")}`);
  } else if (ev.type === "text_delta" && turn) turn.text += ev.text;
  else if (ev.type === "turn_end" && turn) {
    turn.stopReason = ev.stopReason;
    turn.ended?.();
  } else if (ev.type === "error") {
    log(`error(${ev.scope}${ev.fatal ? ", fatal" : ""}): ${ev.message}`);
    turn?.errors.push(ev.message);
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) if (state && w.pred(state)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(state);
  }
});

function request(cmd) {
  const id = `c${nextId++}`;
  return new Promise((resolve, reject) => {
    replies.set(id, (ev) => (ev.type === "result" && ev.ok === false ? reject(new Error(`${cmd.type}: ${ev.error}`)) : resolve(ev)));
    send({ ...cmd, id });
  });
}
function until(pred, what) {
  if (state && pred(state)) return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), STEP_TIMEOUT_MS);
    waiters.push({ pred, resolve: (s) => (clearTimeout(timer), resolve(s)) });
  });
}

/** One turn asking for `touch a` then `touch b`; `answer(n)` answers its n-th card (1-based). */
async function denyTurn(label, a, b, answer) {
  turn = { label, cards: [], toolsAfter: [], text: "", stopReason: null, errors: [], answered: false, firstCall: null, answer };
  const ended = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label} turn end`)), STEP_TIMEOUT_MS);
    turn.ended = () => (clearTimeout(timer), resolve());
  });
  await request({
    type: "send",
    // Two separate steps of one task, the second not waiting on the first's outcome — "once it is done" read a skipped first
    // call as "not done" (haiku then left the second out), so the skip check measured the prompt, not the answer.
    text: `Use the Bash tool twice, one call each: run exactly \`touch ${a}\`, then run exactly \`touch ${b}\`. They are two separate steps; do not combine the two commands.`,
  });
  await ended;
  await until((s) => !["running", "collecting"].includes(s.gate.phase), `${label}: collected`);
  const t = turn;
  turn = null;
  const out = { cards: t.cards, toolsAfterTheAnswer: t.toolsAfter, stopReason: t.stopReason, errors: t.errors, made: { [a]: existsSync(join(REPO, a)), [b]: existsSync(join(REPO, b)) }, text: t.text.trim().slice(-300) };
  log(`${label}: ${JSON.stringify(out)}`);
  return out;
}

const result = { model: MODEL, sidecar: SIDECAR };
try {
  await request({
    type: "hello",
    protocolVersion: 2,
    client: "test",
    env: { PATH: process.env.PATH ?? "", SHELL: "/bin/sh" },
    // Without the user's settings, plugins and hooks: nothing of theirs runs or is written.
    settings: { loadUserSettings: false, claudePath: CLAUDE, model: MODEL, systemPromptAppend: "This is a test of tool permissions. Do exactly what is asked, nothing more." },
  });
  await request({ type: "open_project", path: REPO });
  await until((s) => s.sessions?.currentId && s.session.open && !s.session.starting && s.session.capabilities?.state === "ready", "session ready");
  result.permissionMode = state.session.permissionMode;

  // 1. 거부: the CLI's own "No" — Claude stops and waits.
  result.deny = await denyTurn("deny", "one.txt", "two.txt", (n) => ({ allow: false }));
  check(result.deny.cards.length === 1, "deny: no card after the deny");
  check(result.deny.toolsAfterTheAnswer.length === 0, "deny: no tool call after the deny (no next step, no workaround)");
  check(!result.deny.made["one.txt"] && !result.deny.made["two.txt"], "deny: neither file made");
  check(result.deny.stopReason !== null && result.deny.stopReason !== "interrupted", "deny: the turn ended by itself");

  // 2. 건너뛰고 계속: this call does not run, the task goes on.
  result.skip = await denyTurn("skip", "three.txt", "four.txt", (n) => (n === 1 ? { allow: false, skip: true } : { allow: true }));
  check(result.skip.cards.length === 2 && /four\.txt/.test(result.skip.cards[1] ?? ""), "skip: Claude went on to `touch four.txt` (a second card)");
  check(!result.skip.made["three.txt"] && result.skip.made["four.txt"], "skip: three.txt not made, four.txt made");

  // 3. 거부하고 멈추기: the turn stops too, as Stop does.
  result.stop = await denyTurn("stop", "five.txt", "six.txt", (n) => ({ allow: false, ...(n === 1 ? { interrupt: true } : {}) }));
  check(result.stop.stopReason === "interrupted", "stop: the turn ended interrupted");
  check(result.stop.cards.length === 1 && result.stop.toolsAfterTheAnswer.length === 0, "stop: no card and no tool call after it");
  check(result.stop.errors.length === 0, "stop: no error");
  check(!result.stop.made["five.txt"] && !result.stop.made["six.txt"], "stop: neither file made");
} catch (e) {
  result.error = String(e);
  failures.push(String(e));
} finally {
  result.failures = failures;
  child.stdin.end();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
  const leftover = execFileSync("sh", ["-c", `pgrep -f '${REPO}' || true`], { encoding: "utf8" }).trim();
  result.leftoverProcesses = leftover ? leftover.split("\n").length : 0;
  rmSync(cliProjectDir(REPO), { recursive: true, force: true });
  rmSync(cliProjectDir(execFileSync("realpath", [REPO], { encoding: "utf8" }).trim()), { recursive: true, force: true });
  rmSync(REPO, { recursive: true, force: true });
  rmSync(DATA, { recursive: true, force: true });
  result.cleaned = !existsSync(REPO) && !existsSync(DATA);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = failures.length > 0 ? 1 : 0;
}
