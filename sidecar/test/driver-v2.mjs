#!/usr/bin/env node
// Engine-level E2E over protocol v2 (docs/PROTOCOL.md) against the real `claude` CLI.
//
//   node sidecar/test/driver-v2.mjs [/path/to/git/repo]      (default /tmp/rg-scratch, must be a git repo)
//
// hello → open_project → send (auto-allow every permission_request) → wait gate.phase=reviewing →
// shutdown WITHOUT resolving (docs/PROTOCOL.md §8) → new sidecar → hello → open_project (asserts gate.restored, the pending
// files, transcript_restore and the pinned refs) → select_file → reject v2.txt (asserts it is gone) → add_note + request_changes
// → wait reviewing → accept_all → send "what word…" (resume across processes: expects "pineapple") → restart_session → send again
// (resume across restart_session) → commit {push:false} (asserts git log -1 + state.commit.lastCommit) → chat sessions (M15):
// session_new → send "Reply pong only" → session_list (2 entries with titles) → session_open first → send "what word…" (resume across
// sessions in one process: "pineapple") → rename/archive/delete/tabs_set → refresh → branches → create_branch rg-v2
// → switch_branch main → workbench_create rg-wb (managed root under os.tmpdir()) → workbench_list → refusals → workbench_remove → shutdown.
// M16 (docs/M16-FRICTION.md), after the commit: send "Run: git status" (asserts NO Bash permission_request — read-only auto-allow)
// → send "Run: echo hi > x.txt" (permission_request → {allow:true, remember:true}) → a plain send while reviewing
// (a QUESTION: asserts the file list and snapshot A survive it untouched, docs/PROTOCOL.md §10) → send {acceptPending:true}
// "echo … >> x.txt" while reviewing (asserts x.txt accepted, the turn runs, and the redirect IS prompted again although
// `Bash:echo hi` is remembered — a remembered key never covers a redirection, docs/PROTOCOL.md §19.3) → forget_allows.
// M20 (docs/M20-MODES.md), after M16: set_permission_mode plan → send "Plan how to add a CONTRIBUTING.md; do not write anything yet"
// → expect plan_proposed with non-empty plan text (the CLI writes ~/.claude/plans/<slug>.md BEFORE calling ExitPlanMode, which
// the ENGINE denies centrally — the app approves plans with plan_response, and never sees a card for the tool, nor a
// tool_use/tool_result for the intercepted call — the deny would otherwise render as a red "tool error" transcript row) and
// state.session.pendingPlan, with the plan file absent from changedOutside/the review → plan_response {approve:true, mode:"default"}
// → the follow-up turn creates CONTRIBUTING.md → asserts it is pending in the review and the mode switched.
// Also asserts the budget defaults (hello without budget), gate.reviewSummary and the capabilities cache on the second open_project.
// Asserts no `claude`/sidecar orphans and prints the max `state` size and count.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.argv[2] ?? "/tmp/rg-scratch";
const SIDECAR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const BRANCH = "rg-v2";
const CONTRIBUTING = "CONTRIBUTING.md"; // M20: written by the approved-plan turn
const WB_BRANCH = "rg-wb";
const WB_ROOT = join(realpathSync(tmpdir()), "rg-driver-worktrees"); // realpath: git prints /private/var on macOS
const STEP_TIMEOUT_MS = 180_000;

const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
/** The engine's post-turn `git status` refresh briefly holds index.lock; retry index writes for up to ~2 s. */
async function gitRetry(...args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return git(...args);
    } catch (e) {
      if (attempt >= 20 || !/index\.lock/.test(String(e.stderr ?? e.message))) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
const t0 = Date.now();
const log = (msg) => process.stderr.write(`[driver +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const assert = (cond, msg) => {
  if (!cond) {
    log(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
};

// ---------------------------------------------------------------- repo prep
assert(existsSync(join(REPO, ".git")), `${REPO} is not a git repository`);
rmSync(join(REPO, ".omc"), { recursive: true, force: true });
if (git("ls-files", ".omc")) git("rm", "-r", "-q", "--cached", ".omc");
const exclude = join(REPO, ".git", "info", "exclude");
execFileSync("sh", ["-c", `mkdir -p "$(dirname "${exclude}")"; grep -qx '.omc/' "${exclude}" 2>/dev/null || echo '.omc/' >> "${exclude}"`]);
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") git("switch", "-q", "main");
if (git("branch", "--list", BRANCH)) git("branch", "-q", "-D", BRANCH);
rmSync(WB_ROOT, { recursive: true, force: true });
git("worktree", "prune");
if (git("branch", "--list", WB_BRANCH)) git("branch", "-q", "-D", WB_BRANCH);
rmSync(join(REPO, ".git", "reviewgate.lock"), { force: true });
for (const f of ["reviewgate-review.json", "reviewgate-session.json", "reviewgate-transcript.ndjson"]) rmSync(join(REPO, ".git", f), { force: true });
rmSync(join(REPO, ".git", "reviewgate"), { recursive: true, force: true }); // M15 sessions
for (const r of execFileSync("git", ["-C", REPO, "for-each-ref", "--format=%(refname)", "refs/reviewgate/"], { encoding: "utf8" }).split("\n").filter(Boolean)) {
  execFileSync("git", ["-C", REPO, "update-ref", "-d", r], { stdio: "ignore" });
}
rmSync(join(REPO, "v2.txt"), { force: true });
rmSync(join(REPO, "x.txt"), { force: true }); // M16
rmSync(join(REPO, "CONTRIBUTING.md"), { force: true }); // M20
if (git("status", "--porcelain")) {
  git("add", "-A");
  git("commit", "-q", "-m", "driver-v2: clean start");
}
assert(git("status", "--porcelain") === "", "worktree must be clean before the run");
const readmeBefore = git("show", "HEAD:README.md");

// ---------------------------------------------------------------- sidecar
let state = null;
let stateCount = 0;
let maxStateBytes = 0;
let nextId = 1;
const waiters = [];
const replies = new Map();
const transcript = [];
const restores = [];
/** Every permission_request seen ({toolName, input, requestId}); M16 asserts on Bash entries. */
const permissionRequests = [];
/** Every top-level tool_use ({name, input}). */
const toolUses = [];
/** Every tool_result ({toolUseId, isError, preview}); M20 asserts ExitPlanMode's deny never shows up here. */
const toolResults = [];
/** Every plan_proposed ({path, plan}) — M20. */
const planProposals = [];
/** When true, Bash permission_requests are answered with `remember: true` (M16 §2). */
let rememberBash = false;
/** Filled by the M20 plan block for the summary. */
let planApproved = null;
let child = null;
let exited = null;
let sidecarNo = 0;

/** Spawns a sidecar process and binds the event reader to it; a second call (after `shutdown`) starts a fresh engine. */
function startSidecar() {
  sidecarNo += 1;
  const tag = sidecarNo === 1 ? "sidecar" : `sidecar#${sidecarNo}`;
  child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"] });
  createInterface({ input: child.stderr }).on("line", (l) => process.stderr.write(`  [${tag}] ${l}\n`));
  exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  state = null; // seq restarts at 1 in a new engine
  createInterface({ input: child.stdout }).on("line", onLine);
  return child;
}

function onLine(line) {
  const ev = JSON.parse(line);
  if (ev.type === "state") {
    stateCount += 1;
    maxStateBytes = Math.max(maxStateBytes, Buffer.byteLength(line));
    assert(!state || ev.state.seq > state.seq, `state.seq must increase (${state?.seq} → ${ev.state.seq})`);
    state = ev.state;
  } else if (ev.type === "text_delta") {
    transcript.push(ev.text);
  } else if (ev.type === "transcript_restore") {
    restores.push(ev.items);
    log(`transcript_restore: ${ev.items.length} row(s)`);
  } else if (ev.type === "permission_request") {
    permissionRequests.push({ toolName: ev.toolName, input: ev.input, requestId: ev.requestId });
    // M20: this CLI (2.1.275) DOES have an `ExitPlanMode` tool (it carries `plan` + `planFilePath`). The ENGINE
    // answers it centrally (deny + `plan_proposed`), so no client ever sees a card for it — asserted below.
    assert(ev.toolName !== "ExitPlanMode", "the engine must answer ExitPlanMode itself: no permission_request for it");
    const remember = rememberBash && ev.toolName === "Bash";
    log(`permission_request ${ev.toolName} ${ev.file ?? JSON.stringify(ev.input).slice(0, 80)} → allow${remember ? " (remember)" : ""}`);
    send({ type: "permission_response", requestId: ev.requestId, allow: true, ...(remember ? { remember: true } : {}) });
  } else if (ev.type === "tool_use") {
    toolUses.push({ name: ev.name, input: ev.input });
  } else if (ev.type === "tool_result") {
    toolResults.push({ toolUseId: ev.toolUseId, isError: ev.isError, preview: ev.preview });
  } else if (ev.type === "plan_proposed") {
    planProposals.push({ path: ev.path, plan: ev.plan });
    log(`plan_proposed ${ev.path} (${ev.plan.length} chars)`);
  } else if (ev.type === "error") {
    log(`error(${ev.scope}${ev.fatal ? ", fatal" : ""}): ${ev.message}`);
  } else if (ev.type !== "log" && ev.type !== "activity" && ev.type !== "tool_use" && ev.type !== "tool_result") {
    log(`event ${ev.type}${ev.id ? ` id=${ev.id}` : ""}${ev.type === "result" && !ev.ok ? ` error=${ev.error}` : ""}`);
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) if (state && w.pred(state)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(state);
  }
}

startSidecar();

function send(cmd) {
  child.stdin.write(JSON.stringify(cmd) + "\n");
}

/** Sends a command with an id and resolves with its reply (rejects on `result ok:false`). */
function request(cmd) {
  const id = `d${nextId++}`;
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
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; phase=${state?.gate.phase} blocked=${state?.gate.blockedReason} lastError=${state?.lastError}`)), STEP_TIMEOUT_MS);
    waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
  });
}

/**
 * Sidecar / `claude` processes that are NOT accounted for: everything matching, minus the driver itself and
 * minus anything belonging to a ReviewGate.app instance the developer happens to have running (its bundled
 * sidecar lives in `ReviewGate.app/Contents/Resources`). An orphan left by THIS driver is reparented to
 * pid 1, so it never has such an ancestor and is still caught.
 */
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
    .filter(([pid, r]) => /sidecar\.mjs|stream-json/.test(r.command) && !/driver-v2/.test(r.command) && !underApp(pid))
    .map(([, r]) => r.line);
}

// ---------------------------------------------------------------- scenario
async function main() {
  const settings = {
    // no `budget`: the engine defaults (M16 §4: 10 / 400 / 2.0) apply
    ignorePatterns: [".omc/", ".claude/settings.local.json"],
    autoAllowTools: [],
    loadUserSettings: true,
    systemPromptAppend: "You are running inside ReviewGate. Make only the requested change and stop.",
    claudePath: CLAUDE,
    ghHost: "github.com",
    model: process.env.RG_MODEL ?? "opus",
    worktreeRoot: WB_ROOT,
  };
  const ready = await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  assert(ready.type === "ready" && ready.protocolVersion === 2, "hello → ready");
  log(`ready: engine ${ready.engineVersion} on ${ready.platform}`);
  let s = await waitState((x) => x.seq >= 1, "initial state");
  assert(s.budget.maxFiles === 10 && s.budget.maxLines === 400 && s.budget.hardMultiplier === 2, `budget defaults without hello.budget: ${JSON.stringify(s.budget)}`);
  assert(s.session.capabilitiesCached === false && Array.isArray(s.session.rememberedAllows) && s.session.rememberedAllows.length === 0, `M16 session fields: ${JSON.stringify(s.session)}`);

  await request({ type: "open_project", path: REPO });
  s = await waitState((x) => x.session.open && !x.session.starting && x.project !== null, "session open");
  log(`project ${s.project.name} on ${s.project.branch}; claude=${s.toolchain.claude} ${s.toolchain.claudeVersion ?? ""}`);
  assert(s.gate.canSend, `gate must be open after open_project (blocked=${s.gate.blockedReason})`);
  assert(s.project.branch === "main", "on main");

  assert(restores.length === 1 && restores[0].length === 0, `first open replays an empty transcript: ${JSON.stringify(restores)}`);
  await request({ type: "send", text: "Append a line 'v2' to README.md and create v2.txt containing 'hello v2'. Also remember the word 'pineapple' — I will ask you for it later. Do not run git commands." });
  s = await waitState((x) => x.gate.phase === "running", "running");
  s = await waitState((x) => x.gate.phase === "reviewing" || x.gate.phase === "collect_failed" || (x.gate.phase === "idle" && x.hud.turnCount > 0), "turn end");
  assert(s.gate.phase === "reviewing", `expected reviewing after the turn, got ${s.gate.phase} (${s.gate.collectError ?? ""}); changed=${JSON.stringify(s.changedFiles.map((f) => f.path))}`);
  log(`reviewing: ${s.changedFiles.map((f) => `${f.path}[${f.status}${f.tools.length ? " " + f.tools.join("+") : ""}]`).join(", ")} · turn ${s.hud.lastTurnMs}ms $${s.hud.sessionCostUSD.toFixed(4)} ctx ${s.hud.contextTokens}/${s.hud.contextWindow}`);
  const paths = s.changedFiles.map((f) => f.path);
  assert(paths.includes("README.md") && paths.includes("v2.txt"), `expected README.md + v2.txt, got ${paths.join(",")}`);
  assert(s.gate.reviewSummary.files === s.changedFiles.length && s.gate.reviewSummary.added === s.changedFiles.reduce((n, f) => n + f.added, 0) && s.gate.reviewSummary.deleted === s.changedFiles.reduce((n, f) => n + f.deleted, 0), `gate.reviewSummary sums changedFiles: ${JSON.stringify(s.gate.reviewSummary)}`);
  assert(s.session.capabilitiesCached === false, "capabilities fresh after session_info");
  assert(existsSync(join(REPO, ".git", "reviewgate", "capabilities.json")), "capabilities cached in <gitdir>/reviewgate/capabilities.json");
  assert(s.session.capabilities !== null, "capabilities from session_info");
  assert(s.hud.turnCount === 1, "turnCount 1");
  // Claude's auto-memory lives under ~/.claude/projects/…: every such Write went through the permission card (auto-allowed
  // above) and is reported as an outside edit instead of vanishing (docs/PROTOCOL.md §8).
  assert(s.gate.changedOutside.every((p) => p.startsWith(`${process.env.HOME}/.claude/`)), `outside writes are only Claude's memory: ${JSON.stringify(s.gate.changedOutside)}`);
  assert(s.gate.ignoredTouched.length === 0 && s.gate.filteredByPattern.every((p) => p.startsWith(".omc/")), `ignored/filtered: ${JSON.stringify([s.gate.ignoredTouched, s.gate.filteredByPattern])}`);
  log(`changedOutside: ${JSON.stringify(s.gate.changedOutside)}`);
  const outsideFirstTurn = s.gate.changedOutside;
  const firstSessionId = s.session.sessionId;
  const firstStartTree = s.gate.turnStartTree;
  assert(firstSessionId, "session id known after the first turn");

  // ---------------------------------------------------------------- persistence (docs/PROTOCOL.md §8): shutdown WITHOUT resolving
  const reviewFile = join(REPO, ".git", "reviewgate-review.json");
  await request({ type: "shutdown" });
  {
    const { code } = await exited;
    assert(code === 0, `first sidecar exit ${code}`);
  }
  assert(existsSync(reviewFile), "review file persisted in the gitdir");
  assert(git("rev-parse", "--verify", "refs/reviewgate/main/turn-start") === firstStartTree, "A pinned by refs/reviewgate/main/turn-start (per-worktree namespace, §14)");
  assert(existsSync(join(REPO, ".git", "reviewgate", "sessions", `${firstSessionId}.ndjson`)), "transcript persisted per session in the gitdir (M15)");
  assert(!existsSync(join(REPO, ".git", "reviewgate-transcript.ndjson")), "no legacy transcript file");
  const sessionsIndex = JSON.parse(readFileSync(join(REPO, ".git", "reviewgate", "sessions", "index.json"), "utf8"));
  assert(sessionsIndex.version === 1 && sessionsIndex.sessions.length === 1 && sessionsIndex.sessions[0].id === firstSessionId && sessionsIndex.sessions[0].turns === 1, `sessions index: ${JSON.stringify(sessionsIndex)}`);
  assert(JSON.parse(readFileSync(join(REPO, ".git", "reviewgate-session.json"), "utf8")).sessionId === firstSessionId, "session id persisted");
  const tFreshBoot = Date.now();
  startSidecar();
  await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  await request({ type: "open_project", path: REPO });
  s = await waitState((x) => x.session.open && !x.session.starting && x.project !== null, "session open (2nd engine)");
  assert(s.gate.restored === true, `gate.restored after reopen (phase=${s.gate.phase})`);
  assert(s.session.capabilities !== null && s.session.capabilitiesCached === true && s.session.capabilities.slashCommands.length > 0, `cached capabilities shown before the first turn: ${JSON.stringify(s.session.capabilities)?.slice(0, 80)} cached=${s.session.capabilitiesCached}`);
  log(`capabilities cache: ${s.session.capabilities.slashCommands.length} slash commands, ${s.session.capabilities.skills.length} skills (cached=${s.session.capabilitiesCached})`);
  assert(s.gate.phase === "reviewing" && s.gate.blockedReason === null && s.gate.canSend, `pending review restored without blocking the input: ${s.gate.phase}/${s.gate.blockedReason}/${s.gate.canSend}`);
  assert(s.gate.turnStartTree === firstStartTree, "A restored");
  const restoredPaths = s.changedFiles.map((f) => f.path);
  assert(restoredPaths.includes("README.md") && restoredPaths.includes("v2.txt") && s.changedFiles.every((f) => f.state === "pending"), `restored files: ${JSON.stringify(s.changedFiles.map((f) => [f.path, f.state]))}`);
  assert(s.session.canRestart === true, "restart_session available");
  // §38.3: the turn left files to review, so its turn_summary row is recorded right after its turn_end.
  assert(restores.length === 2 && restores[1].length >= 3 && restores[1][0].kind === "user_message" && restores[1].at(-2).kind === "turn_end" && restores[1].at(-1).kind === "turn_summary", `transcript_restore after reopen: ${JSON.stringify(restores[1]?.map((i) => i.kind))}`);
  log(`restored review in ${Date.now() - tFreshBoot}ms: ${s.changedFiles.map((f) => `${f.path}[${f.state}]`).join(", ")}; transcript rows ${restores[1].length}`);
  // (session.sessionId is only known once the CLI answered a message: asserted after the follow-up turn below)

  // ---------------------------------------------------------------- restart_session keeps the gate (docs/PROTOCOL.md §8)
  await request({ type: "restart_session" });
  s = await waitState((x) => x.session.open && !x.session.starting && x.hud.turnCount === 0, "restarted");
  assert(s.gate.phase === "reviewing" && s.gate.restored === true && s.gate.turnStartTree === firstStartTree, `restart_session kept the gate: ${s.gate.phase}/${s.gate.restored}`);
  assert(s.changedFiles.map((f) => f.path).includes("v2.txt"), "pending files survive restart_session");
  log("restart_session: session resumed, review kept");

  const diff = await request({ type: "select_file", path: "README.md" });
  assert(diff.type === "file_diff" && diff.scope === "turn" && diff.diff.hunks.length > 0, "file_diff for README.md");
  const added = diff.diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add");
  assert(added.some((l) => l.text.includes("v2")), `README diff must add a 'v2' line: ${JSON.stringify(added.map((l) => l.text))}`);
  const full = await request({ type: "full_file", path: "README.md" });
  assert(full.type === "full_file_content" && full.changedNewLines.length > 0 && full.newText !== null, "full_file_content");

  await request({ type: "reject", paths: ["v2.txt"] });
  s = await waitState((x) => !x.changedFiles.some((f) => f.path === "v2.txt") && x.gate.phase === "reviewing", "v2.txt rejected");
  assert(!existsSync(join(REPO, "v2.txt")), "v2.txt must be gone after reject");
  assert(s.gate.lastReviewSummary?.includes("v2.txt"), "summary lists the rejected file");

  const line = added[0].newNo;
  await request({ type: "add_note", path: "README.md", line, side: "new", excerpt: added[0].text, body: "Use the exact text 'v2 (engine)' for this line." });
  s = await waitState((x) => x.reviewNotes.length === 1 && x.gate.canRequestChanges, "note added");
  const startTree = s.gate.turnStartTree;
  await request({ type: "request_changes", extra: "Only touch README.md. Do not run git commands." });
  s = await waitState((x) => x.gate.phase === "running" && x.gate.isRequestingChanges, "request_changes running");
  assert(s.changedFiles.find((f) => f.path === "README.md")?.state === "changesRequested", "README marked changesRequested");
  s = await waitState((x) => x.gate.phase === "reviewing" || x.gate.phase === "collect_failed", "follow-up turn end");
  assert(s.gate.phase === "reviewing", `follow-up: ${s.gate.phase} ${s.gate.collectError ?? ""}`);
  assert(s.gate.turnStartTree === startTree, "A is kept across request_changes");
  // §34.4: the follow-up collection keeps the sent note (marked `sent`, never sent again) until it is removed or the review ends.
  assert(!s.gate.isRequestingChanges && s.reviewNotes.length === 1 && s.reviewNotes[0].sent && s.gate.lastRequest?.notes === 1, `request-changes round finished: ${JSON.stringify([s.gate.isRequestingChanges, s.reviewNotes, s.gate.lastRequest])}`);
  log(`follow-up reviewing: ${s.changedFiles.map((f) => `${f.path}[${f.state}]`).join(", ")} · turns ${s.hud.turnCount} $${s.hud.sessionCostUSD.toFixed(4)}`);
  assert(s.session.sessionId === firstSessionId, `open_project + restart_session resumed the first session (${s.session.sessionId} vs ${firstSessionId})`);
  const readmeNow = readFileSync(join(REPO, "README.md"), "utf8");
  assert(readmeNow.includes("v2 (engine)"), `README must contain 'v2 (engine)':\n${readmeNow}`);
  assert(readmeNow.startsWith(readmeBefore.trimEnd()), "README keeps its original content");

  await request({ type: "accept_all" });
  s = await waitState((x) => x.gate.canSend && x.gate.phase === "idle", "gate open after accept_all");
  assert(s.gate.restored === false, "restored flag cleared by the follow-up turn");
  assert(s.branches.switchBlocker?.kind === "dirtyWorktree", `dirty worktree blocks switching (${JSON.stringify(s.branches.switchBlocker)})`);


  await request({ type: "switch_branch", name: "main" }).then(() => assert(false, "switch must be blocked"), (e) => assert(String(e.message).includes("switch_blocked:dirtyWorktree"), `blocked reason: ${e.message}`));

  // ---------------------------------------------------------------- commit (docs/PROTOCOL.md §7)
  assert(s.commit.canCommit && s.commit.acceptedPaths.includes("README.md"), `commit available for README.md: ${JSON.stringify(s.commit)}`);
  assert(s.commit.identity.name && s.commit.identity.email, `git identity known: ${JSON.stringify(s.commit.identity)}`);
  assert(s.commit.suggestedMessage.startsWith("Append a line 'v2'") && s.commit.suggestedMessage.includes("\n- README.md"), `suggested message: ${JSON.stringify(s.commit.suggestedMessage)}`);
  assert(s.commit.suggestedMessage.split("\n")[0].length <= 72, "subject ≤ 72 chars");
  await request({ type: "commit", message: "x", paths: ["v2.txt"] }).then(() => assert(false, "committing a non-accepted path must be refused"), (e) => assert(String(e.message).includes("nothing_to_commit"), `nothing_to_commit: ${e.message}`));
  const headBefore = git("rev-parse", "HEAD");
  const committed = await request({ type: "commit", message: "driver-v2: accepted README\n\nvia the engine", push: false });
  const head = git("rev-parse", "HEAD");
  assert(committed.type === "committed" && committed.sha === head && committed.shortSha === head.slice(0, 7) && committed.pushed === false && committed.branch === "main", `committed reply: ${JSON.stringify(committed)}`);
  assert(head !== headBefore, "HEAD moved");
  assert(git("log", "-1", "--format=%B").trim() === "driver-v2: accepted README\n\nvia the engine", `git log -1 message: ${JSON.stringify(git("log", "-1", "--format=%B"))}`);
  assert(git("show", "--name-only", "--format=", "HEAD").trim() === "README.md", `commit contains only README.md: ${git("show", "--name-only", "--format=", "HEAD")}`);
  s = await waitState((x) => x.commit.lastCommit?.sha === head, "state.commit.lastCommit");
  assert(s.commit.lastCommit.shortSha === head.slice(0, 7) && s.commit.lastCommit.pushed === false && s.commit.lastCommit.pushError === null, `lastCommit: ${JSON.stringify(s.commit.lastCommit)}`);
  assert(s.commit.lastCommit.files.length === 1 && s.commit.lastCommit.files[0] === "README.md" && s.commit.lastCommit.branch === "main", `lastCommit files/branch: ${JSON.stringify(s.commit.lastCommit)}`);
  assert(!s.changedFiles.some((f) => f.path === "README.md"), `README.md left the review: ${JSON.stringify(s.changedFiles.map((f) => f.path))}`);
  assert(!s.commit.canCommit && s.commit.acceptedPaths.length === 0, "nothing left to commit");
  assert(s.gate.phase === "idle" && s.gate.canSend, `gate open after the commit (${s.gate.phase})`);
  log(`committed ${s.commit.lastCommit.shortSha} on ${s.commit.lastCommit.branch}: ${git("log", "-1", "--oneline")}`);

  // ---------------------------------------------------------------- resume (docs/PROTOCOL.md §8): the conversation survived shutdown + open_project + restart_session
  transcript.length = 0;
  {
    const turnsBefore = s.hud.turnCount;
    await request({ type: "send", text: "What word did I ask you to remember earlier in this conversation? Reply with only that word. Do not use any tools." });
    s = await waitState((x) => x.hud.turnCount > turnsBefore && x.gate.phase !== "running" && x.gate.phase !== "collecting", "resume: answer");
  }
  const answer = transcript.join("").trim();
  assert(/pineapple/i.test(answer), `resume: expected 'pineapple' in the answer, got ${JSON.stringify(answer)}`);
  assert(s.gate.phase === "idle", `resume: no changes expected (phase=${s.gate.phase})`);
  log(`resume across processes + restart_session: answer=${JSON.stringify(answer.slice(0, 60))}`);

  assert(s.session.capabilitiesCached === false, "fresh session_info replaced the cached capabilities");

  // ---------------------------------------------------------------- M16 friction (docs/M16-FRICTION.md): read-only auto-allow, remember, accept-and-send
  const bashRequests = () => permissionRequests.filter((p) => p.toolName === "Bash");
  const bashUses = () => toolUses.filter((t) => t.name === "Bash");
  {
    permissionRequests.length = 0;
    toolUses.length = 0;
    const turnsBefore = s.hud.turnCount;
    await request({ type: "send", text: "Run exactly this shell command with the Bash tool and reply with its output only: git status" });
    s = await waitState((x) => x.hud.turnCount > turnsBefore && x.gate.phase !== "running" && x.gate.phase !== "collecting", "git status turn");
    assert(bashUses().some((t) => /git status/.test(String(t.input.command))), `Claude ran git status via Bash: ${JSON.stringify(bashUses().map((t) => t.input.command))}`);
    assert(bashRequests().length === 0, `read-only Bash must not prompt: ${JSON.stringify(bashRequests().map((p) => p.input.command))}`);
    log(`M16 read-only auto-allow: ${bashUses().length} Bash call(s), 0 permission_request`);
  }
  {
    permissionRequests.length = 0;
    toolUses.length = 0;
    rememberBash = true;
    const turnsBefore = s.hud.turnCount;
    await request({ type: "send", text: "Run exactly this shell command with the Bash tool (not the Write tool): echo hi > x.txt — then reply 'done'." });
    s = await waitState((x) => x.hud.turnCount > turnsBefore && x.gate.phase !== "running" && x.gate.phase !== "collecting", "echo > x.txt turn");
    rememberBash = false;
    const echoReq = bashRequests().find((p) => /echo/.test(String(p.input.command)) && />/.test(String(p.input.command)));
    assert(echoReq, `a write through Bash prompts: ${JSON.stringify(bashRequests().map((p) => p.input.command))}`);
    assert(s.session.rememberedAllows.includes("Bash:echo hi"), `remember:true stored Bash:echo hi: ${JSON.stringify(s.session.rememberedAllows)}`);
    assert(s.gate.phase === "reviewing" && s.changedFiles.some((f) => f.path === "x.txt" && f.state === "pending"), `x.txt pending: ${s.gate.phase} ${JSON.stringify(s.changedFiles.map((f) => [f.path, f.state]))}`);
    assert(s.gate.reviewSummary.files === s.changedFiles.length, `reviewSummary while reviewing: ${JSON.stringify(s.gate.reviewSummary)}`);
    log(`M16 remember: prompted for ${JSON.stringify(echoReq.input.command)}, rememberedAllows=${JSON.stringify(s.session.rememberedAllows)}`);
  }
  {
    // A question during the review (docs/PROTOCOL.md §10): a plain send is answered and changes nothing.
    const list = (x) => JSON.stringify(x.changedFiles.map((f) => [f.path, f.state, f.added, f.deleted]));
    const filesBefore = list(s);
    const treeBefore = s.gate.turnStartTree;
    assert(s.gate.canSend === true && s.gate.blockedReason === null, `reviewing leaves the input open: ${s.gate.canSend}/${s.gate.blockedReason}`);
    const turnsBeforeQuestion = s.hud.turnCount;
    await request({ type: "send", text: "How many files are waiting for my review right now? Reply with just the number. Change nothing." });
    s = await waitState((x) => x.hud.turnCount > turnsBeforeQuestion && x.gate.phase !== "running" && x.gate.phase !== "collecting", "question turn");
    assert(list(s) === filesBefore, `the question left the review list unchanged: ${filesBefore} → ${list(s)}`);
    assert(s.gate.turnStartTree === treeBefore, `snapshot A kept across the question turn: ${treeBefore} → ${s.gate.turnStartTree}`);
    assert(s.gate.phase === "reviewing", `still reviewing after the question: ${s.gate.phase}`);
    log(`question during review: ${s.changedFiles.length} file(s) still ${s.changedFiles.map((f) => `${f.path}[${f.state}]`).join(", ")}`);
  }
  {
    // accept-and-send while reviewing: x.txt is accepted, the turn runs; the remembered `echo hi` key does NOT cover the
    // redirection (§19.3), so the append prompts again (the driver allows it).
    permissionRequests.length = 0;
    toolUses.length = 0;
    const turnsBefore = s.hud.turnCount;
    await request({ type: "send", text: "Run exactly this shell command with the Bash tool: echo hi >> x.txt — then reply 'done'.", acceptPending: true });
    s = await waitState((x) => x.gate.phase === "running", "accept-and-send running");
    assert(!s.changedFiles.some((f) => f.state === "pending"), `acceptPending accepted every pending file: ${JSON.stringify(s.changedFiles.map((f) => [f.path, f.state]))}`);
    s = await waitState((x) => x.hud.turnCount > turnsBefore && x.gate.phase !== "running" && x.gate.phase !== "collecting", "echo >> x.txt turn");
    assert(bashUses().some((t) => /echo hi/.test(String(t.input.command))), `Claude ran echo via Bash: ${JSON.stringify(bashUses().map((t) => t.input.command))}`);
    assert(bashRequests().some((p) => /echo hi\s*>>/.test(String(p.input.command))), `a remembered key must not cover a redirection: ${JSON.stringify(bashRequests().map((p) => p.input.command))}`);
    assert(readFileSync(join(REPO, "x.txt"), "utf8") === "hi\nhi\n", `x.txt content: ${JSON.stringify(readFileSync(join(REPO, "x.txt"), "utf8"))}`);
    log(`M16 accept-and-send: turn ran, x.txt appended, the redirect was prompted again (§19.3)`);
    await request({ type: "forget_allows" });
    s = await waitState((x) => x.session.rememberedAllows.length === 0, "forget_allows");
    if (s.gate.phase === "reviewing") {
      await request({ type: "accept_all" });
      s = await waitState((x) => x.gate.canSend && x.gate.phase === "idle", "gate open after x.txt review");
    }
  }


  // ---------------------------------------------------------------- M20 permission modes: the plan proposal flow (docs/M20-MODES.md)
  {
    rmSync(join(REPO, CONTRIBUTING), { force: true });
    await request({ type: "set_permission_mode", mode: "plan" });
    s = await waitState((x) => x.session.permissionMode === "plan", "plan mode");
    assert(s.session.pendingPlan === null, "no plan pending before the planning turn");
    const outsideBefore = JSON.stringify(s.gate.changedOutside);
    const turnsBefore = s.hud.turnCount;
    planProposals.length = 0;
    permissionRequests.length = 0;
    toolUses.length = 0;
    toolResults.length = 0;
    await request({ type: "send", text: `Plan how to add a ${CONTRIBUTING} to this repository; do not write anything yet.` });
    s = await waitState((x) => x.hud.turnCount > turnsBefore && x.gate.phase !== "running" && x.gate.phase !== "collecting", "planning turn");
    assert(!permissionRequests.some((p) => p.toolName === "ExitPlanMode"), "ExitPlanMode never reaches the client as a permission card (the engine denies it)");
    // Cosmetic fix: the intercepted ExitPlanMode call and its deny must never reach the transcript
    // either — otherwise the deny renders as a red "tool error" row right under the plan card.
    assert(!toolUses.some((t) => t.name === "ExitPlanMode"), `no tool_use for ExitPlanMode: ${JSON.stringify(toolUses.map((t) => t.name))}`);
    assert(!toolResults.some((r) => r.preview.includes("Plan received")), `no tool_result carrying ExitPlanMode's deny: ${JSON.stringify(toolResults)}`);
    assert(planProposals.length === 1, `exactly one plan_proposed: ${planProposals.length}`);
    const plan = planProposals[0];
    assert(plan.plan.trim().length > 20, `plan text is non-empty: ${JSON.stringify(plan.plan.slice(0, 80))}`);
    assert(plan.path === null || plan.path.startsWith(`${process.env.HOME}/.claude/plans/`), `plan file lives in ~/.claude/plans: ${plan.path}`);
    assert(s.session.pendingPlan && s.session.pendingPlan.path === plan.path && s.session.pendingPlan.plan === plan.plan && s.session.pendingPlan.at, `pendingPlan mirrors the event: ${JSON.stringify(s.session.pendingPlan)?.slice(0, 120)}`);
    // Plan files are bookkeeping: never in changedOutside, never in the review.
    assert(plan.path === null || !s.gate.changedOutside.includes(plan.path), `the plan file must not be reported as an outside edit: ${JSON.stringify(s.gate.changedOutside)}`);
    assert(plan.path === null || !permissionRequests.some((p) => String(p.input.file_path ?? "") === plan.path), `the plan file write was auto-allowed, not prompted: ${JSON.stringify(permissionRequests.map((p) => [p.toolName, p.input.file_path]))}`);
    assert(JSON.stringify(s.gate.changedOutside) === outsideBefore, `the planning turn added no outside edits: ${outsideBefore} → ${JSON.stringify(s.gate.changedOutside)}`);
    assert(!s.changedFiles.some((f) => f.path === CONTRIBUTING), `plan mode wrote nothing into the repo: ${JSON.stringify(s.changedFiles.map((f) => f.path))}`);
    assert(!existsSync(join(REPO, CONTRIBUTING)), `${CONTRIBUTING} must not exist yet`);
    log(`M20 plan mode: ${plan.path} (${plan.plan.length} chars), review untouched`);

    const turnsBeforeImpl = s.hud.turnCount;
    await request({ type: "plan_response", approve: true, mode: "default" });
    s = await waitState((x) => x.session.permissionMode === "default", "mode switched by the approval");
    assert(s.session.pendingPlan === null, "pendingPlan cleared by the approval");
    s = await waitState((x) => x.hud.turnCount > turnsBeforeImpl && x.gate.phase !== "running" && x.gate.phase !== "collecting", "implementation turn");
    assert(s.gate.phase === "reviewing", `implementation turn ends in a review: ${s.gate.phase} ${s.gate.collectError ?? ""}`);
    const contributing = s.changedFiles.find((f) => f.path === CONTRIBUTING);
    assert(contributing && contributing.state === "pending", `${CONTRIBUTING} is pending in the review: ${JSON.stringify(s.changedFiles.map((f) => [f.path, f.state]))}`);
    assert(existsSync(join(REPO, CONTRIBUTING)) && readFileSync(join(REPO, CONTRIBUTING), "utf8").trim().length > 0, `${CONTRIBUTING} written`);
    planApproved = { path: plan.path, planChars: plan.plan.length, file: CONTRIBUTING, added: contributing.added };
    log(`M20 plan approved: follow-up turn created ${CONTRIBUTING} (+${contributing.added}), pending in the review`);
    await request({ type: "accept_all" });
    s = await waitState((x) => x.gate.canSend && x.gate.phase === "idle", "gate open after the plan review");
  }

  // ---------------------------------------------------------------- chat sessions (docs/M15-POLISH.md)
  assert(s.sessions.currentId === firstSessionId && s.sessions.list.length === 1, `one session so far: ${JSON.stringify(s.sessions)}`);
  const firstMeta = s.sessions.list[0];
  assert(firstMeta.title.startsWith("Append a line 'v2'") && firstMeta.title.length <= 60, `first title from the first message: ${JSON.stringify(firstMeta.title)}`);
  assert(firstMeta.turns >= 6 && firstMeta.costUSD > 0, `first meta accumulated: ${JSON.stringify(firstMeta)}`);
  assert(s.sessions.openTabIds.includes(firstSessionId), "first session is an open tab");
  const restoresBefore = restores.length;
  await request({ type: "session_new" });
  s = await waitState((x) => x.session.open && !x.session.starting && x.sessions.currentId !== firstSessionId, "new session");
  const secondSessionId = s.sessions.currentId;
  assert(restores.length === restoresBefore + 1 && restores.at(-1).length === 0, "session_new replays an empty transcript");
  assert(s.sessions.list.length === 2 && s.sessions.list[0].id === secondSessionId && s.sessions.list[0].title === "New chat", `New chat listed first: ${JSON.stringify(s.sessions.list.map((m) => [m.id, m.title]))}`);
  assert(s.hud.turnCount === 0 && s.gate.canSend, "fresh HUD + open gate in the new chat");
  transcript.length = 0;
  await request({ type: "send", text: "Reply pong only. Do not use any tools." });
  s = await waitState((x) => x.hud.turnCount === 1 && x.gate.phase !== "running" && x.gate.phase !== "collecting", "pong turn");
  const pong = transcript.join("").trim();
  assert(/pong/i.test(pong), `new chat answered: ${JSON.stringify(pong)}`);
  assert(s.session.sessionId === secondSessionId, `the CLI honoured the pre-chosen session id (${s.session.sessionId} vs ${secondSessionId})`);
  await request({ type: "session_list" });
  s = await waitState((x) => x.sessions.list.length === 2 && x.sessions.list.every((m) => m.title !== "New chat"), "session_list with titles");
  const titles = s.sessions.list.map((m) => [m.id, m.title, m.turns, Number(m.costUSD.toFixed(4))]);
  assert(s.sessions.list[0].id === secondSessionId && s.sessions.list[0].title === "Reply pong only. Do not use any tools." && s.sessions.list[0].turns === 1 && s.sessions.list[0].costUSD > 0, `second meta: ${JSON.stringify(titles)}`);
  assert(s.sessions.list[1].id === firstSessionId && s.sessions.list[1].title === firstMeta.title, `first meta kept: ${JSON.stringify(titles)}`);
  log(`sessions: ${JSON.stringify(titles)}`);
  await request({ type: "session_open", sessionId: firstSessionId });
  s = await waitState((x) => x.session.open && !x.session.starting && x.sessions.currentId === firstSessionId, "first session reopened");
  assert(restores.at(-1).length >= 2 && restores.at(-1)[0].kind === "user_message", `session_open replays the first transcript (${restores.at(-1).length} rows)`);
  transcript.length = 0;
  await request({ type: "send", text: "What word did I ask you to remember? Reply with only that word. Do not use any tools." });
  s = await waitState((x) => x.hud.turnCount === 1 && x.gate.phase !== "running" && x.gate.phase !== "collecting", "resume across sessions: answer");
  const answer2 = transcript.join("").trim();
  assert(/pineapple/i.test(answer2), `resume across sessions in one process: expected 'pineapple', got ${JSON.stringify(answer2)}`);
  assert(s.session.sessionId === firstSessionId, "still the first session");
  log(`resume across sessions (session_open): answer=${JSON.stringify(answer2.slice(0, 60))}`);
  await request({ type: "session_rename", sessionId: secondSessionId, title: "Pong chat" });
  await request({ type: "session_archive", sessionId: secondSessionId, archived: true });
  s = await waitState((x) => x.sessions.list.find((m) => m.id === secondSessionId)?.title === "Pong chat" && x.sessions.list.find((m) => m.id === secondSessionId)?.archived === true, "renamed + archived");
  await request({ type: "session_delete", sessionId: firstSessionId }).then(() => assert(false, "deleting the current session must be refused"), (e) => assert(String(e.message).includes("session_current"), `session_current: ${e.message}`));
  await request({ type: "tabs_set", openTabIds: [firstSessionId] });
  s = await waitState((x) => x.sessions.openTabIds.length === 1 && x.sessions.openTabIds[0] === firstSessionId, "tabs_set");
  await request({ type: "session_delete", sessionId: secondSessionId });
  s = await waitState((x) => x.sessions.list.length === 1, "second session deleted");
  assert(!existsSync(join(REPO, ".git", "reviewgate", "sessions", `${secondSessionId}.ndjson`)), "deleted session's transcript is gone");
  {
    // The session file is written behind the engine's persist chain: poll briefly.
    const deadline = Date.now() + 5000;
    let tabs = null;
    while (Date.now() < deadline) {
      try {
        tabs = JSON.parse(readFileSync(join(REPO, ".git", "reviewgate-session.json"), "utf8")).openTabIds;
        if (tabs.length === 1 && tabs[0] === firstSessionId) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(tabs && tabs.length === 1 && tabs[0] === firstSessionId, `openTabIds persisted: ${JSON.stringify(tabs)}`);
  }
  // refresh (M15): idle → branches/workbenches re-read.
  git("branch", "rg-refresh-probe");
  await request({ type: "refresh" });
  s = await waitState((x) => x.branches.list.some((b) => b.name === "rg-refresh-probe"), "refresh picked up the new branch");
  git("branch", "-q", "-D", "rg-refresh-probe");
  await request({ type: "refresh", scope: ["branches"] });
  s = await waitState((x) => !x.branches.list.some((b) => b.name === "rg-refresh-probe"), "refresh {branches} dropped it again");
  log("sessions: new/open/list/rename/archive/delete/tabs_set + refresh ok");
  // Anything else Claude left behind (settings, caches outside the ignore list) is swept up so branch switching is unblocked.
  if (git("status", "--porcelain")) {
    log(`leftover files after the commit: ${git("status", "--porcelain").split("\n").join(" | ")}`);
    await gitRetry("add", "-A");
    await gitRetry("commit", "-q", "-m", "driver-v2: leftovers");
  }
  await request({ type: "branches" });
  s = await waitState((x) => !x.branches.isWorktreeDirty && x.branches.switchBlocker === null, "clean worktree");
  assert(s.branches.list.some((b) => b.name === "main" && b.isCurrent), "branches lists main as current");
  await request({ type: "create_branch", name: BRANCH });
  s = await waitState((x) => x.project?.branch === BRANCH, `on ${BRANCH}`);
  assert(s.branches.list.find((b) => b.name === BRANCH)?.isCurrent === true, `${BRANCH} current`);
  await request({ type: "switch_branch", name: "main" });
  s = await waitState((x) => x.project?.branch === "main", "back on main");
  assert(git("rev-parse", "--abbrev-ref", "HEAD") === "main", "git agrees we are on main");

  // ---------------------------------------------------------------- workbenches (docs/PROTOCOL.md §6)
  s = await waitState((x) => x.workbenches.current === x.project.root && x.workbenches.list.length >= 1, "workbenches after open");
  const mainWb = s.workbenches.list[0];
  assert(mainWb.isMain && mainWb.isCurrent && mainWb.branch === "main", `main workbench row: ${JSON.stringify(mainWb)}`);
  assert(mainWb.locked?.pid === child.pid && mainWb.locked.client === "test", `our lock on the main worktree: ${JSON.stringify(mainWb.locked)}`);
  assert(s.workbenches.managedRoot.startsWith(WB_ROOT), `managedRoot under ${WB_ROOT}: ${s.workbenches.managedRoot}`);
  assert(s.lockConflict === null, "no lock conflict");
  await request({ type: "workbench_create", branch: WB_BRANCH });
  s = await waitState((x) => x.workbenches.list.some((w) => w.branch === WB_BRANCH), `workbench ${WB_BRANCH} listed`);
  const wb = s.workbenches.list.find((w) => w.branch === WB_BRANCH);
  assert(wb.path === join(s.workbenches.managedRoot, WB_BRANCH), `managed path: ${wb.path}`);
  assert(existsSync(join(wb.path, "README.md")), "workbench has the checkout");
  assert(!wb.isMain && !wb.isCurrent && wb.locked === null && wb.dirty === null, `fresh workbench row: ${JSON.stringify(wb)}`);
  assert(wb.head === git("rev-parse", "HEAD"), "workbench starts at this HEAD");
  assert(s.project.branch === "main" && s.branches.list.some((b) => b.name === WB_BRANCH), "branch created, we stay on main");
  await request({ type: "workbench_list" });
  s = await waitState((x) => x.workbenches.list.every((w) => w.dirty !== null), "dirty computed by workbench_list");
  assert(s.workbenches.list.find((w) => w.branch === WB_BRANCH).dirty === false, "new workbench is clean");
  await request({ type: "workbench_create", branch: WB_BRANCH }).then(() => assert(false, "duplicate create must be refused"), (e) => assert(String(e.message).includes(`branch_in_use:${wb.path}`), `branch_in_use: ${e.message}`));
  await request({ type: "workbench_create", branch: "bad..name" }).then(() => assert(false, "invalid name must be refused"), (e) => assert(String(e.message).includes("invalid_branch_name:"), `invalid_branch_name: ${e.message}`));
  await request({ type: "workbench_remove", path: REPO }).then(() => assert(false, "removing main must be refused"), (e) => assert(String(e.message).includes("cannot_remove_main"), `cannot_remove_main: ${e.message}`));
  await request({ type: "workbench_remove", path: wb.path });
  s = await waitState((x) => !x.workbenches.list.some((w) => w.branch === WB_BRANCH), "workbench removed");
  assert(!existsSync(wb.path), "workbench directory is gone");
  assert(!git("worktree", "list", "--porcelain").includes(wb.path), "git agrees the worktree is gone");
  assert(git("branch", "--list", WB_BRANCH) !== "", "the branch survives the worktree");
  git("branch", "-q", "-D", WB_BRANCH);
  log(`workbench ${WB_BRANCH} created at ${wb.path}, listed, removed`);

  const running = procs();
  assert(running.length >= 1, `sidecar/claude should be running before shutdown: ${running.join(" | ")}`);
  const tShutdown = Date.now();
  await request({ type: "shutdown" });
  const { code, signal } = await exited;
  const shutdownMs = Date.now() - tShutdown;
  assert(code === 0 && signal === null, `sidecar exit ${code} ${signal}`);
  await new Promise((r) => setTimeout(r, 1500));
  const orphans = procs();
  assert(orphans.length === 0, `orphaned processes after shutdown:\n${orphans.join("\n")}`);
  assert(!existsSync(join(REPO, ".git", "reviewgate.lock")), "lock released on shutdown");
  assert(!existsSync(reviewFile), "review file removed once the review was fully resolved");
  assert(git("for-each-ref", "refs/reviewgate/main/turn-start", "refs/reviewgate/main/turn-end") === "", "turn-start/turn-end refs removed once the review was fully resolved");
  // Completed rounds stay in the review history with their trees pinned (§14).
  const historyRefs = git("for-each-ref", "--format=%(refname)", "refs/reviewgate/main/history/");
  assert(historyRefs.length > 0 && existsSync(join(REPO, ".git", "reviewgate", "history.json")), "review history persisted with pinned trees");

  log("PASS");
  console.log(JSON.stringify({
    ok: true,
    totalMs: Date.now() - t0,
    shutdownMs,
    exitCode: code,
    stateCount,
    maxStateBytes,
    turns: s.hud.turnCount,
    sessionCostUSD: Number(s.hud.sessionCostUSD.toFixed(4)),
    contextTokens: s.hud.contextTokens,
    contextWindow: s.hud.contextWindow,
    model: s.session.model,
    claudeVersion: s.toolchain.claudeVersion,
    orphans: orphans.length,
    workbench: { branch: WB_BRANCH, path: wb.path, removed: !existsSync(wb.path) },
    commit: { sha: head, shortSha: head.slice(0, 7), branch: "main" },
    sidecars: sidecarNo,
    resumedSessionId: firstSessionId,
    resumeAnswer: answer.slice(0, 60),
    sessions: { second: secondSessionId, pong: pong.slice(0, 40), resumeAcrossSessionsAnswer: answer2.slice(0, 60), listed: titles },
    changedOutsideFirstTurn: outsideFirstTurn,
    m16: { budget: s.budget, rememberedAllowsAtEnd: s.session.rememberedAllows, capabilitiesCachedAtEnd: s.session.capabilitiesCached },
    m20: { ...planApproved, permissionModeAtEnd: s.session.permissionMode, pendingPlanAtEnd: s.session.pendingPlan },
  }, null, 2));
}

main().catch(async (e) => {
  log(`FAIL: ${e.message}`);
  process.exitCode = 1;
  try {
    send({ type: "shutdown" });
  } catch {}
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
  process.exit(1);
});
