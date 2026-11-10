#!/usr/bin/env node
// MARK: r1-git — real-CLI check for docs/PROTOCOL.md §46 / §31.3 / §39.5: git in auto mode runs as in the terminal.
//
//   RG_MODEL=sonnet node sidecar/test/driver-gitauto.mjs [scratchDir] [sidecar.mjs]
//     scratchDir: default ~/rg-driver-scratch/gitauto (or $RG_DRIVER_SCRATCH/gitauto) — RE-CREATED and removed at the end. Never under /tmp,
//     /private/tmp or /var/folders: the engine's git instruction tells Claude to refuse a worktree there.
//   CLAUDE_PATH=… (default ~/.local/bin/claude). Auto mode needs a model that has it (sonnet; haiku has none).
//
// A scratch repository with a local bare `origin` and a project skill `acme-commit` whose `allowed-tools` are
// `Bash(git add:*), Bash(git commit:*)`, through the bundled sidecar in auto mode (user settings off). Three turns:
//   1. "make branch feature/acme-7, fix App.java, commit, push -u" → no permission_request; the branch is on origin;
//      turn_end keeps App.java in the review with committedIn = the new commit; no head-moved bar (head_moved explainedBy
//      claude_git, a claude_committed row).
//   2. "git reset --hard origin/main" → exactly one permission_request, reason git_command (denied: nothing moves).
//   3. "add a line to NOTES.md, then commit it with the acme-commit skill" → the skill's allowed-tools let its commit run
//      without a card; NOTES.md stays in the review with committedIn.
// Removes the scratch conversations under ~/.claude/projects, checks no CLI child is left, prints what it saw as JSON.
// RG_KEEP_SCRATCH=1 keeps the scratch folder.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(process.env.RG_DRIVER_SCRATCH ?? join(homedir(), "rg-driver-scratch"), "gitauto");
const SIDECAR = process.argv[3] ?? process.env.RG_SIDECAR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "sonnet";
const STEP_TIMEOUT_MS = 300_000;

if (/^(\/tmp|\/private\/tmp|\/var\/folders|\/private\/var\/folders)(\/|$)/.test(SCRATCH)) {
  process.stderr.write(`driver-gitauto: ${SCRATCH} is a temporary folder — Claude refuses git work there (§46); pick another\n`);
  process.exit(2);
}

const t0 = Date.now();
const log = (m) => process.stderr.write(`[gitauto +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const failures = [];
const check = (cond, msg) => {
  if (!cond) {
    failures.push(msg);
    log(`CHECK FAILED: ${msg}`);
    process.exitCode = 1;
  } else log(`ok: ${msg}`);
};
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
const tryGit = (cwd, ...a) => {
  try {
    return git(cwd, ...a);
  } catch {
    return null;
  }
};

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
const REPO = join(ROOT, "acme-app");
const ORIGIN = join(ROOT, "origin.git");
// The app-wide records (§36.8 cli-versions.json) go to the scratch folder, never the user's ~/.reviewgate.
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };

mkdirSync(REPO, { recursive: true });
git(REPO, "init", "-q", "-b", "main");
git(REPO, "config", "user.email", "gitauto@example.com");
git(REPO, "config", "user.name", "gitauto");
writeFileSync(join(REPO, "App.java"), 'public class App {\n  public static String greet() {\n    return "hi";\n  }\n}\n');
writeFileSync(join(REPO, "NOTES.md"), "# acme notes\n");
mkdirSync(join(REPO, ".claude", "skills", "acme-commit"), { recursive: true });
writeFileSync(
  join(REPO, ".claude", "skills", "acme-commit", "SKILL.md"),
  [
    "---",
    "name: acme-commit",
    'description: Stage every change and commit it with the message "chore: acme skill commit". Use when asked to commit with the acme-commit skill.',
    "allowed-tools: Bash(git add:*), Bash(git commit:*)",
    "---",
    "",
    'Run exactly these two commands, one Bash call each: `git add -A`, then `git commit -m "chore: acme skill commit"`.',
    "Do nothing else and do not push.",
    "",
  ].join("\n"),
);
git(REPO, "add", "-A");
git(REPO, "commit", "-q", "-m", "init: acme app");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", ORIGIN]);
git(REPO, "remote", "add", "origin", ORIGIN);
git(REPO, "push", "-q", "-u", "origin", "main");
const mainSha = git(REPO, "rev-parse", "HEAD");

const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
createInterface({ input: child.stderr }).on("line", (l) => {
  if (/\[(warn|error)\]|error/i.test(l) && !/:debug\]/.test(l)) process.stderr.write(`  [sidecar] ${l}\n`);
});
let state = null;
const events = [];
const replies = new Map();
const waiters = [];
let next = 1;
/** What each permission_request is answered with (a test of a turn sets it). */
let answer = () => ({ allow: false, message: "Not now." });
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
      log(`permission_request ${ev.toolName}: ${JSON.stringify(ev.input?.command ?? ev.input ?? null).slice(0, 160)} reason=${ev.reason?.code ?? "-"}`);
      child.stdin.write(JSON.stringify({ type: "permission_response", requestId: ev.requestId, ...answer(ev) }) + "\n");
    } else if (ev.type === "error") log(`error(${ev.scope}${ev.code ? ` ${ev.code}` : ""}): ${String(ev.message).slice(0, 200)}`);
    else if (ev.type === "tool_use" && ev.name === "Bash") log(`Bash: ${String(ev.input?.command ?? "").split("\n")[0].slice(0, 160)}`);
    else if (ev.type === "tool_use" && ev.name === "Skill") log(`Skill: ${JSON.stringify(ev.input).slice(0, 120)}`);
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) {
    if (state && w.pred(state)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(state);
    }
  }
});

function request(cmd) {
  const id = `g${next++}`;
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
/** One turn: sends `text`, waits for its collection and what follows it (head_moved / rows come after turn_end). */
async function turn(text, what) {
  const before = state.hud.turnCount;
  const mark = events.length;
  await request({ type: "send", text });
  await waitState((x) => x.hud.turnCount > before && x.gate.phase !== "running" && x.gate.phase !== "collecting" && x.gate.phase !== "starting", what);
  await new Promise((r) => setTimeout(r, 1500)); // head_moved and the rows follow turn_end
  const end = since(mark, "turn_end").at(-1);
  return {
    permissionRequests: since(mark, "permission_request").map((p) => ({ tool: p.toolName, command: p.input?.command ?? null, reason: p.reason?.code ?? null })),
    bash: since(mark, "tool_use").filter((u) => u.name === "Bash").map((u) => String(u.input?.command ?? "").split("\n")[0].slice(0, 200)),
    skills: since(mark, "tool_use").filter((u) => u.name === "Skill").map((u) => u.input),
    turnEnd: end ? { stopReason: end.stopReason, files: end.files } : null,
    headMoved: since(mark, "head_moved").map((h) => ({ explainedBy: h.explainedBy ?? null, commits: h.commits ?? [] })),
    rows: since(mark, "error").map((e) => ({ code: e.code ?? null, detail: e.detail ?? null })),
    files: state.changedFiles.map((f) => ({ path: f.path, state: f.state, committedIn: f.committedIn ?? null, origin: f.origin ?? null })),
    gateHeadMoved: state.gate.headMoved ?? null,
    answer: since(mark, "text_delta").map((e) => e.text).join("").trim().slice(0, 400),
  };
}

const observed = { model: MODEL, cli: null };
try {
  observed.cli = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
  await request({
    type: "hello",
    protocolVersion: 2,
    client: "test",
    settings: {
      budget: { maxFiles: 0, maxLines: 0 },
      ignorePatterns: [".omc/"],
      autoAllowTools: [],
      loadUserSettings: false,
      systemPromptAppend:
        "You are working inside a review gate. Run git commands that change the repository (commit, merge, pull, checkout, reset, stash, …) only when the user or a skill they ran asks. " +
        "This is an automated test: do exactly what is asked, without asking questions, and answer in one short sentence.",
      claudePath: CLAUDE,
      ghHost: "github.com",
      model: MODEL,
      permissionMode: "auto",
    },
  });
  await request({ type: "open_project", path: REPO });
  await waitState((s) => s.session.open && !s.session.starting && s.session.ready === true, "session ready");
  check(state.session.permissionMode === "auto", "the session runs in auto mode");

  // 1. A branch, a fix, a commit and a push: what the terminal's auto mode runs without asking.
  answer = () => ({ allow: false, message: "Not needed." });
  observed.turn1 = await turn(
    'Create a new git branch feature/acme-7. On it, fix App.java so that greet() returns "hello acme" instead of "hi". ' +
      'Commit that change with the message "fix: greet acme" and push the branch to origin with upstream tracking (git push -u origin feature/acme-7).',
    "turn 1",
  );
  log(`turn 1: ${JSON.stringify(observed.turn1)}`);
  const head1 = tryGit(REPO, "rev-parse", "HEAD");
  check(observed.turn1.permissionRequests.length === 0, "turn 1: a branch, a commit and a push asked nothing");
  check(tryGit(REPO, "rev-parse", "--abbrev-ref", "HEAD") === "feature/acme-7", "turn 1: HEAD is on feature/acme-7");
  check(head1 !== mainSha && tryGit(ORIGIN, "rev-parse", "refs/heads/feature/acme-7") === head1, "turn 1: the commit reached origin");
  const app = observed.turn1.files.find((f) => f.path === "App.java");
  check(app?.state === "pending" && app?.committedIn === head1?.slice(0, 7), "turn 1: App.java stays in the review, committedIn the new commit");
  check(app?.origin !== "external", "turn 1: App.java is Claude's change, not \"outside the app\"");
  check(observed.turn1.gateHeadMoved === null, "turn 1: no head-moved bar");
  check(observed.turn1.headMoved.some((h) => h.explainedBy === "claude_git"), "turn 1: head_moved explainedBy claude_git");
  check(observed.turn1.rows.some((r) => r.code === "claude_committed"), "turn 1: a claude_committed row");

  // 2. reset --hard throws the review's work away: exactly one card, with the reason (denied).
  answer = (ev) => ({ allow: false, message: ev.reason?.code === "git_command" ? "No — keep the branch and its files as they are." : "Not needed." });
  observed.turn2 = await turn("Now run exactly this command: git reset --hard origin/main", "turn 2");
  log(`turn 2: ${JSON.stringify(observed.turn2)}`);
  const git2 = observed.turn2.permissionRequests.filter((p) => p.reason === "git_command");
  check(git2.length === 1 && observed.turn2.permissionRequests.length === 1, "turn 2: exactly one permission_request, reason git_command");
  check(tryGit(REPO, "rev-parse", "HEAD") === head1, "turn 2: denied — HEAD did not move");

  // 3. A project skill whose allowed-tools are git add / git commit commits without a card in auto mode.
  answer = () => ({ allow: false, message: "Not needed." });
  observed.turn3 = await turn("Append the line \"- acme-7 shipped\" to NOTES.md, then commit it using the acme-commit skill.", "turn 3");
  log(`turn 3: ${JSON.stringify(observed.turn3)}`);
  const head3 = tryGit(REPO, "rev-parse", "HEAD");
  check(observed.turn3.permissionRequests.length === 0, "turn 3: the skill's commit asked nothing");
  check(observed.turn3.skills.length > 0, "turn 3: Claude ran the acme-commit skill");
  check(tryGit(REPO, "log", "-1", "--format=%s") === "chore: acme skill commit", "turn 3: the skill's commit is HEAD");
  const notes = observed.turn3.files.find((f) => f.path === "NOTES.md");
  check(notes?.committedIn === head3?.slice(0, 7), "turn 3: NOTES.md stays in the review, committedIn the skill's commit");
  check(observed.turn3.gateHeadMoved === null, "turn 3: no head-moved bar");
} catch (e) {
  failures.push(String(e?.message ?? e));
  log(`FAILED: ${e?.stack ?? e}`);
  process.exitCode = 1;
} finally {
  await request({ type: "shutdown" }).catch(() => undefined);
  const { code, signal } = await exited;
  observed.exit = { code, signal };
  const left = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(REPO) && !l.includes("driver-gitauto"));
  observed.leftover = left;
  if (left.length > 0) {
    failures.push(`processes left: ${left.join(" | ")}`);
    process.exitCode = 1;
  }
  // The scratch conversations the CLI wrote under ~/.claude/projects go, then the scratch folder.
  const projectsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const key = projectKey(REPO);
  for (const name of existsSync(projectsDir) ? readdirSync(projectsDir) : []) {
    if (name === key || name.startsWith(`${key}-`)) rmSync(join(projectsDir, name), { recursive: true, force: true });
  }
  if (!process.env.RG_KEEP_SCRATCH) rmSync(ROOT, { recursive: true, force: true });
  observed.failures = failures;
  process.stdout.write(JSON.stringify(observed, null, 2) + "\n");
}
