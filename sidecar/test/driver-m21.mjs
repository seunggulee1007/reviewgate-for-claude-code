#!/usr/bin/env node
// Engine-level E2E for the review-comprehension features (docs/PROTOCOL.md §12–17) against the real `claude` CLI.
//
//   node sidecar/test/driver-m21.mjs [/path/to/git/repo]      (default /tmp/rg-m21, must be a git repo on `main`)
//   RG_MODEL=haiku (default) — every prompt is a Haiku-sized task.
//
// sidecar #1 (a local SessionStart hook that never returns; §36.7: extensionsInitTimeoutMs is only the floor of the stall
//   limit, ≥ 45 s): open_project → after the stall, extensions_fallback + state.session.extensions.fallback,
//   settingSources ["project"] → a plain send still answers → shutdown.
// sidecar #2 (default settings):
//   e. state.session.extensions after the first turn: settingSources user+project+local (§36.6), plugins/skills/MCP listed, no fallback.
//   a. subagent turn: hud.agents node (task_* lifecycle → completed, usage, files), subagent tool_use events carry
//      parentToolUseId, rationale on a tool_use, ChangedFile.toolUseIds for both files, turn_summary with both files + a why.
//   b. Bash: `npm test` (failing script) → testOutcome "fail"; `seq 1 3000` → truncated + tool_output returns the full text.
//   f. H3: while a turn runs, accept / reject / reject_hunks are refused with session_running.
//   c. reject_hunks on a two-hunk README edit → only the selected hunk reverted on disk, file partial; accept;
//      review_history lists the round with verdict + rejectedHunks; history_diff returns a diff.
//   d. plan mode: plan → plan_response approve → follow-up turn → turn_summary.plan steps + unplannedFiles.
// sidecar #3 (disableUserHooks: true → flag disableAllHooks, budget maxFiles 1):
//   g. ReviewGate's own SDK hooks still run with every settings-file / plugin hook off: `git status` is auto-allowed
//      by the read-only Bash rule (no permission_request), a Write into .git/ is denied (git guard), the second new file
//      of the turn is denied by the budget hook (budget_event deny); userHooksDisabled in state.session.extensions.
// Asserts no `claude`/sidecar orphans at the end and prints the observed SDK behaviour as JSON.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.argv[2] ?? "/tmp/rg-m21";
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 240_000;

const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
const t0 = Date.now();
const log = (msg) => process.stderr.write(`[m21 +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const assert = (cond, msg) => {
  if (!cond) {
    log(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
};

// ---------------------------------------------------------------- repo prep
assert(existsSync(join(REPO, ".git")), `${REPO} is not a git repository`);
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") git("switch", "-q", "main");
rmSync(join(REPO, ".git", "reviewgate.lock"), { force: true });
for (const f of ["reviewgate-review.json", "reviewgate-session.json", "reviewgate-transcript.ndjson"]) rmSync(join(REPO, ".git", f), { force: true });
rmSync(join(REPO, ".git", "reviewgate"), { recursive: true, force: true });
for (const r of git("for-each-ref", "--format=%(refname)", "refs/reviewgate/").split("\n").filter(Boolean)) git("update-ref", "-d", r);
for (const f of ["hello.txt", "NOTES.md"]) rmSync(join(REPO, f), { force: true });
const README = ["# m21 scratch", "", "alpha", ...Array.from({ length: 24 }, (_, i) => `filler line ${i + 1}`), "omega", ""].join("\n");
writeFileSync(join(REPO, "README.md"), README);
writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "m21", private: true, scripts: { test: "node -e \"console.log('Tests: 1 failed, 0 passed'); process.exit(1)\"" } }, null, 2) + "\n");
const exclude = join(REPO, ".git", "info", "exclude");
execFileSync("sh", ["-c", `mkdir -p "$(dirname "${exclude}")"; grep -qx '.omc/' "${exclude}" 2>/dev/null || echo '.omc/' >> "${exclude}"`]);
if (git("status", "--porcelain")) {
  git("add", "-A");
  git("commit", "-q", "-m", "driver-m21: clean start");
}
assert(git("status", "--porcelain") === "", "worktree must be clean before the run");

// ---------------------------------------------------------------- sidecar plumbing
let state = null;
let nextId = 1;
const waiters = [];
const replies = new Map();
/** Every non-state event, in order (the scenario slices it per step). */
const events = [];
/** Raw debug lines about SDK system messages the engine ignored (observed behaviour). */
const ignoredSystem = new Set();
let child = null;
let exited = null;
let sidecarNo = 0;

function startSidecar() {
  sidecarNo += 1;
  const tag = `sidecar#${sidecarNo}`;
  child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"] });
  createInterface({ input: child.stderr }).on("line", (l) => {
    const m = /system message ignored: (\S+)/.exec(l);
    if (m) ignoredSystem.add(m[1]);
    if (!/:debug\]/.test(l)) process.stderr.write(`  [${tag}] ${l}\n`);
  });
  exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  state = null;
  createInterface({ input: child.stdout }).on("line", onLine);
}

function onLine(line) {
  const ev = JSON.parse(line);
  if (ev.type === "state") {
    state = ev.state;
  } else {
    events.push(ev);
    if (ev.type === "permission_request") {
      log(`permission_request ${ev.toolName} ${ev.file ?? JSON.stringify(ev.input).slice(0, 80)} → allow`);
      send({ type: "permission_response", requestId: ev.requestId, allow: true });
    } else if (ev.type === "error") {
      log(`error(${ev.scope}${ev.fatal ? ", fatal" : ""}): ${ev.message}`);
    } else if (ev.type === "tool_use") {
      log(`tool_use ${ev.name}${ev.parentToolUseId ? ` (parent ${ev.parentToolUseId.slice(-6)})` : ""}${ev.rationale ? ` why="${ev.rationale.slice(0, 60)}"` : ""}`);
    } else if (!["log", "activity", "text_delta", "tool_result", "tool_files"].includes(ev.type)) {
      log(`event ${ev.type}${ev.id ? ` id=${ev.id}` : ""}${ev.type === "result" && !ev.ok ? ` error=${ev.error}` : ""}`);
    }
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) if (state && w.pred(state)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(state);
  }
}

function send(cmd) {
  child.stdin.write(JSON.stringify(cmd) + "\n");
}

function request(cmd) {
  const id = `m${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type} (${id}) within ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      if (ev.type === "result" && !ev.ok) reject(new Error(`${cmd.type} failed: ${ev.error}`));
      else resolve(ev);
    });
    send({ ...cmd, id });
  });
}

/** Expects a refusal; resolves with the error text. */
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
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; phase=${state?.gate.phase} blocked=${state?.gate.blockedReason} lastError=${state?.lastError}`)), STEP_TIMEOUT_MS);
    waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
  });
}

const since = (mark, type) => events.slice(mark).filter((e) => e.type === type);
const turnDone = (turnsBefore) => (x) => x.hud.turnCount > turnsBefore && x.gate.phase !== "running" && x.gate.phase !== "collecting";

/** Sends `text` and waits for the turn to be collected; returns the event mark taken before the send. */
async function turn(text, extra = {}) {
  const before = state.hud.turnCount;
  const mark = events.length;
  await request({ type: "send", text, ...extra });
  await waitState(turnDone(before), `turn "${text.slice(0, 40)}"`);
  // turn_summary follows turn_end in the same burst; give the event loop a beat.
  await new Promise((r) => setTimeout(r, 300));
  return mark;
}

/** Same as driver-v2: matching processes minus the driver and a running ReviewGate.app. */
function procs() {
  const out = execFileSync("ps", ["-eo", "pid,ppid,command"], { encoding: "utf8" });
  const rows = new Map();
  for (const l of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), command: m[3], line: l });
  }
  const underApp = (pid) => {
    for (let p = pid, guard = 0; rows.has(p) && guard < 64; guard++) {
      if (/ReviewGate\.app/.test(rows.get(p).command)) return true;
      p = rows.get(p).ppid;
    }
    return false;
  };
  return [...rows.entries()]
    .filter(([pid, r]) => /sidecar\.mjs|stream-json/.test(r.command) && !/driver-(v2|m21)/.test(r.command) && !underApp(pid))
    .map(([, r]) => r.line);
}

async function stopSidecar() {
  await request({ type: "shutdown" });
  const { code, signal } = await exited;
  assert(code === 0 && signal === null, `sidecar exit ${code} ${signal}`);
}

const baseSettings = {
  ignorePatterns: [".omc/", ".claude/settings.local.json"],
  autoAllowTools: [],
  loadUserSettings: true,
  systemPromptAppend: "You are running inside ReviewGate. Make only the requested change and stop. Never run git commands.",
  claudePath: CLAUDE,
  model: MODEL,
};

async function hello(settings) {
  const ready = await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  assert(ready.type === "ready", "hello → ready");
  await request({ type: "open_project", path: REPO });
}

const observed = {};

// ---------------------------------------------------------------- scenario
async function main() {
  // ============ e1. init-timeout fallback (sidecar #1)
  // §36.7: the watchdog is a stall timer with a ≥ 45 s limit, so a real stall forces it: a local SessionStart hook that never
  // returns (the fallback drops local settings with user ones, so the fallback session starts without it).
  const STALL_TOKEN = "rg-driver-m21-stall";
  mkdirSync(join(REPO, ".claude"), { recursive: true });
  writeFileSync(join(REPO, ".claude", "settings.local.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `perl -e 'sleep 90' ${STALL_TOKEN}`, timeout: 120 }] }] } }));
  startSidecar();
  {
    const mark = events.length;
    await hello({ ...baseSettings, extensionsInitTimeoutMs: 1 });
    let s = await waitState((x) => x.session.extensions?.fallback != null && x.session.open && !x.session.starting, "extensions fallback + session open");
    const fb = since(mark, "extensions_fallback");
    assert(fb.length === 1 && fb[0].reason === "init_timeout" && fb[0].timeoutMs >= 45_000, `one extensions_fallback event after the ≥ 45 s stall limit: ${JSON.stringify(fb)}`);
    assert(fb[0].message.includes(`within ${Math.round(fb[0].timeoutMs / 1000)} s`), `the message says the limit: ${fb[0].message}`);
    assert(JSON.stringify(s.session.extensions.settingSources) === '["project"]', `fallback runs with project settings only: ${JSON.stringify(s.session.extensions.settingSources)}`);
    const m2 = await turn("Reply with the single word ok. Do not use any tools.");
    s = state;
    const text = since(m2, "text_delta").map((e) => e.text).join("");
    assert(/ok/i.test(text), `the fallback session still answers: ${JSON.stringify(text.slice(0, 80))}`);
    assert(since(m2, "extensions_fallback").length === 0, "a second fallback never cascades");
    observed.fallback = { event: fb[0], answer: text.trim().slice(0, 40), errorsDuringFallback: since(mark, "error").map((e) => e.message.slice(0, 120)) };
    log(`e1 fallback OK: ${fb[0].message}`);
    await stopSidecar();
  }
  rmSync(join(REPO, ".claude", "settings.local.json"), { force: true });
  for (const l of execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" }).split("\n")) {
    if (!l.includes(STALL_TOKEN)) continue;
    try {
      process.kill(Number(/^\s*(\d+)/.exec(l)[1]));
    } catch {}
  }

  // ============ sidecar #2, default settings
  startSidecar();
  await hello({ ...baseSettings });
  let s = await waitState((x) => x.session.open && !x.session.starting && x.project !== null, "session open");
  assert(s.gate.canSend, `gate open (blocked=${s.gate.blockedReason})`);

  // ============ a. subagent turn
  {
    const mark = await turn(
      "Step 1: say one short sentence about what you will do, then use the Agent tool (subagent_type general-purpose) " +
        "to have a subagent first say in one short sentence what it will do and then create the file hello.txt containing exactly 'hi' using its Write tool. " +
        "Step 2: after the subagent finished, say one short sentence, then use the Edit tool yourself to append the line 'sub done' to README.md. " +
        "Do nothing else.",
    );
    s = state;
    assert(s.gate.phase === "reviewing", `subagent turn ends in a review: ${s.gate.phase} ${s.gate.collectError ?? ""}`);
    const uses = since(mark, "tool_use");
    const agentUse = uses.find((u) => u.name === "Agent" || u.name === "Task");
    assert(agentUse, `an Agent/Task tool_use: ${uses.map((u) => u.name).join(",")}`);
    const inner = uses.filter((u) => u.parentToolUseId === agentUse.id);
    assert(inner.length > 0, `tool_use events from inside the subagent carry parentToolUseId: ${JSON.stringify(uses.map((u) => [u.name, u.parentToolUseId ?? null]))}`);
    assert(uses.filter((u) => u.id !== agentUse.id && !inner.includes(u)).every((u) => u.parentToolUseId === undefined), "top-level calls carry no parentToolUseId");
    const withWhy = uses.filter((u) => typeof u.rationale === "string" && u.rationale.length > 0);
    assert(withWhy.length > 0, `rationale on at least one tool_use: ${JSON.stringify(uses.map((u) => [u.name, u.rationale ?? null]))}`);
    // §34.8 (forwardSubagentText): a subagent's own calls carry its text as rationale — before, only its tool_use /
    // tool_result blocks reached the engine, so none had one.
    const innerWhy = inner.filter((u) => typeof u.rationale === "string" && u.rationale.length > 0 && (u.rationaleSource === "same_message" || u.rationaleSource === "earlier"));
    assert(innerWhy.length > 0, `a subagent call has its own rationale: ${JSON.stringify(inner.map((u) => [u.name, u.rationale ?? null, u.rationaleSource ?? null]))}`);
    const node = s.hud.agents.find((n) => n.toolUseId === agentUse.id);
    assert(node, `hud.agents has the subagent: ${JSON.stringify(s.hud.agents)}`);
    assert(node.status === "completed" && node.endedAt >= node.startedAt, `agent completed: ${JSON.stringify(node)}`);
    // CLI 2.1.303 would background the Agent call (is_backgrounded: true) and end the main turn before the
    // subagent's edit — the engine runs the CLI with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 so it stays in the turn.
    assert(node.type === "general-purpose" && node.depth === 1 && node.isBackground === false, `agent node fields: ${JSON.stringify(node)}`);
    assert(node.files.includes("hello.txt"), `agent files attributed: ${JSON.stringify(node.files)}`);
    const sawTaskMessages = node.id !== node.toolUseId;
    if (sawTaskMessages) assert(typeof node.tokens === "number" && node.tokens > 0 && typeof node.toolUses === "number" && node.toolUses > 0, `task usage populated: ${JSON.stringify(node)}`);
    const hello = s.changedFiles.find((f) => f.path === "hello.txt");
    const readme = s.changedFiles.find((f) => f.path === "README.md");
    assert(hello && readme, `both files in the review: ${JSON.stringify(s.changedFiles.map((f) => f.path))}`);
    assert(hello.toolUseIds.length > 0 && hello.toolUseIds.every((id) => inner.some((u) => u.id === id)), `hello.txt toolUseIds point into the subagent: ${JSON.stringify(hello.toolUseIds)}`);
    assert(readme.toolUseIds.length > 0, `README.md toolUseIds: ${JSON.stringify(readme.toolUseIds)}`);
    const sums = since(mark, "turn_summary");
    assert(sums.length === 1, `one turn_summary: ${sums.length}`);
    const sum = sums[0];
    assert(sum.turn === s.hud.turnCount || sum.turn > 0, `turn_summary.turn: ${sum.turn}`);
    const sp = sum.files.map((f) => f.path).sort();
    assert(JSON.stringify(sp) === '["README.md","hello.txt"]', `turn_summary files: ${JSON.stringify(sp)}`);
    // §34.8: a reported why (the turn-end report names the file) has no call of its own.
    assert(sum.files.some((f) => typeof f.why === "string" && f.why.length > 0 && (f.whyToolUseId || f.whyDetail?.source === "reported")), `a why in the summary: ${JSON.stringify(sum.files)}`);
    assert(hello.why?.agent?.toolUseId === agentUse.id, `hello.txt's why is the subagent's: ${JSON.stringify(hello.why)}`);
    assert(sum.plan === null, "no plan approved yet → plan null");
    observed.subagent = {
      sawTaskMessages,
      node: { id: node.id, status: node.status, tokens: node.tokens, toolUses: node.toolUses, durationMs: node.durationMs, summary: node.summary ?? null, lastTool: node.lastTool ?? null, files: node.files },
      innerTools: inner.map((u) => u.name),
      rationales: withWhy.map((u) => [u.name, u.rationale.slice(0, 80)]),
      summaryFiles: sum.files.map((f) => ({ path: f.path, tools: f.tools, why: f.why?.slice(0, 80) ?? null })),
      helloToolUseIds: hello.toolUseIds.length,
      helloTools: hello.tools,
    };
    log(`a subagent OK: ${JSON.stringify(observed.subagent.node)}`);
    await request({ type: "accept_all" });
    s = await waitState((x) => x.gate.canSend && x.gate.phase === "idle", "gate open after the subagent review");
  }

  // ============ e2. what the default session applied (plugins arrive with system/init, i.e. after a turn)
  {
    const ext = s.session.extensions;
    assert(ext && ext.fallback === null, `no fallback with the default timeout: ${JSON.stringify(ext?.fallback)}`);
    assert(JSON.stringify(ext.settingSources) === '["user","project","local"]', `user + project + local settings (§36.6): ${JSON.stringify(ext.settingSources)}`);
    assert(Array.isArray(ext.plugins) && Array.isArray(ext.skills) && Array.isArray(ext.mcpServers) && Array.isArray(ext.hooks), "extension lists present");
    assert(typeof ext.claudeMd.user === "boolean" && typeof ext.claudeMd.project === "boolean", "claudeMd flags");
    observed.extensions = {
      plugins: ext.plugins.map((p) => `${p.id ?? p.name}${p.enabled ? "" : " (off)"}`),
      skills: ext.skills.length,
      slashCommands: ext.slashCommands.length,
      mcpServers: ext.mcpServers.map((m) => `${m.name}:${m.status}`),
      memoryFiles: ext.memoryFiles === null ? null : ext.memoryFiles.map((f) => f.type),
      claudeMd: ext.claudeMd,
      hooks: ext.hooks.map((h) => `${h.source}${h.plugin ? `:${h.plugin}` : ""}[${h.events.join("+")}]${h.active ? "" : " (inactive)"}`),
    };
    assert(ext.plugins.length > 0, `the user's plugins are listed: ${JSON.stringify(observed.extensions)}`);
    log(`e2 extensions OK: ${ext.plugins.length} plugins, ${ext.skills.length} skills, ${ext.mcpServers.length} MCP`);
  }

  // ============ b. Bash: test outcome + truncated output
  {
    const mark = await turn(
      "Run these two shell commands with the Bash tool, one Bash call each, in this order, then reply 'done': " +
        "first `npm test`, then `seq 1 3000`. Do not run anything else and do not fix anything.",
    );
    const uses = since(mark, "tool_use").filter((u) => u.name === "Bash");
    const results = since(mark, "tool_result");
    const testUse = uses.find((u) => /npm (run )?test/.test(String(u.input.command)));
    const seqUse = uses.find((u) => /seq 1 3000/.test(String(u.input.command)));
    assert(testUse && seqUse, `both Bash calls ran: ${JSON.stringify(uses.map((u) => u.input.command))}`);
    const testRes = results.find((r) => r.toolUseId === testUse.id);
    const seqRes = results.find((r) => r.toolUseId === seqUse.id);
    assert(testRes && testRes.testOutcome === "fail", `npm test → testOutcome fail: ${JSON.stringify(testRes)}`);
    assert(seqRes && seqRes.testOutcome === undefined, `seq has no testOutcome: ${JSON.stringify(seqRes?.testOutcome)}`);
    assert(seqRes.truncated === true && seqRes.preview.length <= 500, `seq result truncated with a ≤500-char preview: truncated=${seqRes.truncated} len=${seqRes.preview.length}`);
    const out = await request({ type: "tool_output", toolUseId: seqUse.id });
    assert(out.type === "tool_output" && typeof out.output === "string", `tool_output returns text: ${JSON.stringify(out).slice(0, 200)}`);
    const lines = out.output.trim().split("\n");
    assert(lines[0] === "1" && lines[lines.length - 1] === "3000" && out.truncated === false && lines.length === 3000, `full seq output kept: ${lines.length} lines, last=${lines[lines.length - 1]}, truncated=${out.truncated}`);
    const none = await request({ type: "tool_output", toolUseId: "toolu_unknown" });
    assert(none.output === null, "unknown id → output null");
    assert(since(mark, "turn_summary").length === 0, "a turn that changed nothing emits no turn_summary");
    observed.bash = { testOutcome: testRes.testOutcome, testIsError: testRes.isError, seqPreviewLen: seqRes.preview.length, toolOutputLen: out.output.length };
    log(`b bash OK: ${JSON.stringify(observed.bash)}`);
    s = await waitState((x) => x.gate.canSend, "gate open after the Bash turn");
  }

  // ============ f + c. H3 refusals during a running turn, then reject_hunks
  {
    const before = state.hud.turnCount;
    const mark = events.length;
    await request({
      type: "send",
      text: "In README.md use the Edit tool twice: replace the line 'alpha' with 'ALPHA', and replace the line 'omega' with 'OMEGA'. Change nothing else.",
    });
    await waitState((x) => x.gate.phase === "running", "running");
    const h3 = [
      await refused({ type: "accept", paths: ["README.md"] }),
      await refused({ type: "reject", paths: ["README.md"] }),
      await refused({ type: "accept_all" }),
      await refused({ type: "reject_hunks", path: "README.md", hunks: [0] }),
    ];
    const stillRunning = state.gate.phase === "running" || state.gate.phase === "collecting";
    assert(h3.every((e) => e.includes("session_running")), `H3: review mutations refused while running: ${JSON.stringify(h3)}`);
    observed.h3 = { refusals: h3, refusedWhilePhase: stillRunning ? "running" : state.gate.phase };
    log(`f H3 OK: ${JSON.stringify(h3)}`);
    s = await waitState(turnDone(before), "edit turn");
    assert(s.gate.phase === "reviewing", `edit turn → review: ${s.gate.phase}`);
    const f = s.changedFiles.find((x) => x.path === "README.md");
    assert(f && f.status === "M", `README.md modified: ${JSON.stringify(s.changedFiles)}`);
    const diff = await request({ type: "select_file", path: "README.md" });
    const hunks = diff.diff.hunks;
    assert(hunks.length >= 2, `two hunks: ${hunks.map((h) => h.header).join(" | ")}`);
    const first = hunks.find((h) => h.lines.some((l) => /ALPHA/.test(l.text)));
    assert(first, "a hunk with ALPHA");
    const endTree = s.gate.turnEndTree;
    const stale = await refused({ type: "reject_hunks", path: "README.md", hunks: [first.id], expectedEndTree: "0".repeat(40) });
    assert(stale.includes("stale_diff"), `stale expectedEndTree refused: ${stale}`);
    const unknown = await refused({ type: "reject_hunks", path: "README.md", hunks: [999], expectedEndTree: endTree });
    assert(unknown.includes("unknown_hunk:999"), `unknown hunk refused: ${unknown}`);
    await request({ type: "reject_hunks", path: "README.md", hunks: [first.id], expectedEndTree: endTree });
    s = await waitState((x) => x.gate.turnEndTree !== endTree, "B re-snapshotted after reject_hunks");
    const disk = readFileSync(join(REPO, "README.md"), "utf8");
    assert(/^alpha$/m.test(disk) && !/^ALPHA$/m.test(disk) && /^OMEGA$/m.test(disk) && !/^omega$/m.test(disk), `only the ALPHA hunk reverted on disk:\n${disk}`);
    const pf = s.changedFiles.find((x) => x.path === "README.md");
    assert(pf && pf.state === "pending" && pf.partial === true && pf.rejectedHunks === 1, `README.md partial: ${JSON.stringify(pf)}`);
    assert(/Partially rejected/.test(s.gate.lastReviewSummary ?? ""), `lastReviewSummary mentions it: ${s.gate.lastReviewSummary}`);
    const diff2 = await request({ type: "select_file", path: "README.md" });
    assert(diff2.diff.hunks.length === hunks.length - 1, `one hunk left: ${diff2.diff.hunks.length}`);
    await request({ type: "accept", paths: ["README.md"] });
    s = await waitState((x) => x.gate.canSend, "README accepted");
    observed.hunks = { hunksBefore: hunks.length, hunksAfter: diff2.diff.hunks.length, stale, unknown, turnSummaries: since(mark, "turn_summary").length };
    log(`c reject_hunks OK: ${JSON.stringify(observed.hunks)}`);
  }

  // ============ d. plan mode → approve → turn_summary.plan
  {
    await request({ type: "set_permission_mode", mode: "plan" });
    s = await waitState((x) => x.session.permissionMode === "plan", "plan mode");
    const markPlan = await turn(
      "Plan adding a new file NOTES.md that contains the single line 'notes'. The plan must be a numbered list with exactly one step, " +
        "and that step must name NOTES.md. Do not write anything yet; present the plan for approval.",
    );
    const proposals = since(markPlan, "plan_proposed");
    assert(proposals.length === 1, `one plan_proposed: ${proposals.length}`);
    const before = state.hud.turnCount;
    const mark = events.length;
    await request({ type: "plan_response", approve: true, mode: "default" });
    s = await waitState(turnDone(before), "implementation turn");
    await new Promise((r) => setTimeout(r, 300));
    assert(s.gate.phase === "reviewing" && s.changedFiles.some((f) => f.path === "NOTES.md"), `NOTES.md pending: ${JSON.stringify(s.changedFiles.map((f) => f.path))}`);
    const sums = since(mark, "turn_summary");
    assert(sums.length === 1 && sums[0].plan, `turn_summary with a plan: ${JSON.stringify(sums.map((x) => x.plan))}`);
    const plan = sums[0].plan;
    assert(plan.steps.length >= 1 && Array.isArray(plan.unplannedFiles), `plan steps + unplannedFiles: ${JSON.stringify(plan)}`);
    assert(plan.steps.some((st) => st.files.includes("NOTES.md")), `a step maps to NOTES.md: ${JSON.stringify(plan.steps)}`);
    assert(!plan.unplannedFiles.includes("NOTES.md"), `NOTES.md is planned: ${JSON.stringify(plan.unplannedFiles)}`);
    observed.plan = { path: plan.path, steps: plan.steps.map((st) => ({ text: st.text.slice(0, 80), files: st.files })), unplannedFiles: plan.unplannedFiles, planChars: proposals[0].plan.length };
    log(`d plan OK: ${JSON.stringify(observed.plan)}`);
  }

  // ============ c (cont.). review history: the README round ended with the plan's fresh send
  {
    const h = await request({ type: "review_history" });
    assert(h.type === "review_history" && Array.isArray(h.entries), "review_history reply");
    const round = h.entries.find((e) => e.files.some((f) => f.path === "README.md" && f.rejectedHunks === 1));
    assert(round, `the reject_hunks round is in the history: ${JSON.stringify(h.entries.map((e) => [e.prompt.slice(0, 30), e.files.map((f) => [f.path, f.verdict, f.rejectedHunks])]))}`);
    const rf = round.files.find((f) => f.path === "README.md");
    assert(rf.verdict === "accepted" && rf.toolUseIds.length > 0, `README verdict accepted with ids: ${JSON.stringify(rf)}`);
    const subRound = h.entries.find((e) => e.files.some((f) => f.path === "hello.txt"));
    assert(subRound && subRound.files.every((f) => f.verdict === "accepted"), `the subagent round is listed accepted: ${JSON.stringify(subRound?.files)}`);
    const hd = await request({ type: "history_diff", entryId: round.id, path: "README.md" });
    assert(hd.type === "history_diff" && hd.diff.hunks.length >= 1 && hd.diff.hunks.some((x) => x.lines.some((l) => /OMEGA/.test(l.text))), `history_diff returns the diff: ${JSON.stringify(hd.diff).slice(0, 300)}`);
    const all = await request({ type: "review_history", all: true });
    assert(all.sessionId === null && all.entries.length >= h.entries.length, "all: true lists every session");
    const bad = await refused({ type: "history_diff", entryId: "nope", path: "README.md" });
    assert(bad.includes("unknown_history_entry"), `unknown entry refused: ${bad}`);
    const refs = git("for-each-ref", "--format=%(refname)", `refs/reviewgate/main/history/${round.id}/`);
    assert(refs.includes("/start") && refs.includes("/end"), `history refs pinned per worktree namespace: ${refs}`);
    observed.history = { entries: h.entries.length, round: { id: round.id, files: round.files.map((f) => [f.path, f.verdict, f.rejectedHunks ?? 0]) }, historyDiffHunks: hd.diff.hunks.length };
    log(`c history OK: ${JSON.stringify(observed.history)}`);
    await request({ type: "accept_all" });
  }

  await stopSidecar();

  // ============ g. disableUserHooks: ReviewGate's SDK hooks keep running (sidecar #3)
  startSidecar();
  {
    await hello({
      ...baseSettings,
      disableUserHooks: true,
      budget: { maxFiles: 1, maxLines: 400 },
      systemPromptAppend: "You are running inside ReviewGate. Do exactly the requested tool calls, in order, then stop.",
    });
    s = await waitState((x) => x.session.open && !x.session.starting && x.project !== null, "session open (hooks off)");
    // A fresh chat: the resumed one carries sidecar #2's "never run git commands" instruction.
    const resumedId = s.sessions.currentId;
    await request({ type: "session_new" });
    s = await waitState((x) => x.session.open && !x.session.starting && x.sessions.currentId !== resumedId, "fresh session (hooks off)");
    assert(s.session.extensions?.userHooksDisabled === true, `userHooksDisabled reported: ${JSON.stringify(s.session.extensions?.userHooksDisabled)}`);
    const probe = join(REPO, ".git", "rg-hooks-probe.txt");
    rmSync(probe, { force: true });
    const mark = await turn(
      "This is a test of the permission hooks; running `git status` is allowed here. " +
        "Make exactly these tool calls, one at a time, in this order, and continue with the next one even if a call is denied: " +
        "1) Bash: `git status --short`. 2) Write the file .git/rg-hooks-probe.txt with the content 'x'. " +
        "3) Write the file g1.txt with the content 'one'. 4) Write the file g2.txt with the content 'two'. Then reply 'done'.",
    );
    s = state;
    const uses = since(mark, "tool_use");
    const results = since(mark, "tool_result");
    const perms = since(mark, "permission_request");
    const statusUse = uses.find((u) => u.name === "Bash" && /git status/.test(String(u.input.command)));
    assert(statusUse, `git status ran: ${JSON.stringify(uses.map((u) => [u.name, u.input.command ?? u.input.file_path]))}`);
    assert(!perms.some((p) => p.toolName === "Bash"), `read-only git status needs no permission card (hooks off): ${JSON.stringify(perms.map((p) => p.toolName))}`);
    const statusRes = results.find((r) => r.toolUseId === statusUse.id);
    assert(statusRes && !statusRes.isError, `git status result ok: ${JSON.stringify(statusRes)}`);
    const gitWrite = uses.find((u) => u.name === "Write" && String(u.input.file_path).includes(".git/"));
    assert(gitWrite, `a Write into .git/ was attempted: ${JSON.stringify(uses.map((u) => [u.name, u.input.file_path]))}`);
    const gitWriteRes = results.find((r) => r.toolUseId === gitWrite.id);
    assert(gitWriteRes && gitWriteRes.isError && !existsSync(probe), `the .git/ write is denied by the git guard: ${JSON.stringify(gitWriteRes)} exists=${existsSync(probe)}`);
    const denies = since(mark, "budget_event").filter((b) => b.kind === "deny");
    assert(denies.length >= 1, `the budget hook denied the second new file: ${JSON.stringify(since(mark, "budget_event"))}`);
    const written = ["g1.txt", "g2.txt"].filter((f) => existsSync(join(REPO, f)));
    assert(written.length <= 1, `at most one file within maxFiles 1: ${JSON.stringify(written)}`);
    observed.hooksOff = {
      userHooksDisabled: true,
      permissionRequests: perms.map((p) => p.toolName),
      gitWriteDenied: gitWriteRes.preview.slice(0, 120),
      budgetDenies: denies.map((b) => `${b.toolName}:${b.file ?? ""}`),
      written,
      userHooks: (s.session.extensions?.hooks ?? []).map((h) => `${h.source}${h.active ? "" : " (inactive)"}`),
    };
    log(`g hooks-off OK: ${JSON.stringify(observed.hooksOff)}`);
    if (s.gate.phase === "reviewing") await request({ type: "reject_all" });
    await waitState((x) => x.gate.canSend && x.gate.phase === "idle", "gate idle after the hooks-off turn");
    rmSync(probe, { force: true });
  }

  // ============ shutdown + orphans
  await stopSidecar();
  await new Promise((r) => setTimeout(r, 1500));
  const orphans = procs();
  assert(orphans.length === 0, `orphaned processes after shutdown:\n${orphans.join("\n")}`);
  observed.ignoredSystemSubtypes = [...ignoredSystem];
  log("PASS");
  console.log(JSON.stringify({ ok: true, totalMs: Date.now() - t0, model: MODEL, claudeVersion: s.toolchain.claudeVersion, sessionCostUSD: Number(state.hud.sessionCostUSD.toFixed(4)), orphans: 0, observed }, null, 2));
}

main().catch(async (e) => {
  log(`FAIL: ${e.message}`);
  console.log(JSON.stringify({ ok: false, error: e.message, observed, ignoredSystemSubtypes: [...ignoredSystem] }, null, 2));
  process.exitCode = 1;
  try {
    send({ type: "shutdown" });
  } catch {}
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (child && child.exitCode === null) child.kill("SIGKILL");
  process.exit(1);
});
