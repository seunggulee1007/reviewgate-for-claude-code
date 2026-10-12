#!/usr/bin/env node
// Engine-level E2E for side questions (docs/PROTOCOL.md §21) and MCP management (§22) against the real `claude` CLI.
//
//   node sidecar/test/driver-m22.mjs [/path/to/git/repo]      (default /tmp/rg-m22, must be a git repo)
//   RG_MODEL=haiku (default) — every prompt is a Haiku-sized task.
//
//   m. mcp_status lists the user's configured MCP servers (names / statuses only in the log; no env / header values on the wire).
//   1. a main turn appends a line to README.md → reviewing.
//   2. side_ask anchored on that line (main idle): fork_full of the main session, an answer arrives; the main session is
//      untouched — hud.turnCount, SessionMeta, the engine transcript and the CLI's own session file are byte-identical.
//   3. read-only: a follow-up asking the side session to write a file → nothing is written.
//   4. side_ask while a main turn runs: fork_at the last completed turn, the answer arrives before / independent of the main turn.
//   5. side_promote_draft → an instruction; side_promote as note → a review note on README.md with the provenance line.
//   6. threads survive a sidecar restart (side_list).
// Asserts no `claude` / sidecar orphans at the end and prints what was observed as JSON.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.argv[2] ?? "/tmp/rg-m22";
const SIDECAR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 240_000;

const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
const t0 = Date.now();
const log = (msg) => process.stderr.write(`[m22 +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const assert = (cond, msg) => {
  if (!cond) {
    log(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
};

// ---------------------------------------------------------------- repo prep
assert(existsSync(join(REPO, ".git")), `${REPO} is not a git repository`);
rmSync(join(REPO, ".git", "reviewgate.lock"), { force: true });
for (const f of ["reviewgate-review.json", "reviewgate-session.json", "reviewgate-transcript.ndjson"]) rmSync(join(REPO, ".git", f), { force: true });
rmSync(join(REPO, ".git", "reviewgate"), { recursive: true, force: true });
for (const r of git("for-each-ref", "--format=%(refname)", "refs/reviewgate/").split("\n").filter(Boolean)) git("update-ref", "-d", r);
rmSync(join(REPO, "side-probe.txt"), { force: true });
writeFileSync(join(REPO, "README.md"), ["# m22 scratch", "", "alpha", "beta", ""].join("\n"));
const exclude = join(REPO, ".git", "info", "exclude");
execFileSync("sh", ["-c", `mkdir -p "$(dirname "${exclude}")"; grep -qx '.omc/' "${exclude}" 2>/dev/null || echo '.omc/' >> "${exclude}"`]);
if (git("status", "--porcelain")) {
  git("add", "-A");
  git("commit", "-q", "-m", "driver-m22: clean start");
}
assert(git("status", "--porcelain") === "", "worktree must be clean before the run");

// ---------------------------------------------------------------- sidecar plumbing (as driver-m21)
let state = null;
let nextId = 1;
const waiters = [];
const replies = new Map();
const events = [];
let child = null;
let exited = null;
let sidecarNo = 0;

function startSidecar() {
  sidecarNo += 1;
  const tag = `sidecar#${sidecarNo}`;
  child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"] });
  createInterface({ input: child.stderr }).on("line", (l) => {
    if (!/:debug\]/.test(l)) process.stderr.write(`  [${tag}] ${l}\n`);
  });
  exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  state = null;
  createInterface({ input: child.stdout }).on("line", onLine);
}

function onLine(line) {
  const ev = JSON.parse(line);
  if (ev.type === "state") state = ev.state;
  else {
    events.push(ev);
    if (ev.type === "permission_request") {
      log(`permission_request ${ev.toolName} → allow`);
      send({ type: "permission_response", requestId: ev.requestId, allow: true });
    } else if (ev.type === "error") log(`error(${ev.scope}${ev.code ? ` ${ev.code}` : ""}): ${ev.message.slice(0, 200)}`);
    else if (ev.type === "side_tool_use") log(`side_tool_use ${ev.name}`);
    else if (ev.type === "side_tool_result") log(`side_tool_result ${ev.isError ? "error" : "ok"}${ev.denied ? " (denied)" : ""}`);
    else if (!["log", "activity", "text_delta", "side_text_delta", "tool_result", "tool_files", "mcp_status", "side_thread"].includes(ev.type)) {
      log(`event ${ev.type}${ev.type === "result" && !ev.ok ? ` error=${ev.error}` : ""}`);
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

function waitState(pred, what) {
  if (state && pred(state)) return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; phase=${state?.gate.phase} lastError=${state?.lastError}`)), STEP_TIMEOUT_MS);
    waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
  });
}

async function waitEvent(pred, what) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const since = (mark, type) => events.slice(mark).filter((e) => e.type === type);
const turnDone = (before) => (x) => x.hud.turnCount > before && x.gate.phase !== "running" && x.gate.phase !== "collecting";

function procs() {
  const out = execFileSync("ps", ["-eo", "pid,ppid,command"], { encoding: "utf8" });
  const rows = new Map();
  for (const l of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), command: m[3], line: l });
  }
  const underApp = (pid) => {
    for (let p = pid, guard = 0; rows.has(p) && guard < 64; guard++) {
      if (/ReviewGate\.app|Electron|reviewgate-desktop/.test(rows.get(p).command)) return true;
      p = rows.get(p).ppid;
    }
    return false;
  };
  return [...rows.entries()]
    .filter(([pid, r]) => /sidecar\.mjs|stream-json/.test(r.command) && !/driver-(v2|m21|m22)/.test(r.command) && !underApp(pid) && !PREEXISTING.has(pid))
    .map(([, r]) => r.line);
}

/** Matching processes that were already running before this driver (another client / driver on the machine). */
const PREEXISTING = new Set();

/** The CLI's own transcript of a session (`<config>/projects/<slug>/<id>.jsonl`), or null. */
function cliSessionFile(id) {
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    const f = join(root, d, `${id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}
const digest = (p) => (p && existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);

async function stopSidecar() {
  await request({ type: "shutdown" });
  const { code, signal } = await exited;
  assert(code === 0 && signal === null, `sidecar exit ${code} ${signal}`);
}

const settings = {
  ignorePatterns: [".omc/", ".claude/settings.local.json"],
  autoAllowTools: [],
  loadUserSettings: true,
  systemPromptAppend: "You are running inside ReviewGate. Make only the requested change and stop. Never run git commands.",
  claudePath: CLAUDE,
  model: MODEL,
};

async function hello() {
  const ready = await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  assert(ready.type === "ready", "hello → ready");
  await request({ type: "open_project", path: REPO });
  return waitState((x) => x.session.open && !x.session.starting && x.project !== null, "session open");
}

/** Runs one side question and waits for its side_turn_end; returns { thread, answer }. */
async function ask(cmd, what) {
  const mark = events.length;
  const reply = await request({ type: "side_ask", ...cmd });
  assert(reply.type === "side_thread" && reply.thread.status === "running", `${what}: side_ask replies a running thread: ${JSON.stringify(reply).slice(0, 200)}`);
  const id = reply.thread.id;
  const end = await waitEvent((e, i) => e.type === "side_turn_end" && e.threadId === id && events.indexOf(e) >= mark, `${what}: side_turn_end`);
  const answer = events.slice(mark).filter((e) => e.type === "side_text_delta" && e.threadId === id).map((e) => e.text).join("");
  const list = await request({ type: "side_list" });
  return { thread: list.threads.find((t) => t.id === id), answer, end, mark };
}

const observed = {};

async function main() {
  for (const l of procs()) PREEXISTING.add(Number(/^\s*(\d+)/.exec(l)?.[1]));
  startSidecar();
  let s = await hello();

  // ============ m. MCP status of the user's configuration
  {
    const st = await waitStatus();
    assert(st.type === "mcp_status" && Array.isArray(st.servers), `mcp_status reply: ${JSON.stringify(st).slice(0, 200)}`);
    for (const sv of st.servers) {
      assert(!("env" in (sv.config ?? {})) && !("headers" in (sv.config ?? {})), `no env / header values on the wire for ${sv.name}`);
    }
    observed.mcp = { count: st.servers.length, servers: st.servers.map((sv) => `${sv.name}:${sv.status}:${sv.source}:${sv.transport}:${sv.toolCount ?? "-"}`) };
    log(`m mcp_status OK: ${st.servers.length} server(s): ${st.servers.map((sv) => `${sv.name}(${sv.status})`).join(", ") || "none"}`);
  }

  // ============ 1. a main turn changes README.md
  {
    const before = s.hud.turnCount;
    await request({ type: "send", text: "Append a new last line containing exactly the word gamma to README.md using the Edit tool. Do nothing else." });
    s = await waitState(turnDone(before), "main turn 1");
    assert(s.gate.phase === "reviewing" && s.changedFiles.some((f) => f.path === "README.md"), `README.md under review: ${JSON.stringify(s.changedFiles.map((f) => f.path))}`);
    log("1 main turn OK");
  }

  // ============ 2. side question while idle: the main session is untouched
  const gdir = join(REPO, ".git");
  const mainSid = s.session.sessionId;
  const metaId = s.sessions.currentId;
  const transcriptPath = join(gdir, "reviewgate", "sessions", `${metaId}.ndjson`);
  const cliMain = cliSessionFile(mainSid);
  const before = { turnCount: s.hud.turnCount, cost: s.hud.sessionCostUSD, meta: JSON.stringify(s.sessions.list.find((m) => m.id === metaId)), transcript: digest(transcriptPath), cli: digest(cliMain), userMessages: events.filter((e) => e.type === "user_message").length };
  assert(cliMain, `the CLI's own transcript of ${mainSid} was found`);
  const gammaLine = readFileSync(join(REPO, "README.md"), "utf8").split("\n").findIndex((l) => l.trim() === "gamma") + 1;
  const q1 = await ask({ anchor: { path: "README.md", line: gammaLine > 0 ? gammaLine : 5, side: "new" }, question: "In one short sentence: what word did this change add, and on which line? Do not use any tools." }, "2");
  assert(q1.thread && q1.thread.status === "idle", `2: thread idle after the answer: ${JSON.stringify(q1.thread).slice(0, 300)}`);
  assert(/gamma/i.test(q1.answer), `2: the side answer knows the change: ${JSON.stringify(q1.answer.slice(0, 200))}`);
  assert(q1.thread.fork?.mode === "fork_full" && q1.thread.fork.fromSessionId === mainSid, `2: forked from the idle main session: ${JSON.stringify(q1.thread.fork)}`);
  assert(q1.thread.sessionId && q1.thread.sessionId !== mainSid, `2: own side session id: ${q1.thread.sessionId}`);
  assert(cliSessionFile(q1.thread.sessionId), "2: the fork has its own CLI session file");
  await new Promise((r) => setTimeout(r, 500));
  s = state;
  const after = { turnCount: s.hud.turnCount, cost: s.hud.sessionCostUSD, meta: JSON.stringify(s.sessions.list.find((m) => m.id === metaId)), transcript: digest(transcriptPath), cli: digest(cliMain), userMessages: events.filter((e) => e.type === "user_message").length };
  assert(JSON.stringify(after) === JSON.stringify(before), `2: main session untouched:\n before ${JSON.stringify(before)}\n after  ${JSON.stringify(after)}`);
  assert(s.hud.sideCostUSD > 0, `2: hud.sideCostUSD counted separately: ${s.hud.sideCostUSD}`);
  observed.idleFork = { answer: q1.answer.trim().slice(0, 160), fork: q1.thread.fork, costUSD: q1.end.costUSD, durationMs: q1.end.durationMs, sideCostUSD: s.hud.sideCostUSD };
  log(`2 side question (idle) OK: ${JSON.stringify(q1.answer.trim().slice(0, 100))}`);

  // ============ 3. read-only enforcement
  {
    const q = await ask({ threadId: q1.thread.id, question: "Use the Write tool now to create the file side-probe.txt containing hi. If you cannot, say why in one sentence." }, "3");
    assert(!existsSync(join(REPO, "side-probe.txt")), "3: the side session could not write a file");
    const tools = since(q.mark, "side_tool_use").filter((e) => e.threadId === q1.thread.id).map((e) => e.name);
    const denied = since(q.mark, "side_tool_result").filter((e) => e.threadId === q1.thread.id && e.denied).length;
    assert(q.thread.messages.filter((m) => m.role === "user").length === 2, "3: the follow-up continued the same thread");
    observed.readOnly = { tools, denied, answer: q.answer.trim().slice(0, 160) };
    log(`3 read-only OK: tools=${JSON.stringify(tools)} denied=${denied}`);
  }

  // ============ 4. side question while the main turn runs
  {
    const turnsBefore = state.hud.turnCount;
    await request({ type: "send", text: "Run the shell command: sleep 20 && echo done   (use the Bash tool once, then reply with the single word finished)." });
    await waitState((x) => x.gate.phase === "running" && x.hud.activity.kind !== "idle", "main turn 2 running");
    const q = await ask({ anchor: { path: "README.md" }, question: "Answer in one sentence without tools: which word was appended to README.md?" }, "4");
    const mainStillRunning = state.gate.phase === "running";
    assert(q.thread.fork?.mode === "fork_at" && typeof q.thread.fork.at === "string", `4: forked at the last completed turn while the main turn ran: ${JSON.stringify(q.thread.fork)}`);
    assert(/gamma/i.test(q.answer), `4: answer while running: ${JSON.stringify(q.answer.slice(0, 200))}`);
    observed.runningFork = { fork: q.thread.fork, mainStillRunningWhenAnswered: mainStillRunning, answer: q.answer.trim().slice(0, 120) };
    log(`4 side question (main running) OK: mainStillRunning=${mainStillRunning}`);
    await waitState(turnDone(turnsBefore), "main turn 2");
  }

  // ============ 5. promote: draft → note
  {
    const draft = await request({ type: "side_promote_draft", threadId: q1.thread.id });
    assert(draft.type === "side_promote_draft" && draft.text.trim().length > 0, `5: a draft: ${JSON.stringify(draft).slice(0, 200)}`);
    s = await waitState((x) => x.gate.phase === "reviewing" && !x.gate.isRequestingChanges, "reviewing before the note");
    await request({ type: "side_promote", threadId: q1.thread.id, as: "note", text: draft.text });
    s = await waitState((x) => x.reviewNotes.length === 1, "the promoted note");
    const note = s.reviewNotes[0];
    assert(note.path === "README.md" && note.body.includes("(곁질문에서 정리됨)"), `5: note on README.md with provenance: ${JSON.stringify(note)}`);
    assert(s.gate.canRequestChanges, "5: request_changes becomes available");
    observed.promote = { draft: draft.text.trim().slice(0, 200), note: { path: note.path, line: note.line, side: note.side } };
    log(`5 promote OK: ${JSON.stringify(observed.promote)}`);
  }

  // ============ 6. persistence across a sidecar restart
  {
    await stopSidecar();
    startSidecar();
    await hello();
    const list = await request({ type: "side_list" });
    assert(list.threads.length === 2 && list.threads.some((t) => t.id === q1.thread.id && t.messages.length >= 4), `6: threads restored: ${JSON.stringify(list.threads.map((t) => [t.id, t.messages.length]))}`);
    observed.persisted = list.threads.map((t) => ({ title: t.title, messages: t.messages.length, costUSD: Number(t.costUSD.toFixed(4)) }));
    log("6 persistence OK");
    // Leave the scratch repo clean: drop the note, reject the review.
    for (const n of state.reviewNotes) await request({ type: "remove_note", noteId: n.id });
    if (state.gate.phase === "reviewing") await request({ type: "reject_all", force: true });
  }

  await stopSidecar();
  await new Promise((r) => setTimeout(r, 1500));
  const orphans = procs();
  assert(orphans.length === 0, `orphaned processes after shutdown:\n${orphans.join("\n")}`);
  log("PASS");
  console.log(JSON.stringify({ ok: true, totalMs: Date.now() - t0, model: MODEL, claudeVersion: state?.toolchain.claudeVersion ?? null, orphans: 0, observed }, null, 2));
}

/** mcp_status right after the session start can still list servers as pending; wait up to ~20 s for them to settle. */
async function waitStatus() {
  let st = await request({ type: "mcp_status" });
  for (let i = 0; i < 20 && st.servers.some((sv) => sv.status === "pending"); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    st = await request({ type: "mcp_status" });
  }
  return st;
}

main().catch(async (e) => {
  log(`FAIL: ${e.message}`);
  console.log(JSON.stringify({ ok: false, error: e.message, observed }, null, 2));
  process.exitCode = 1;
  try {
    send({ type: "shutdown" });
  } catch {}
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (child && child.exitCode === null) child.kill("SIGKILL");
  process.exit(1);
});
