#!/usr/bin/env node
// Engine-level E2E for review round 2's "why" half (docs/PROTOCOL.md §34.6–§34.9) against the real `claude` CLI.
//
//   node sidecar/test/driver-why.mjs [/path/to/scratch/repo] [/path/to/sidecar.mjs]
//   RG_MODEL=haiku (default) — two short Haiku turns.
//
// a. subagent turn (forwardSubagentText): the subagent's own tool calls carry a rationale with rationaleSource — its
//    text reaches the engine —, the file it wrote has changedFiles[].why with agent = the Agent call (its report or its
//    own text), turn_summary.files[].whyDetail is the same object.
// b. live turn: after a Write and while a slow Bash call runs, live_changes lists the file (running, baseTree, liveTree,
//    hud.turnFiles), live_diff returns it (scope live); the turn's `node --test` gives turn_summary.lastTest pass /
//    afterLastEdit; between turns live_changes is running: false and live_diff no_live_turn.
// The repository is created when missing (git init, main, one passing node:test file). Asserts no orphans at the end.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.argv[2] ?? "/tmp/rg-why";
// The app-wide records (§36.8 cli-versions.json) go next to the scratch repository, never the user's ~/.reviewgate.
const RG_DATA = `${REPO}-rg-data`;
rmSync(RG_DATA, { recursive: true, force: true });
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || RG_DATA };
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 240_000;

const t0 = Date.now();
const log = (msg) => process.stderr.write(`[why +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const assert = (cond, msg) => {
  if (!cond) {
    log(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

// ---------------------------------------------------------------- repo prep
if (!existsSync(join(REPO, ".git"))) {
  mkdirSync(REPO, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "driver@example.com");
  git("config", "user.name", "driver-why");
}
rmSync(join(REPO, ".git", "reviewgate.lock"), { force: true });
for (const f of ["reviewgate-review.json", "reviewgate-session.json", "reviewgate-transcript.ndjson"]) rmSync(join(REPO, ".git", f), { force: true });
rmSync(join(REPO, ".git", "reviewgate"), { recursive: true, force: true });
for (const r of git("for-each-ref", "--format=%(refname)", "refs/reviewgate/").split("\n").filter(Boolean)) git("update-ref", "-d", r);
for (const f of ["hello.txt", "a.txt"]) rmSync(join(REPO, f), { force: true });
writeFileSync(join(REPO, "README.md"), "# why scratch\n");
writeFileSync(join(REPO, "ok.test.mjs"), 'import test from "node:test";\nimport assert from "node:assert";\ntest("ok", () => assert.equal(1, 1));\n');
if (git("status", "--porcelain")) {
  git("add", "-A");
  git("commit", "-q", "-m", "driver-why: clean start");
}

// ---------------------------------------------------------------- sidecar plumbing (as driver-m21)
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
    if (ev.type === "permission_request") {
      log(`permission_request ${ev.toolName} ${ev.file ?? JSON.stringify(ev.input).slice(0, 80)} → allow`);
      send({ type: "permission_response", requestId: ev.requestId, allow: true });
    } else if (ev.type === "tool_use") {
      log(`tool_use ${ev.name}${ev.parentToolUseId ? ` (in ${ev.parentToolUseId.slice(-6)})` : ""}${ev.rationale ? ` ${ev.rationaleSource}/${ev.rationaleAge} "${ev.rationale.slice(0, 60)}"` : ""}`);
    } else if (ev.type === "error") log(`error(${ev.scope}): ${ev.message}`);
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) if (state && w.pred(state)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(state);
  }
});
const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");
function request(cmd) {
  const id = `w${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type} within ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      if (ev.type === "result" && !ev.ok) reject(new Error(`${cmd.type} failed: ${ev.error}`));
      else resolve(ev);
    });
    send({ ...cmd, id });
  });
}
async function refused(cmd) {
  try {
    await request(cmd);
  } catch (e) {
    return String(e.message);
  }
  assert(false, `${cmd.type} must be refused`);
}
function waitState(pred, what) {
  if (state && pred(state)) return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; phase=${state?.gate.phase}`)), STEP_TIMEOUT_MS);
    waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
  });
}
async function waitEvent(pred, what) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const ev = events.find(pred);
    if (ev) return ev;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const since = (mark, type) => events.slice(mark).filter((e) => e.type === type);
const turnDone = (before) => (x) => x.hud.turnCount > before && x.gate.phase !== "running" && x.gate.phase !== "collecting";

/** The sidecar and every process under it (the `claude` CLI and its children), by pid — only ours, never another run's. */
function ourProcesses() {
  const out = execFileSync("ps", ["-eo", "pid,ppid,command"], { encoding: "utf8" });
  const kids = new Map();
  for (const l of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const list = kids.get(Number(m[2])) ?? [];
    list.push({ pid: Number(m[1]), line: l });
    kids.set(Number(m[2]), list);
  }
  const found = [];
  const walk = (pid) => {
    for (const k of kids.get(pid) ?? []) {
      found.push(k);
      walk(k.pid);
    }
  };
  walk(child.pid);
  return [{ pid: child.pid, line: `sidecar ${child.pid}` }, ...found];
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const observed = {};

async function main() {
  const ready = await request({
    type: "hello",
    protocolVersion: 2,
    client: "test",
    env: { PATH: process.env.PATH ?? "" },
    settings: {
      ignorePatterns: [".omc/", ".claude/settings.local.json"],
      autoAllowTools: [],
      loadUserSettings: false,
      systemPromptAppend: "You are running inside ReviewGate. Do exactly what is asked and stop. Never run git commands.",
      claudePath: CLAUDE,
      model: MODEL,
    },
  });
  assert(ready.type === "ready", "hello → ready");
  await request({ type: "open_project", path: REPO });
  let s = await waitState((x) => x.session.open && !x.session.starting && x.project !== null, "session open");
  const idle = await request({ type: "live_changes" });
  assert(idle.running === false && idle.files.length === 0, `no turn: live_changes running false: ${JSON.stringify(idle)}`);

  // ============ a. subagent: its text reaches the engine (forwardSubagentText)
  {
    const before = s.hud.turnCount;
    const mark = events.length;
    await request({
      type: "send",
      text:
        "Use the Agent tool exactly once (subagent_type general-purpose) with this task: " +
        "'First say in one short sentence why you are creating the file. Then use the Write tool to create hello.txt containing exactly hi. " +
        "Then reply with one line that names hello.txt and what it contains.' After the subagent finished, reply with one short line. Do nothing else.",
    });
    s = await waitState(turnDone(before), "subagent turn");
    await new Promise((r) => setTimeout(r, 300));
    const uses = since(mark, "tool_use");
    const agent = uses.find((u) => u.name === "Agent" || u.name === "Task");
    assert(agent, `an Agent call: ${uses.map((u) => u.name).join(",")}`);
    const inner = uses.filter((u) => u.parentToolUseId === agent.id);
    const withWhy = inner.filter((u) => typeof u.rationale === "string" && u.rationale.length > 0);
    // §34.8: before forwardSubagentText only the subagent's tool_use / tool_result blocks arrived — none had a rationale.
    assert(withWhy.length > 0, `the subagent's own calls carry its text as rationale: ${JSON.stringify(inner.map((u) => [u.name, u.rationale ?? null]))}`);
    assert(withWhy.every((u) => u.rationaleSource === "same_message" || u.rationaleSource === "earlier") && withWhy.every((u) => Number.isInteger(u.rationaleAge)), `rationaleSource / rationaleAge: ${JSON.stringify(withWhy.map((u) => [u.rationaleSource, u.rationaleAge]))}`);
    const textLeak = since(mark, "text_delta").map((e) => e.text).join("");
    // Only complete subagent text blocks are used: nothing of the subagent is streamed into the main transcript.
    assert(!withWhy.some((u) => textLeak.includes(u.rationale.slice(0, 40))), `subagent text never streams into the transcript: ${JSON.stringify(textLeak.slice(0, 200))}`);
    const hello = s.changedFiles.find((f) => f.path === "hello.txt");
    assert(hello, `hello.txt in the review: ${JSON.stringify(s.changedFiles.map((f) => f.path))}`);
    assert(hello.why && hello.why.source !== "none" && hello.why.agent?.toolUseId === agent.id, `hello.txt's why is the subagent's: ${JSON.stringify(hello.why)}`);
    assert(hello.why.agent.subagentType === "general-purpose", `agent.subagentType: ${JSON.stringify(hello.why.agent)}`);
    const sum = since(mark, "turn_summary").at(-1);
    const sf = sum?.files.find((f) => f.path === "hello.txt");
    assert(sf && JSON.stringify(sf.whyDetail) === JSON.stringify(hello.why) && sf.why === hello.why.text, `turn_summary whyDetail = changedFiles why: ${JSON.stringify(sf)}`);
    observed.subagent = {
      inner: inner.map((u) => [u.name, u.rationaleSource ?? null, u.rationaleAge ?? null, (u.rationale ?? "").slice(0, 80)]),
      agentRationale: agent.rationale?.slice(0, 80) ?? null,
      why: hello.why,
      mainTextChars: textLeak.length,
    };
    log(`a subagent OK: ${JSON.stringify(observed.subagent)}`);
    await request({ type: "accept_all" });
    s = await waitState((x) => x.gate.canSend, "gate open");
  }

  // ============ b. live changes while a Bash call runs; lastTest
  {
    const before = s.hud.turnCount;
    const mark = events.length;
    await request({
      type: "send",
      text: "Make exactly these tool calls in order: 1) Write the file a.txt containing exactly: a 2) Bash: sleep 8 && node --test 3) Reply with one line. Do nothing else.",
    });
    const write = await waitEvent((e, i) => i >= mark && e.type === "tool_use" && e.name === "Write" && String(e.input.file_path).endsWith("a.txt"), "the Write of a.txt");
    await waitEvent((e, i) => i >= mark && e.type === "tool_result" && e.toolUseId === write.id, "its result");
    const t = Date.now();
    const lc = await request({ type: "live_changes" });
    const ms = Date.now() - t;
    assert(lc.running === true && typeof lc.baseTree === "string" && typeof lc.liveTree === "string", `live_changes while running: ${JSON.stringify(lc)}`);
    const a = lc.files.find((f) => f.path === "a.txt");
    assert(a && a.status === "A" && a.inReview === false, `a.txt listed live: ${JSON.stringify(lc.files)}`);
    assert((state.hud.turnFiles ?? 0) >= 1, `hud.turnFiles: ${state.hud.turnFiles}`);
    const again = await request({ type: "live_changes" });
    assert(again.liveTree === lc.liveTree, "a second call within 2 s reuses the live tree");
    const d = await request({ type: "live_diff", path: "a.txt" });
    assert(d.type === "file_diff" && d.scope === "live" && d.endTree === lc.liveTree && d.baseTree === lc.baseTree, `live_diff: ${JSON.stringify({ ...d, diff: undefined })}`);
    assert(d.diff.hunks.flatMap((h) => h.lines).some((l) => l.kind === "add" && l.text === "a"), `live_diff shows the new line: ${JSON.stringify(d.diff.hunks)}`);
    s = await waitState(turnDone(before), "live turn");
    await new Promise((r) => setTimeout(r, 300));
    const sum = since(mark, "turn_summary").at(-1);
    assert(sum && sum.lastTest && sum.lastTest.verdict === "pass" && /node --test/.test(sum.lastTest.command) && sum.lastTest.afterLastEdit === true && sum.lastTest.runs === 1, `lastTest: ${JSON.stringify(sum?.lastTest)}`);
    assert(s.hud.turnFiles === 0, `hud.turnFiles back to 0: ${s.hud.turnFiles}`);
    const after = await request({ type: "live_changes" });
    assert(after.running === false && after.files.length === 0, `between turns: ${JSON.stringify(after)}`);
    const refusal = await refused({ type: "live_diff", path: "a.txt" });
    assert(/no_live_turn/.test(refusal), `live_diff between turns: ${refusal}`);
    observed.live = { liveChangesMs: ms, files: lc.files, lastTest: sum.lastTest, aWhy: s.changedFiles.find((f) => f.path === "a.txt")?.why ?? null };
    log(`b live OK: ${JSON.stringify(observed.live)}`);
    await request({ type: "accept_all" });
  }

  const ours = ourProcesses();
  await request({ type: "shutdown" });
  const { code, signal } = await exited;
  assert(code === 0 && signal === null, `sidecar exit ${code} ${signal}`);
  await new Promise((r) => setTimeout(r, 1500));
  const orphans = ours.filter((p) => alive(p.pid));
  assert(orphans.length === 0, `orphaned processes:\n${orphans.map((p) => p.line).join("\n")}`);
  log("PASS");
  console.log(JSON.stringify({ ok: true, totalMs: Date.now() - t0, model: MODEL, claudeVersion: state.toolchain.claudeVersion, sessionCostUSD: Number(state.hud.sessionCostUSD.toFixed(4)), observed }, null, 2));
}

main().catch(async (e) => {
  log(`FAIL: ${e.message}`);
  console.log(JSON.stringify({ ok: false, error: e.message, observed }, null, 2));
  process.exitCode = 1;
  try {
    send({ type: "shutdown" });
  } catch {}
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
  process.exit(1);
});
