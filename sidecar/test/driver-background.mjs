#!/usr/bin/env node
// Real-CLI check for docs/PROTOCOL.md §52 (background work): a Bash call Claude runs in the background is listed in
// `state.session.backgroundTasks` while it runs; when it ends, the turn Claude starts by itself is a review turn
// (`auto_turn {trigger: "background"}`, its edits collected) and what the background command wrote after the first turn's
// B is in that review. With RG_LOOP=1 a `/loop 1m` run is checked as well (`auto_turn {trigger: "schedule"}`, ~70 s more).
// Through the bundled sidecar on a fresh scratch repository (loadUserSettings off). Model calls on RG_MODEL (default haiku).
//
//   node sidecar/test/driver-background.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-background, RE-CREATED)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
// Prints what was observed as JSON; exits 1 when a check failed.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-background");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const LOOP = process.env.RG_LOOP === "1";
const STEP_TIMEOUT_MS = 150_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => process.stderr.write(`[background +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
// The app-wide records (§36.8 cli-versions.json) go to the scratch folder, never the user's ~/.reviewgate.
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };
delete sidecarEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;

const repo = join(ROOT, "repo");
mkdirSync(repo, { recursive: true });
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "background@example.com");
git(repo, "config", "user.name", "background");
writeFileSync(join(repo, "README.md"), "background check\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "init");

const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
const exited = new Promise((resolve) => child.on("exit", resolve));
child.stderr.on("data", () => {});
let state = null;
const events = [];
const replies = new Map();
const maxTasks = { count: 0, kinds: [] };
let lastTasks = [];
let next = 1;
const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");
createInterface({ input: child.stdout }).on("line", (line) => {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.type === "state") {
    state = ev.state;
    const tasks = state.session.backgroundTasks ?? [];
    if (tasks.length > maxTasks.count) Object.assign(maxTasks, { count: tasks.length, kinds: tasks.map((t) => t.kind) });
    if (tasks.length > 0) lastTasks = tasks;
  } else events.push(ev);
  if (ev.type === "permission_request") send({ type: "permission_response", requestId: ev.requestId, allow: true });
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
});
const request = (cmd) =>
  new Promise((resolve, reject) => {
    const id = `b${next++}`;
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type}`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      resolve(ev);
    });
    send({ ...cmd, id });
  });
const waitFor = async (pred, what) => {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const settled = () => state && state.gate.phase !== "running" && state.gate.phase !== "collecting" && !state.session.externalTurn;
const filesOf = () => (state?.changedFiles ?? []).map((f) => ({ path: f.path, state: f.state, origin: f.origin }));

const observed = { cli: null };
let failed = false;
try {
  observed.cli = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
  const settings = {
    budget: { maxFiles: 5, maxLines: 200 },
    ignorePatterns: [], autoAllowTools: [], loadUserSettings: false,
    systemPromptAppend: "You are running inside a ReviewGate test. Do exactly what each message asks, nothing more.",
    claudePath: CLAUDE, model: MODEL, ghHost: "github.com",
  };
  await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  await request({ type: "open_project", path: repo });
  await waitFor(() => state?.session.open && !state.session.starting, "session open");

  // A: a background command, then the turn Claude starts when it ends.
  await request({
    type: "send",
    text: "Run this exact Bash command with run_in_background set to true: `sleep 8; echo built > built.txt`. Do not wait for it and do not check on it now; reply with exactly one word: STARTED. Later, when you are told it finished, create the file after.txt containing the single word after.",
  });
  await waitFor(() => events.some((e) => e.type === "turn_end"), "turn 1 end");
  await waitFor(settled, "turn 1 collected");
  observed.tasksWhileRunning = { ...maxTasks, last: lastTasks[0] ?? null };
  const taskId = lastTasks[0]?.taskId;
  if (taskId) {
    const out = await request({ type: "task_output", taskId }).catch((e) => ({ error: String(e) }));
    observed.taskOutput = out.type === "task_output" ? { running: out.running, truncated: out.truncated, chars: out.text.length } : out.error ?? out;
  }
  await waitFor(() => events.some((e) => e.type === "auto_turn"), "auto turn");
  observed.autoTurn = events.find((e) => e.type === "auto_turn");
  await waitFor(() => events.filter((e) => e.type === "turn_end").length >= 2, "auto turn end");
  await waitFor(settled, "auto turn collected");
  await sleep(1000);
  observed.afterAutoTurn = filesOf();
  observed.tasksAfter = (state?.session.backgroundTasks ?? []).length;
  observed.unpromptedText = events.some((e) => e.type === "text_delta" && e.unprompted === true);
  const okA = maxTasks.count >= 1 && maxTasks.kinds.includes("bash") && observed.autoTurn?.trigger === "background"
    && observed.tasksWhileRunning.last?.toolUseId && observed.tasksWhileRunning.last?.hasOutput === true && typeof observed.taskOutput === "object"
    && observed.afterAutoTurn.some((f) => f.path === "built.txt") && observed.afterAutoTurn.some((f) => f.path === "after.txt")
    && observed.tasksAfter === 0 && !observed.unpromptedText;
  observed.checkA = okA;
  if (!okA) failed = true;

  // B (RG_LOOP=1): a /loop run becomes a review turn too.
  if (LOOP) {
    await request({ type: "accept_all" }).catch(() => undefined);
    const before = events.filter((e) => e.type === "auto_turn").length;
    await request({ type: "send", text: "/loop 1m create or overwrite the file tick.txt with the single word tick, and reply TICK" });
    await waitFor(() => events.filter((e) => e.type === "auto_turn").length > before, "the scheduled run");
    observed.loopTurn = events.filter((e) => e.type === "auto_turn").at(-1);
    await waitFor(() => events.filter((e) => e.type === "turn_end").length >= 4, "the scheduled run's end");
    await waitFor(settled, "the scheduled run collected");
    observed.afterLoop = filesOf();
    const okB = observed.loopTurn?.trigger === "schedule" && observed.afterLoop.some((f) => f.path === "tick.txt")
      && !observed.afterLoop.some((f) => f.path.startsWith(".claude/"));
    observed.checkB = okB;
    if (!okB) failed = true;
  }
  log(JSON.stringify(observed));
} catch (e) {
  failed = true;
  observed.error = e instanceof Error ? e.message : String(e);
  observed.filesAtError = filesOf();
  observed.eventTypes = [...new Set(events.map((e) => e.type))];
} finally {
  send({ type: "shutdown", id: "bye" });
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  const projects = join(homedir(), ".claude", "projects");
  for (const key of (() => {
    try {
      return readdirSync(projects);
    } catch {
      return [];
    }
  })()) {
    if (key.startsWith(projectKey(ROOT))) rmSync(join(projects, key), { recursive: true, force: true });
  }
}
process.stdout.write(JSON.stringify(observed, null, 2) + "\n");
process.exit(failed ? 1 : 0);
