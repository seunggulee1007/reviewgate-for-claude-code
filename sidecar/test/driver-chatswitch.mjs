#!/usr/bin/env node
// Real-CLI check of docs/PROTOCOL.md §9.1 (r2-chats-cards M33): how long a chat switch keeps the user waiting.
//
//   node sidecar/test/driver-chatswitch.mjs <scratch-dir> [sidecar.mjs]
//   RG_MODEL=haiku (default) — two one-line turns in all.
//
// A scratch repository is made in <scratch-dir> (never under /tmp: the CLI is told not to work there), then:
//   1. open_project → chat A's CLI starts; one turn ("Reply with just: A") so A is a resumable conversation.
//   2. session_new → chat B; one turn ("Reply with just: B").
//   3. session_open A, then session_open B — each timed from the command to `state.session` open and not starting
//      (what the composer waits for). Before §9.1 every switch starts (resumes) a CLI; with it, switching back to the
//      chat just left takes its idle process again.
// The scratch repository, the engine's data folder (REVIEWGATE_DATA_DIR, in the scratch folder) and the CLI's
// ~/.claude/projects/<its key> folder are removed at the end; prints JSON timings.
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
  process.stderr.write("usage: driver-chatswitch.mjs <scratch-dir outside /tmp> [sidecar.mjs]\n");
  process.exit(2);
}

const t0 = Date.now();
const log = (msg) => process.stderr.write(`[chatswitch +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const REPO = join(SCRATCH, `chatswitch-${process.pid}`);
// The engine's app-wide records (§36.8 cli-versions.json …) go to the scratch folder, never the user's ~/.reviewgate.
const DATA = join(SCRATCH, `chatswitch-data-${process.pid}`);
const cliProjectDir = (cwd) => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

mkdirSync(REPO, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "driver@example.com");
git("config", "user.name", "driver");
writeFileSync(join(REPO, "README.md"), "# chatswitch scratch\n");
git("add", "-A");
git("commit", "-qm", "init");

let state = null;
let nextId = 1;
const waiters = [];
const replies = new Map();
const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, REVIEWGATE_DATA_DIR: DATA } });
createInterface({ input: child.stderr }).on("line", (l) => {
  if (/parked|taken back|resuming session/.test(l)) log(l.replace(/^\[sidecar:\w+\] /, "sidecar: "));
});
const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
createInterface({ input: child.stdout }).on("line", (line) => {
  const ev = JSON.parse(line);
  if (ev.type === "state") state = ev.state;
  else if (ev.type === "permission_request") child.stdin.write(JSON.stringify({ type: "permission_response", requestId: ev.requestId, allow: true }) + "\n");
  else if (ev.type === "error") log(`error(${ev.scope}${ev.fatal ? ", fatal" : ""}): ${ev.message}`);
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
    child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
  });
}
function until(pred, what) {
  if (state && pred(state)) return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), STEP_TIMEOUT_MS);
    waiters.push({ pred, resolve: (s) => (clearTimeout(timer), resolve(s)) });
  });
}
const ready = (id) => (s) => s.sessions?.currentId === id && s.session.open && !s.session.starting;
/** The CLI answered initialize (§36.5 `capabilities.state`): a message sent now is read at once. */
const initialized = (id) => (s) => ready(id)(s) && s.session.capabilities?.state === "ready";
async function turn(text) {
  await request({ type: "send", text });
  await until((s) => s.gate.phase === "running", "turn start");
  await until((s) => !["running", "collecting"].includes(s.gate.phase) && !s.session.starting, "turn end");
}
/** [open ms, initialized ms] from the command. */
async function timedSwitch(cmd, id) {
  const start = Date.now();
  await request(cmd);
  await until(ready(id), `chat ${id} live`);
  const open = Date.now() - start;
  await until(initialized(id), `chat ${id} initialized`);
  return { openMs: open, initializedMs: Date.now() - start };
}

const result = { model: MODEL, sidecar: SIDECAR };
try {
  await request({
    type: "hello",
    protocolVersion: 2,
    client: "test",
    env: { PATH: process.env.PATH ?? "", SHELL: "/bin/sh" },
    // Without the user's settings, plugins and hooks: nothing of theirs runs or is written (the audit's 2.2–2.9 s case).
    settings: { loadUserSettings: false, claudePath: CLAUDE, model: MODEL, systemPromptAppend: "Do exactly what is asked and stop. Never run commands." },
  });
  const openStart = Date.now();
  await request({ type: "open_project", path: REPO });
  const a = (await until((s) => s.sessions?.currentId && s.session.open && !s.session.starting, "first session")).sessions.currentId;
  await until(initialized(a), "chat A initialized");
  result.firstStartInitializedMs = Date.now() - openStart;
  await turn("Reply with just: A");
  const newStart = Date.now();
  await request({ type: "session_new" });
  const b = (await until((s) => s.sessions?.currentId && s.sessions.currentId !== a && s.session.open && !s.session.starting, "chat B")).sessions.currentId;
  await until(initialized(b), "chat B initialized");
  result.newChatInitializedMs = Date.now() - newStart;
  await turn("Reply with just: B");
  result.backToA = await timedSwitch({ type: "session_open", sessionId: a }, a);
  result.backToB = await timedSwitch({ type: "session_open", sessionId: b }, b);
  log(`timings: ${JSON.stringify(result)}`);
} catch (e) {
  result.error = String(e);
  process.exitCode = 1;
} finally {
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
}
