#!/usr/bin/env node
// Engine-level E2E for wave 3's daily flow (docs/PROTOCOL.md §36.10–§36.14) against the real `claude` CLI.
//
//   node sidecar/test/driver-flow.mjs [/path/to/scratch/repo] [/path/to/sidecar.mjs]
//   RG_MODEL=haiku (default) — short Haiku turns and read-only forks.
//
// a. §36.10: a side question asked while turn 2 waits on a permission card forks at turn 1 and still knows turn 2's
//    request (a codeword only that request names) — thread.fork {fork_at, atTurn 1, runningTurn 2}.
// b. §36.13: prereview_start (files, low) on the off-by-one turn 2 planted reports ≥ 1 finding on calc.js; the main
//    chat's own "/code-review low" reports through ReportFindings without a permission card (source main).
// c. §36.11: commit_draft after accepting → a message in the template's format; nothing committed.
// d. §36.12: workbench_preview lists the untracked / ignored files to copy; workbench_create copies them and runs the
//    setup command (steps create → copy → setup → done, the setup's log and exit code).
// The repository is recreated on every run (branch feature/flow/4242, an untracked mvnw, an ignored local/secret.yml).
// Asserts no orphans at the end and removes the CLI's project folder of the scratch repository.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.argv[2] ?? "/tmp/rg-flow";
// The app-wide records (§36.8 cli-versions.json) go next to the scratch repository, never the user's ~/.reviewgate.
const RG_DATA = `${REPO}-rg-data`;
rmSync(RG_DATA, { recursive: true, force: true });
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || RG_DATA };
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 300_000;
const WT_ROOT = `${REPO}-worktrees`;
const BRANCH = "feature/flow/4242";

const t0 = Date.now();
const log = (msg) => process.stderr.write(`[flow +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const assert = (cond, msg) => {
  if (!cond) {
    log(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

// ---------------------------------------------------------------- repo prep (fresh every run)
rmSync(REPO, { recursive: true, force: true });
rmSync(WT_ROOT, { recursive: true, force: true });
mkdirSync(REPO, { recursive: true });
git("init", "-q", "-b", BRANCH);
git("config", "user.email", "driver@example.com");
git("config", "user.name", "driver-flow");
writeFileSync(join(REPO, "README.md"), "# flow scratch\n");
writeFileSync(join(REPO, ".gitignore"), "local/\n");
writeFileSync(join(REPO, "calc.js"), "// Sums the first n elements of an array.\nfunction sumFirst(arr, n) {\n  let total = 0;\n  for (let i = 0; i < n; i++) total += arr[i];\n  return total;\n}\nmodule.exports = { sumFirst };\n");
git("add", "-A");
git("commit", "-q", "-m", "#flow/4241: start");
writeFileSync(join(REPO, "mvnw"), "#!/bin/sh\necho mvnw\n");
chmodSync(join(REPO, "mvnw"), 0o755);
mkdirSync(join(REPO, "local"), { recursive: true });
writeFileSync(join(REPO, "local", "secret.yml"), "token: local-only\n");

// ---------------------------------------------------------------- sidecar plumbing (as driver-why)
let state = null;
let nextId = 1;
const waiters = [];
const replies = new Map();
const events = [];
/** Permission requests the driver answers itself (`hold` keeps one open while the side question runs). */
let holdPermission = null;
const held = [];
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
      if (holdPermission && holdPermission(ev)) {
        log(`permission_request ${ev.toolName} ${JSON.stringify(ev.input).slice(0, 80)} → held`);
        held.push(ev);
      } else {
        log(`permission_request ${ev.toolName} ${ev.file ?? JSON.stringify(ev.input).slice(0, 80)} → allow`);
        send({ type: "permission_response", requestId: ev.requestId, allow: true });
      }
    } else if (ev.type === "tool_use") log(`tool_use ${ev.name}${ev.parentToolUseId ? ` (in ${ev.parentToolUseId.slice(-6)})` : ""}`);
    else if (ev.type === "side_tool_use") log(`side_tool_use ${ev.name}`);
    else if (ev.type === "prereview") log(`prereview ${ev.prereviewId} ${ev.source} ${ev.status} findings=${ev.findings.length}${ev.error ? ` error=${ev.error}` : ""}`);
    else if (ev.type === "workbench_progress") log(`workbench_progress ${ev.step}${ev.exitCode !== undefined ? ` exit=${ev.exitCode}` : ""}`);
    else if (ev.type === "error") log(`error(${ev.scope}): ${ev.message}`);
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) if (state && w.pred(state)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(state);
  }
});
const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");
function request(cmd, timeoutMs = STEP_TIMEOUT_MS) {
  const id = `w${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type} within ${timeoutMs}ms`)), timeoutMs);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      if (ev.type === "result" && !ev.ok) reject(new Error(`${cmd.type} failed: ${ev.error}`));
      else resolve(ev);
    });
    send({ ...cmd, id });
  });
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
    const i = events.findIndex(pred);
    if (i >= 0) return events[i];
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const turnDone = (before) => (x) => x.hud.turnCount > before && x.gate.phase !== "running" && x.gate.phase !== "collecting";

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
/** The CLI's per-project folder of a cwd (`~/.claude/projects/<path with every non-alphanumeric char as '-'>`). */
const cliProjectDir = (cwd) => join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

const observed = {};
let seenProcesses = [];

async function main() {
  const ready = await request({
    type: "hello",
    protocolVersion: 2,
    client: "test",
    env: { PATH: process.env.PATH ?? "", SHELL: "/bin/sh" },
    settings: {
      ignorePatterns: [".omc/", ".claude/settings.local.json"],
      autoAllowTools: [],
      loadUserSettings: false,
      systemPromptAppend: "You are running inside ReviewGate. Do exactly what is asked and stop. Never run git commands.",
      claudePath: CLAUDE,
      model: MODEL,
      sideModel: MODEL,
      commitTemplate: "#flow/{issue}: ",
      worktreeRoot: WT_ROOT,
      workbenchSetup: { copy: ["mvnw", "local/"], setupCommand: "echo setup-start && test -x mvnw && test -f local/secret.yml && echo setup-ok", location: "managed" },
    },
  });
  assert(ready.type === "ready", "hello → ready");
  await request({ type: "open_project", path: REPO });
  let s = await waitState((x) => x.session.open && !x.session.starting && x.project !== null, "session open");

  // ============ turn 1: the fork point
  {
    const before = s.hud.turnCount;
    await request({ type: "send", text: "Reply with exactly the word READY and nothing else." });
    s = await waitState(turnDone(before), "turn 1");
  }

  // ============ a. §36.10 a side question during turn 2 knows turn 2's request
  {
    const before = s.hud.turnCount;
    holdPermission = (ev) => ev.toolName === "Bash" && /flow-marker/.test(JSON.stringify(ev.input));
    await request({
      type: "send",
      text: "The codeword for this task is PELICAN. Do exactly these steps: 1) Run the Bash command: touch flow-marker.txt " +
        "2) In calc.js change the loop condition `i < n` to `i <= n` (this is intended). 3) Reply with one short line.",
    });
    const perm = await waitEvent((e) => e.type === "permission_request" && held.includes(e), "the held Bash card");
    assert(state.gate.phase === "running", `turn 2 runs while its card waits: ${state.gate.phase}`);
    const thread = (await request({ type: "side_ask", question: "What is the codeword in the user's request that is in progress right now? Reply with only the codeword, or UNKNOWN." })).thread;
    const end = await waitEvent((e) => e.type === "side_turn_end" && e.threadId === thread.id, "the side answer");
    const list = await request({ type: "side_list" });
    const t = list.threads.find((x) => x.id === thread.id);
    const answer = t.messages.filter((m) => m.role === "assistant").map((m) => m.text).join("\n");
    observed.side = { fork: t.fork, answer: answer.slice(0, 200), stopReason: end.stopReason, costUSD: end.costUSD };
    assert(t.fork?.mode === "fork_at" && t.fork.atTurn === 1 && t.fork.runningTurn === 2, `thread.fork: ${JSON.stringify(t.fork)}`);
    assert(/PELICAN/i.test(answer), `the side question knows the running turn's codeword: ${JSON.stringify(answer)}`);
    log(`a side question OK: ${JSON.stringify(observed.side)}`);
    holdPermission = null;
    send({ type: "permission_response", requestId: perm.requestId, allow: true });
    s = await waitState(turnDone(before), "turn 2");
    const calc = s.changedFiles.find((f) => f.path === "calc.js");
    assert(calc && calc.state === "pending", `calc.js under review: ${JSON.stringify(s.changedFiles.map((f) => [f.path, f.state]))}`);
    assert(/i <= n/.test(readFileSync(join(REPO, "calc.js"), "utf8")), "turn 2 planted the off-by-one");
  }

  // ============ b. §36.13 AI pre-review in a read-only fork, then the main chat's own /code-review
  {
    const started = await request({ type: "prereview_start", scope: "files", paths: ["calc.js"], effort: "low" });
    assert(started.type === "prereview" && started.status === "running" && started.source === "round" && started.endTree === state.gate.reviewEndTree, `prereview reply: ${JSON.stringify(started)}`);
    const done = await waitEvent((e) => e.type === "prereview" && e.prereviewId === started.prereviewId && e.status !== "running", "the pre-review's end");
    observed.prereview = { status: done.status, error: done.error ?? null, findings: done.findings, costUSD: done.costUSD ?? null };
    assert(done.status === "done", `pre-review done: ${JSON.stringify(observed.prereview)}`);
    assert(done.findings.length >= 1 && done.findings.some((f) => f.file === "calc.js"), `≥ 1 finding on calc.js: ${JSON.stringify(done.findings)}`);
    assert(done.findings.every((f) => /^f\d+$/.test(f.id) && typeof f.summary === "string" && f.summary.length > 0), `finding shape: ${JSON.stringify(done.findings)}`);
    s = await waitState((x) => (x.gate.prereviews ?? []).some((r) => r.prereviewId === started.prereviewId && r.status === "done"), "the run in state.gate.prereviews");
    assert(readFileSync(join(REPO, "calc.js"), "utf8").includes("i <= n"), "the fork changed nothing");
    log(`b pre-review OK: ${JSON.stringify(observed.prereview)}`);

    const before = s.hud.turnCount;
    const mark = events.length;
    await request({ type: "send", text: "/code-review low" });
    s = await waitState(turnDone(before), "the main /code-review turn");
    await new Promise((r) => setTimeout(r, 300));
    const cards = events.slice(mark).filter((e) => e.type === "permission_request" && e.toolName === "ReportFindings");
    const calls = events.slice(mark).filter((e) => e.type === "tool_use" && e.name === "ReportFindings");
    const mainRuns = events.slice(mark).filter((e) => e.type === "prereview" && e.source === "main");
    observed.mainReport = { calls: calls.length, runs: mainRuns.map((r) => ({ id: r.prereviewId, findings: r.findings.length, endTree: r.endTree })), cards: cards.length, tools: events.slice(mark).filter((e) => e.type === "tool_use").map((e) => e.name) };
    assert(cards.length === 0, "ReportFindings never asks in the main chat");
    assert(calls.length >= 1, `the main chat's /code-review reported through ReportFindings: ${JSON.stringify(observed.mainReport)}`);
    assert(mainRuns.length === calls.length && mainRuns.every((r, i) => r.prereviewId === calls[i].id && r.status === "done"), `a run per call: ${JSON.stringify(observed.mainReport)}`);
    log(`b main ReportFindings OK: ${JSON.stringify(observed.mainReport)}`);
  }

  // ============ c. §36.11 commit_draft
  {
    await request({ type: "accept_all" });
    s = await waitState((x) => x.commit.acceptedPaths.includes("calc.js"), "accepted");
    const head = git("rev-parse", "HEAD");
    const draft = await request({ type: "commit_draft" });
    observed.commitDraft = draft.message;
    assert(draft.type === "commit_draft" && draft.message.startsWith("#flow/4242: "), `commit message in the template's format: ${JSON.stringify(draft.message)}`);
    assert(!draft.message.includes("```"), "no code fence");
    assert(git("rev-parse", "HEAD") === head && git("diff", "--cached", "--name-only") === "", "nothing committed or staged");
    log(`c commit_draft OK: ${JSON.stringify(draft.message)}`);
  }

  // ============ d. §36.12 workbench preview / create with copy and setup
  {
    const preview = await request({ type: "workbench_preview", branch: "feature/flow/4243" });
    observed.preview = preview;
    assert(preview.path.startsWith(WT_ROOT) || preview.path.includes("feature-flow-4243"), `preview path: ${preview.path}`);
    assert(JSON.stringify(preview.copy.map((c) => c.path)) === JSON.stringify(["local/secret.yml", "mvnw"]), `files to copy: ${JSON.stringify(preview.copy)}`);
    assert(preview.totalBytes === statSync(join(REPO, "mvnw")).size + statSync(join(REPO, "local", "secret.yml")).size, `totalBytes: ${preview.totalBytes}`);
    const mark = events.length;
    await request({ type: "workbench_create", branch: "feature/flow/4243", from: BRANCH });
    const steps = events.slice(mark).filter((e) => e.type === "workbench_progress" && e.path === preview.path);
    observed.workbench = steps.map((e) => [e.step, e.exitCode ?? null, (e.logTail ?? "").trim().slice(-80)]);
    const order = steps.map((e) => e.step).filter((x, i, all) => all.indexOf(x) === i);
    assert(JSON.stringify(order) === JSON.stringify(["create", "copy", "setup", "done"]), `steps: ${JSON.stringify(order)}`);
    const copied = steps.find((e) => e.step === "copy" && e.logTail);
    assert(copied && /Copied 2 of 2/.test(copied.logTail), `copy log: ${copied?.logTail}`);
    const setupEnd = steps.find((e) => e.step === "setup" && e.exitCode !== undefined);
    assert(setupEnd && setupEnd.exitCode === 0 && /setup-ok/.test(setupEnd.logTail), `setup log: ${JSON.stringify(setupEnd)}`);
    assert(steps.at(-1).step === "done" && steps.at(-1).exitCode === 0, "done repeats the setup's exit code");
    assert(existsSync(join(preview.path, "mvnw")) && readFileSync(join(preview.path, "local", "secret.yml"), "utf8") === "token: local-only\n", "files copied");
    assert((statSync(join(preview.path, "mvnw")).mode & 0o111) !== 0, "mvnw stays executable");
    log(`d workbench OK: ${JSON.stringify(observed.workbench)}`);
    await request({ type: "workbench_remove", path: preview.path, force: true });
  }

  seenProcesses = ourProcesses();
  await request({ type: "shutdown" });
  const { code, signal } = await exited;
  assert(code === 0 && signal === null, `sidecar exit ${code} ${signal}`);
  await new Promise((r) => setTimeout(r, 1500));
  const orphans = seenProcesses.filter((p) => alive(p.pid));
  assert(orphans.length === 0, `orphaned processes:\n${orphans.map((p) => p.line).join("\n")}`);
  log("PASS");
  console.log(JSON.stringify({ ok: true, totalMs: Date.now() - t0, model: MODEL, claudeVersion: state.toolchain.claudeVersion, sessionCostUSD: Number(state.hud.sessionCostUSD.toFixed(4)), sideCostUSD: Number((state.hud.sideCostUSD ?? 0).toFixed(4)), observed }, null, 2));
}

function cleanup() {
  // The CLI's session files of the scratch repository (the main chat and the side question's fork).
  for (const d of [cliProjectDir(REPO)]) rmSync(d, { recursive: true, force: true });
}

main()
  .then(cleanup)
  .catch(async (e) => {
    log(`FAIL: ${e.message}`);
    console.log(JSON.stringify({ ok: false, error: e.message, observed }, null, 2));
    process.exitCode = 1;
    try {
      send({ type: "shutdown" });
    } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    cleanup();
    process.exit(1);
  });
