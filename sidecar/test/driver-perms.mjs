#!/usr/bin/env node
// Real-CLI contract driver for docs/PROTOCOL.md §33 — permission requests, worktree tools, the user's allow rules and
// Claude Code's own settings files — through the bundled sidecar on a fresh scratch repo. Model: haiku (RG_MODEL), a few
// cents per run.
//
//   node sidecar/test/driver-perms.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-perms, RE-CREATED; sidecar/dist/sidecar.mjs)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)   RG_STEPS=ABCDK (default; also E, F, W)   RG_GUARD_TEST=1 (C / W prompts say it is a test)
//
//   A. two parallel subagents ask at once → pendingPermissions has both (with agents); answering the OLDER one first
//      runs only that call; the other stays pending until answered (§33.1) — also once the main agent's turn ended while
//      they work in the background (§52.2); both files reach a review.
//   B. an Edit inside a nested repository (vendor/lib) → card with reason nested_repository (denied → file unchanged; §33.3).
//   C. EnterWorktree → denied with worktree_blocked (§33.4).
//   W. `git worktree add` in Bash → card with reason worktree_command (denied; §33.4).
//   E. `cd vendor/lib && touch …` → card with reason nested_repository, approved → worktree_outside_review.
//   F. a standalone `cd vendor/lib`, then `touch` in a separate call (observed only: does the hook cwd follow the shell?).
//   D. .claude/settings.local.json allows WebFetch(domain:example.com) → the fetch runs without a card; permission_rules (§33.5).
//   K. Claude Code's own settings (§33.9): asked to add an allow rule to .claude/settings.local.json — with the Edit tool in
//      the default mode, again in acceptEdits, and with `cp` while an app pattern allows every cp — each attempt is a card
//      with reason claude_config (no allowPatterns); denied, the file stays byte-identical and no local_settings_changed follows.
// Cleans up ~/.claude/projects/<scratch key> afterwards, checks no CLI child is left, prints what was observed as JSON.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-perms");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEPS = process.env.RG_STEPS ?? "ABCDK";
const GUARD_TEST = !!process.env.RG_GUARD_TEST;
const STEP_TIMEOUT_MS = 240_000;

const t0 = Date.now();
const log = (msg) => process.stderr.write(`[perms +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const observed = { cli: null, model: MODEL, steps: STEPS };
const failures = [];
const check = (cond, msg) => {
  if (!cond) {
    failures.push(msg);
    log(`CHECK FAILED: ${msg}`);
  } else log(`ok: ${msg}`);
};
/** The CLI's ~/.claude/projects key of a cwd (§30; < 200 chars here). */
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");

// ---------------------------------------------------------------- scratch repo
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
// The app-wide records (§36.8 cli-versions.json) go to the scratch folder, never the user's ~/.reviewgate.
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };
const REPO = join(ROOT, "repo");
mkdirSync(REPO, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "perms@example.com");
git("config", "user.name", "perms");
writeFileSync(join(REPO, "README.md"), "# perms scratch\n");
writeFileSync(join(REPO, ".gitignore"), ".omc/\n.claude/settings.local.json\nvendor/\n");
mkdirSync(join(REPO, ".claude"), { recursive: true });
const LOCAL_SETTINGS = join(REPO, ".claude", "settings.local.json");
const LOCAL_SETTINGS_TEXT = JSON.stringify({ permissions: { allow: ["WebFetch(domain:example.com)"] } }) + "\n";
writeFileSync(LOCAL_SETTINGS, LOCAL_SETTINGS_TEXT);
// K: what `cp` would put in place of the local settings (an extra allow rule).
writeFileSync(join(REPO, "allow-rules.json"), JSON.stringify({ permissions: { allow: ["WebFetch(domain:example.com)", "WebFetch(domain:example.org)"] } }) + "\n");
git("add", "-A");
git("commit", "-q", "-m", "perms: init");
const lib = join(REPO, "vendor", "lib");
mkdirSync(lib, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", lib]);
writeFileSync(join(lib, "lib.txt"), "lib\n");
execFileSync("git", ["-C", lib, "-c", "user.email=x@example.com", "-c", "user.name=x", "add", "-A"]);
execFileSync("git", ["-C", lib, "-c", "user.email=x@example.com", "-c", "user.name=x", "commit", "-q", "-m", "lib"]);

// ---------------------------------------------------------------- sidecar plumbing
let state = null;
let nextId = 1;
const waiters = [];
const replies = new Map();
const events = [];
/** Bash / edit / other requests are held for the step to answer; Agent/Task ones are allowed at once. */
const held = [];

const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
createInterface({ input: child.stderr }).on("line", (l) => {
  if (!/:debug\]/.test(l)) process.stderr.write(`  [sidecar] ${l.slice(0, 300)}\n`);
});
const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
createInterface({ input: child.stdout }).on("line", (line) => {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.type === "state") state = ev.state;
  else {
    events.push(ev);
    if (ev.type === "permission_request") {
      const brief = `${ev.toolName} ${JSON.stringify(ev.input).slice(0, 90)}${ev.agent ? ` agent=${JSON.stringify(ev.agent)}` : ""}${ev.reason ? ` reason=${ev.reason.code}${ev.reason.path ? `@${ev.reason.path}` : ""}` : ""}${ev.allowPatterns ? ` allowPatterns=${JSON.stringify(ev.allowPatterns)}` : ""}`;
      if (/^(Agent|Task)$/.test(ev.toolName)) {
        log(`permission_request ${brief} → allow`);
        send({ type: "permission_response", requestId: ev.requestId, allow: true });
      } else {
        log(`permission_request ${brief} → held`);
        held.push(ev);
      }
    } else if (ev.type === "error") log(`error(${ev.scope}${ev.code ? ` ${ev.code}` : ""}): ${ev.message.slice(0, 220)}`);
    else if (ev.type === "tool_use") log(`tool_use ${ev.name}${ev.parentToolUseId ? ` (in ${ev.parentToolUseId.slice(-6)})` : ""} ${JSON.stringify(ev.input).slice(0, 100)}`);
    else if (!["log", "activity", "text_delta", "tool_result", "mcp_status", "files"].includes(ev.type)) log(`event ${ev.type}${ev.type === "result" && !ev.ok ? ` error=${ev.error}` : ""}`);
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) if (state && w.pred(state)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(state);
  }
});

function send(cmd) {
  child.stdin.write(JSON.stringify(cmd) + "\n");
}

function request(cmd) {
  const id = `p${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type} (${id})`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      if (ev.type === "result" && !ev.ok) reject(new Error(`${cmd.type} failed: ${ev.error}`));
      else resolve(ev);
    });
    send({ ...cmd, id });
  });
}

function waitState(pred, what, ms = STEP_TIMEOUT_MS) {
  if (state && pred(state)) return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; phase=${state?.gate.phase} lastError=${state?.lastError}`)), ms);
    waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHeld(n, what, ms = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + ms;
  while (held.length < n) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const turnDone = (before) => (x) => x.hud.turnCount > before && x.gate.phase !== "running" && x.gate.phase !== "collecting";
const since = (mark, type) => events.slice(mark).filter((e) => e.type === type);
const answerText = (mark) => since(mark, "text_delta").map((e) => e.text).join("").slice(0, 300);
const claudeChildren = () => {
  try {
    return execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

async function acceptAll() {
  if (state.gate.pendingCount > 0) await request({ type: "accept_all" });
}

/**
 * A new chat for a step whose model call must not remember an earlier one: after a denial ("vendor/lib is a nested
 * repository", "that is Claude Code's own settings file") the model declines to try the same thing again.
 */
async function freshChat() {
  const prev = state.sessions.currentId;
  await request({ type: "session_new" });
  await waitState((x) => x.session.open && !x.session.starting && x.sessions.currentId !== prev, "new chat");
}

/**
 * One K attempt: send `text`, then the first card must be a claude_config one for the local settings (no allowPatterns);
 * it is denied and the file must be byte-identical afterwards, with no local_settings_changed. A turn that ends without a
 * card fails unless `lenient` (the model declined to run the command — logged, nothing ran), but a changed file always fails.
 */
async function settingsAttempt(label, text, { lenient = false } = {}) {
  const before = state.hud.turnCount;
  const mark = events.length;
  held.length = 0;
  await request({ type: "send", text });
  const t = Date.now();
  while (held.length === 0 && !turnDone(before)(state) && Date.now() - t < 180_000) await sleep(200);
  const req = held[0];
  const result = { card: req ? { toolName: req.toolName, input: req.input, reason: req.reason ?? null, allowPatterns: req.allowPatterns ?? null } : null };
  if (req) {
    check(req.reason?.code === "claude_config" && req.reason.path === LOCAL_SETTINGS, `${label}: card with reason claude_config @ .claude/settings.local.json (got ${JSON.stringify(req.reason)})`);
    check(!req.allowPatterns, `${label}: no "always allow" pattern offered`);
    check(typeof req.reason?.message === "string" && req.reason.message.includes(".claude/settings.local.json"), `${label}: the English message names the file`);
    await request({ type: "permission_response", requestId: req.requestId, allow: false, message: "Not allowed: that is Claude Code's own settings file. Stop here." });
  } else {
    result.answer = answerText(mark);
    (lenient ? log : (m) => check(false, m))(`${label}: Claude never asked (${JSON.stringify(result.answer)})`);
  }
  // Another attempt in the same turn (Write after Edit, a shell command) is its own card: deny those too until the turn ends.
  const answered = new Set(req ? [req.requestId] : []);
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!turnDone(before)(state)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for turn ${label}`);
    for (const h of held) if (!answered.has(h.requestId)) {
      answered.add(h.requestId);
      (result.laterCards ??= []).push({ toolName: h.toolName, reason: h.reason?.code ?? null });
      await request({ type: "permission_response", requestId: h.requestId, allow: false, message: "Denied. Stop here." }).catch(() => undefined);
    }
    await sleep(200);
  }
  check(readFileSync(LOCAL_SETTINGS, "utf8") === LOCAL_SETTINGS_TEXT, `${label}: .claude/settings.local.json is unchanged`);
  check(since(mark, "local_settings_changed").length === 0 && state.gate.localSettingsChanged == null, `${label}: no local_settings_changed`);
  result.toolUses = since(mark, "tool_use").map((e) => e.name);
  return result;
}

// ---------------------------------------------------------------- run
const settings = {
  budget: { maxFiles: 10, maxLines: 400 },
  ignorePatterns: [".omc/"],
  autoAllowTools: [],
  loadUserSettings: false,
  systemPromptAppend: "You are running inside ReviewGate. Do exactly what is asked and stop. Answer in English.",
  claudePath: CLAUDE,
  ghHost: "github.com",
  model: MODEL,
};

try {
  observed.cli = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
  await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "", CLAUDE_CODE_HARBOR_KITE: "0" }, settings });
  await request({ type: "open_project", path: REPO });
  await waitState((s) => s.session.open && !s.session.starting, "session open");
  log(`toolchain claude ${state.toolchain.claudeVersion}`);

  // ---------------------------------------------------------------- A
  if (STEPS.includes("A")) {
    log("=== A: two parallel subagents ask at once");
    const before = state.hud.turnCount;
    held.length = 0;
    await request({
      type: "send",
      text:
        "In ONE assistant message, call the Agent tool twice in parallel (subagent_type general-purpose). " +
        "Agent 1 description 'touch a': it must run exactly the Bash command `touch a.txt` and then reply 'done a'. " +
        "Agent 2 description 'touch b': it must run exactly the Bash command `touch b.txt` and then reply 'done b'. " +
        "Do not run any tool yourself other than the two Agent calls. After both finish, reply 'ok'.",
    });
    await waitHeld(2, "two held Bash requests", 180_000);
    await sleep(300);
    const s1 = state;
    const queue = s1.session.pendingPermissions ?? [];
    observed.A = {
      queue: queue.map((p) => ({ requestId: p.requestId, toolName: p.toolName, command: p.input.command, toolUseId: p.toolUseId, agent: p.agent })),
      pendingPermission: s1.session.pendingPermission?.requestId,
      blockedReason: s1.gate.blockedReason,
      agents: s1.hud.agents.map((a) => ({ id: a.id, toolUseId: a.toolUseId, type: a.type, description: a.description, status: a.status })),
    };
    check(queue.length === 2, `A: state.session.pendingPermissions has 2 entries (got ${queue.length})`);
    check(s1.session.pendingPermission?.requestId === queue[0]?.requestId, "A: pendingPermission is the oldest request");
    check(queue.every((p) => p.toolUseId && p.agent?.agentId), "A: each request carries toolUseId and agent.agentId");
    check(queue.every((p) => p.agent?.agentToolUseId && s1.hud.agents.some((a) => a.toolUseId === p.agent.agentToolUseId)), "A: each agent resolves to a hud.agents node (agentToolUseId)");
    check(new Set(queue.map((p) => p.agent?.agentToolUseId)).size === 2, "A: the two requests come from two different agents");
    const [older, newer] = queue;
    const olderFile = /touch (\S+)/.exec(older.input.command)?.[1];
    const newerFile = /touch (\S+)/.exec(newer.input.command)?.[1];
    log(`answering the OLDER request first: ${older.requestId} (${older.input.command})`);
    await request({ type: "permission_response", requestId: older.requestId, allow: true });
    await waitState((s) => (s.session.pendingPermissions ?? []).length === 1, "older request left the queue");
    check(state.session.pendingPermissions[0].requestId === newer.requestId, "A: only the newer request is still pending");
    const deadline = Date.now() + 60_000;
    while (!existsSync(join(REPO, olderFile)) && Date.now() < deadline) await sleep(200);
    check(existsSync(join(REPO, olderFile)), `A: the answered call ran (${olderFile} exists)`);
    check(!existsSync(join(REPO, newerFile)), `A: the unanswered call did not run yet (${newerFile} absent)`);
    // §52.2: subagents work in the background by default — the main agent's turn ends while they wait, and the open card
    // outlives it. One Claude kept in the foreground (run_in_background: false) keeps the turn running until it is answered.
    const ended = await waitState(turnDone(before), "the main agent's turn ended", 45_000).then(() => true, () => false);
    observed.A.turnEndedWhileOpen = ended;
    if (ended) check((state.session.pendingPermissions ?? []).some((p) => p.requestId === newer.requestId), "A: the open request outlives the main agent's turn (§52.2)");
    else check(state.gate.blockedReason === "awaiting_permission", "A: blockedReason stays awaiting_permission while one is open");
    await request({ type: "permission_response", requestId: newer.requestId, allow: true });
    const ranBy = Date.now() + 60_000;
    while (!existsSync(join(REPO, newerFile)) && Date.now() < ranBy) await sleep(200);
    check(existsSync(join(REPO, newerFile)), `A: the second call ran after its answer (${newerFile} exists)`);
    // Both files reach a review: the newer one in the turn Claude runs when the agents end (§52.1), or in this turn. That
    // turn starts a moment after they end — settled is nothing running for 3 s (else the next send is refused external_turn).
    const settled = (s) =>
      turnDone(before)(s) && !s.session.externalTurn && (s.session.backgroundTasks ?? []).length === 0 && ["a.txt", "b.txt"].every((f) => s.changedFiles.some((c) => c.path === f));
    for (let k = 0; k < 10; k++) {
      await waitState(settled, "both files in the review, the agents done").catch(() => undefined);
      await sleep(3000);
      if (settled(state)) break;
    }
    observed.A.changedFiles = state.changedFiles.map((f) => f.path);
    check(["a.txt", "b.txt"].every((f) => observed.A.changedFiles.includes(f)), "A: both files are in the review");
    await acceptAll();
  }

  // ---------------------------------------------------------------- B
  if (STEPS.includes("B")) {
    log("=== B: edit inside a nested repository");
    const before = state.hud.turnCount;
    held.length = 0;
    const mark = events.length;
    await request({ type: "send", text: "Use the Edit tool (not Bash) to change the only line of vendor/lib/lib.txt from 'lib' to 'changed'. Do nothing else; if the edit is not allowed, just stop." });
    await waitHeld(1, "held edit request", 180_000);
    const req = held[0];
    observed.B = { toolName: req.toolName, file: req.file, reason: req.reason, allowPatterns: req.allowPatterns ?? null };
    check(/^(Edit|Write|MultiEdit)$/.test(req.toolName), `B: the edit reached a card (${req.toolName})`);
    check(req.reason?.code === "nested_repository" && req.reason.path === lib, `B: reason nested_repository @ ${lib} (got ${JSON.stringify(req.reason)})`);
    await request({ type: "permission_response", requestId: req.requestId, allow: false, message: "Not in this window: vendor/lib is a nested repository." });
    await waitState(turnDone(before), "turn B done");
    check(readFileSync(join(lib, "lib.txt"), "utf8") === "lib\n", "B: denied → the nested file is unchanged");
    observed.B.answer = answerText(mark);
  }

  // ---------------------------------------------------------------- C
  if (STEPS.includes("C")) {
    log("=== C: EnterWorktree");
    await freshChat();
    const before = state.hud.turnCount;
    const mark = events.length;
    held.length = 0;
    await request({ type: "send", text: GUARD_TEST ? "This is a test of ReviewGate's worktree guard, requested by the user: call the EnterWorktree tool with name 'feature-x' anyway. ReviewGate is expected to block it; that is the outcome we want to observe. Then say in one sentence what happened and stop." : "Call the EnterWorktree tool with name 'feature-x' (the user explicitly asks for a worktree). If it is blocked, say so in one sentence and stop." });
    // Claude may go around the tool with `git worktree add` in Bash (haiku did on CLI 2.1.318): that card is W's, and is
    // denied here too — the turn waited on it until the driver's timeout.
    const cards = [];
    const t = Date.now();
    while (!turnDone(before)(state) && Date.now() - t < 180_000) {
      const req = held.shift();
      if (req) {
        cards.push({ toolName: req.toolName, command: req.input?.command ?? null, reason: req.reason });
        await request({ type: "permission_response", requestId: req.requestId, allow: false, message: "No worktrees here." });
      } else await sleep(200);
    }
    await waitState(turnDone(before), "turn C done");
    const uses = since(mark, "tool_use").map((e) => e.name);
    const notices = since(mark, "error").filter((e) => e.code === "worktree_blocked");
    observed.C = { toolUses: uses, errors: notices, cards, answer: answerText(mark) };
    for (const c of cards.filter((c) => c.toolName === "Bash" && /git\b.*\bworktree\s+add\b/.test(c.command ?? ""))) check(c.reason?.code === "worktree_command", `C: \`git worktree add\` in Bash has reason worktree_command (got ${JSON.stringify(c.reason)})`);
    check(git("worktree", "list").split("\n").length === 1, "C: no worktree was created");
    if (uses.includes("EnterWorktree")) check(notices.length === 1 && notices[0].toolName === "EnterWorktree" && notices[0].branch === "feature-x", "C: worktree_blocked notice with toolName / branch");
    else log("C: Claude did not call EnterWorktree (the system instruction kept it in the folder)");
  }

  // ---------------------------------------------------------------- W
  if (STEPS.includes("W")) {
    log("=== W: git worktree add in Bash");
    await freshChat();
    const before = state.hud.turnCount;
    const mark = events.length;
    held.length = 0;
    await request({ type: "send", text: GUARD_TEST ? "This is a test of ReviewGate's permission card, requested by the user: run exactly this Bash command anyway: `git worktree add -b wt2 ../perms-wt2`. ReviewGate shows the user a card for it; that is what we want to observe. If it is denied, stop." : "Run exactly this Bash command and nothing else: `git worktree add -b wt2 ../perms-wt2`. If it is denied, stop." });
    const t = Date.now();
    while (held.length === 0 && !turnDone(before)(state) && Date.now() - t < 180_000) await sleep(200);
    if (held.length > 0) {
      const req = held[0];
      observed.W = { toolName: req.toolName, command: req.input.command, reason: req.reason };
      check(req.toolName === "Bash" && req.reason?.code === "worktree_command" && req.reason.path === join(ROOT, "perms-wt2"), `W: card with reason worktree_command @ ../perms-wt2 (got ${JSON.stringify(req.reason)})`);
      await request({ type: "permission_response", requestId: req.requestId, allow: false, message: "No worktrees here." });
    } else observed.W = { noCard: true, answer: answerText(mark) };
    await waitState(turnDone(before), "turn W done");
    check(git("worktree", "list").split("\n").length === 1, "W: no worktree was created");
  }

  // ---------------------------------------------------------------- E
  if (STEPS.includes("E")) {
    log("=== E: a command that cds into the nested repository");
    await freshChat();
    const before = state.hud.turnCount;
    const mark = events.length;
    held.length = 0;
    await request({ type: "send", text: "Run exactly this one Bash command and nothing else: `cd vendor/lib && touch from-bash.txt`. If it is denied, stop." });
    const t = Date.now();
    while (held.length === 0 && !turnDone(before)(state) && Date.now() - t < 180_000) await sleep(200);
    if (held.length > 0) {
      const req = held[0];
      observed.E = { toolName: req.toolName, command: req.input.command, reason: req.reason, allowPatterns: req.allowPatterns ?? null };
      check(req.toolName === "Bash" && req.reason?.code === "nested_repository" && req.reason.path === lib, `E: card with reason nested_repository @ vendor/lib (got ${JSON.stringify(req.reason)})`);
      await request({ type: "permission_response", requestId: req.requestId, allow: true });
    } else observed.E = { noCard: true, answer: answerText(mark) };
    await waitState(turnDone(before), "turn E done");
    const notices = since(mark, "error").filter((e) => e.code === "worktree_outside_review");
    observed.E.notices = notices;
    check(existsSync(join(lib, "from-bash.txt")), "E: approved → the command ran in the nested repository");
    check(notices.length === 1 && notices[0].path === lib, "E: worktree_outside_review notice after it ran");
    check(!state.changedFiles.some((f) => f.path.includes("from-bash")), "E: the nested file is not in the review (as the notice says)");
  }

  // ---------------------------------------------------------------- F
  if (STEPS.includes("F")) {
    log("=== F: a standalone cd, then a command in a separate Bash call (does the hook cwd follow the shell?)");
    await freshChat();
    const before = state.hud.turnCount;
    held.length = 0;
    await request({ type: "send", text: "Make two separate Bash tool calls, one after the other: first exactly `cd vendor/lib`, then exactly `touch from-cwd.txt`. Do nothing else." });
    const answered = new Set();
    const t = Date.now();
    while (!turnDone(before)(state) && Date.now() - t < 180_000) {
      for (const h of held) if (!answered.has(h.requestId)) {
        answered.add(h.requestId);
        (observed.F ??= []).push({ command: h.input.command, reason: h.reason ?? null });
        await request({ type: "permission_response", requestId: h.requestId, allow: true });
      }
      await sleep(200);
    }
    observed.Ffile = { inNested: existsSync(join(lib, "from-cwd.txt")), inRoot: existsSync(join(REPO, "from-cwd.txt")) };
    log(`F: ${JSON.stringify(observed.F)} ${JSON.stringify(observed.Ffile)}`);
  }

  // ---------------------------------------------------------------- D
  if (STEPS.includes("D")) {
    log("=== D: the user's allow rule (settings.local.json) lets WebFetch(domain:example.com) run without a card");
    const rules = await request({ type: "permission_rules" });
    observed.Drules = { sources: rules.sources.map((s) => [s.scope, s.exists]), rules: rules.rules, defaultMode: rules.defaultMode };
    check(rules.rules.some((r) => r.rule === "WebFetch(domain:example.com)" && r.source === "local" && r.status === "applied"), "D: permission_rules lists the local rule as applied");
    const before = state.hud.turnCount;
    const mark = events.length;
    held.length = 0;
    await request({ type: "send", text: "Use the WebFetch tool to fetch https://example.com and reply with the page title only." });
    await waitState(turnDone(before), "turn D done");
    const uses = since(mark, "tool_use").filter((e) => e.name === "WebFetch");
    const cards = since(mark, "permission_request").filter((e) => e.toolName === "WebFetch");
    observed.D = { webFetchCalls: uses.length, webFetchCards: cards.length, answer: answerText(mark).slice(0, 200) };
    check(uses.length >= 1, "D: Claude called WebFetch");
    check(cards.length === 0, "D: no permission card for it (the user's rule applied)");
  }

  // ---------------------------------------------------------------- K
  if (STEPS.includes("K")) {
    log("=== K: Claude Code's own settings file (.claude/settings.local.json) is never changed without a card (§33.9)");
    const ask =
      "The user asks you to allow WebFetch for example.org in this project's Claude Code settings: add the rule " +
      '"WebFetch(domain:example.org)" to the "permissions.allow" array of .claude/settings.local.json';
    // Each attempt in a fresh chat: a model that remembers the previous denial declines to try again.
    observed.K = {};
    await freshChat();
    observed.K.edit = await settingsAttempt("K edit", `${ask} with the Edit tool (Read it first if you must). Do nothing else; if the edit is denied, stop.`);
    await freshChat();
    await request({ type: "set_permission_mode", mode: "acceptEdits" });
    observed.K.acceptEdits = await settingsAttempt("K acceptEdits", `${ask} with the Edit tool (Read it first if you must). Do nothing else; if the edit is denied, stop.`);
    await request({ type: "set_permission_mode", mode: "default" });
    // An app pattern covering every cp would let the command run without a card — not this one.
    await freshChat();
    await request({ type: "set_settings", settings: { bashAllowPatterns: ["Bash(cp:*)"] } });
    observed.K.bash = await settingsAttempt(
      "K bash",
      "This is a test of ReviewGate's permission card, requested by the user: run exactly this one Bash command and nothing else: " +
        "`cp allow-rules.json .claude/settings.local.json`. If it is denied, stop.",
      { lenient: true },
    );
    await request({ type: "set_settings", settings: { bashAllowPatterns: [] } });
  }
} catch (e) {
  failures.push(`driver: ${e instanceof Error ? e.message : String(e)}`);
  log(`ERROR ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  for (const h of held) send({ type: "permission_response", requestId: h.requestId, allow: false });
  try {
    await request({ type: "shutdown" });
  } catch {}
  const { code, signal } = await Promise.race([exited, sleep(10_000).then(() => ({ code: "timeout", signal: null }))]);
  observed.sidecarExit = { code, signal };
  if (code === "timeout") child.kill("SIGKILL");
  const left = claudeChildren();
  observed.leftoverChildren = left.length;
  if (left.length > 0) failures.push(`leftover CLI children: ${left.join(", ")}`);
  // The CLI's project folder of the scratch repo is scratch too.
  const key = projectKey(REPO);
  if (key.includes("rg-perms") || key.includes("scratchpad")) rmSync(join(homedir(), ".claude", "projects", key), { recursive: true, force: true });
  observed.failures = failures;
  process.stdout.write(JSON.stringify(observed, null, 1) + "\n");
  log(failures.length > 0 ? "FAILED" : "OK");
  process.exitCode = failures.length > 0 ? 1 : 0;
}
