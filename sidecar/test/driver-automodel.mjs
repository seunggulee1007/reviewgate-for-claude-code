#!/usr/bin/env node
// MARK: wave5 w5-model — engine-level E2E for docs/PROTOCOL.md §43.4 (auto model) against the real `claude` CLI.
//
//   node sidecar/test/driver-automodel.mjs [/path/to/scratch/repo] [/path/to/sidecar.mjs]   (default $TMPDIR/rg-automodel; RE-CREATED from scratch)
//   RG_SIDECAR=/path/to/sidecar.mjs (when no second argument; default sidecar/dist/sidecar.mjs)
//   The app-wide records (cli-versions.json) go to <repo>-rg-data, never the user's ~/.reviewgate, and the scratch
//   conversation under ~/.claude/projects is removed at the end.
//
//   settings.modelMode "auto", policy "cost", the session started on haiku, user settings off (no plugins / hooks):
//   1. a short message → auto keeps haiku-family; the CLI is told a code word.
//   2. the same chat with send.model "sonnet" (this message only) → the answer comes from Sonnet (turn_end.usage.models,
//      state.session.model) and still knows the code word: the conversation continues across the switch.
//   3. a short question without a pick → auto goes back to haiku; the answer still knows the word.
// Asserts no `claude` / sidecar orphans at the end and prints what was observed as JSON.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.argv[2] ?? join(tmpdir(), "rg-automodel");
// The app-wide records (§36.8 cli-versions.json) go next to the scratch repository, never the user's ~/.reviewgate.
const RG_DATA = `${REPO}-rg-data`;
rmSync(RG_DATA, { recursive: true, force: true });
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || RG_DATA };
const SIDECAR = process.argv[3] ?? process.env.RG_SIDECAR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const STEP_TIMEOUT_MS = 180_000;

const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
const t0 = Date.now();
const log = (msg) => process.stderr.write(`[automodel +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const assert = (cond, msg) => {
  if (!cond) {
    log(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
};

rmSync(REPO, { recursive: true, force: true });
mkdirSync(REPO, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", REPO]);
git("config", "user.email", "automodel@example.com");
git("config", "user.name", "automodel");
writeFileSync(join(REPO, "README.md"), "# automodel scratch\n");
git("add", "-A");
git("commit", "-q", "-m", "automodel: init");

let state = null;
let nextId = 1;
const waiters = [];
const replies = new Map();
const events = [];
const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
createInterface({ input: child.stderr }).on("line", (l) => {
  if (!/:debug\]/.test(l)) process.stderr.write(`  [sidecar] ${l}\n`);
});
const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
createInterface({ input: child.stdout }).on("line", (line) => {
  const ev = JSON.parse(line);
  if (ev.type === "state") state = ev.state;
  else {
    events.push(ev);
    if (ev.type === "permission_request") child.stdin.write(JSON.stringify({ type: "permission_response", requestId: ev.requestId, allow: false, message: "Not needed: answer in words." }) + "\n");
    else if (ev.type === "error") log(`error(${ev.scope}${ev.code ? ` ${ev.code}` : ""}): ${ev.message.slice(0, 200)}`);
    else if (ev.type === "user_message") log(`user_message autoModel=${JSON.stringify(ev.autoModel ?? null)}`);
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) if (state && w.pred(state)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(state);
  }
});

function request(cmd) {
  const id = `a${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type} (${id})`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      if (ev.type === "result" && !ev.ok) reject(new Error(`${cmd.type} failed: ${ev.error}`));
      else resolve(ev);
    });
    child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
  });
}

function waitState(pred, what) {
  if (state && pred(state)) return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; phase=${state?.gate.phase} lastError=${state?.lastError}`)), STEP_TIMEOUT_MS);
    waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
  });
}

const since = (mark, type) => events.slice(mark).filter((e) => e.type === type);
async function turn(cmd, what) {
  const before = state.hud.turnCount;
  const mark = events.length;
  await request({ type: "send", ...cmd });
  const s = await waitState((x) => x.hud.turnCount > before && x.gate.phase !== "running" && x.gate.phase !== "collecting", what);
  const end = since(mark, "turn_end").at(-1);
  return {
    answer: since(mark, "text_delta").map((e) => e.text).join("").trim(),
    autoModel: since(mark, "user_message").at(-1)?.autoModel ?? null,
    usageModels: (end?.usage?.models ?? []).map((m) => m.model),
    sessionModel: s.session.model,
  };
}

const observed = {};
try {
  await request({
    type: "hello",
    protocolVersion: 2,
    client: "test",
    settings: {
      budget: { maxFiles: 3, maxLines: 50 },
      ignorePatterns: [".omc/"],
      autoAllowTools: [],
      loadUserSettings: false,
      systemPromptAppend: "You are running inside ReviewGate. Answer in one short English sentence. Never use tools.",
      claudePath: CLAUDE,
      ghHost: "github.com",
      model: "haiku",
      modelMode: "auto",
      modelAutoPolicy: "cost",
    },
  });
  await request({ type: "open_project", path: REPO });
  await waitState((s) => s.session.open && !s.session.starting && s.session.ready === true, "session ready");
  observed.availableModels = state.session.availableModels.map((m) => `${m.value}${m.resolvedModel ? ` → ${m.resolvedModel}` : ""}`);
  log(`models: ${observed.availableModels.join(", ")}`);

  observed.turn1 = await turn({ text: "Code word: PINEAPPLE. Just say OK." }, "turn 1");
  log(`turn 1: ${JSON.stringify(observed.turn1)}`);
  assert(observed.turn1.autoModel?.family === "haiku", "turn 1 runs on haiku (cost: a short message)");

  observed.turn2 = await turn({ text: "Which code word did I give you? Reply with the word only.", model: "sonnet" }, "turn 2");
  log(`turn 2: ${JSON.stringify(observed.turn2)}`);
  assert(observed.turn2.autoModel?.by === "user" && observed.turn2.autoModel?.switched === true, "turn 2: this message's pick switched the model");
  assert(observed.turn2.usageModels.some((m) => /sonnet/i.test(m)), "turn 2's answer came from Sonnet");
  assert(/PINEAPPLE/i.test(observed.turn2.answer), "turn 2 still knows the code word after the switch");

  observed.turn3 = await turn({ text: "What was the code word again?" }, "turn 3");
  log(`turn 3: ${JSON.stringify(observed.turn3)}`);
  assert(observed.turn3.autoModel?.family === "haiku" && observed.turn3.autoModel?.switched === true, "turn 3: auto switched back to haiku");
  assert(observed.turn3.usageModels.some((m) => /haiku/i.test(m)) && !observed.turn3.usageModels.some((m) => /sonnet/i.test(m)), "turn 3's answer came from Haiku");
  assert(/PINEAPPLE/i.test(observed.turn3.answer), "turn 3 still knows the code word");
  observed.autoModelCounts = state.hud.autoModelCounts ?? null;
} finally {
  await request({ type: "shutdown" }).catch(() => undefined);
  const { code, signal } = await exited;
  observed.exit = { code, signal };
  const left = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(REPO) && !l.includes("driver-automodel"));
  observed.leftover = left;
  // The scratch conversation the CLI wrote under <config>/projects goes too.
  const projectsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const key = realpathSync(REPO).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
  for (const name of existsSync(projectsDir) ? readdirSync(projectsDir) : []) {
    if (name === key || name.startsWith(`${key}-`)) rmSync(join(projectsDir, name), { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify(observed, null, 2) + "\n");
}
