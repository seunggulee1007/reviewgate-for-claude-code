#!/usr/bin/env node
// Real-CLI check for docs/PROTOCOL.md §52 (background work): a Bash call Claude runs in the background is listed in
// `state.session.backgroundTasks` while it runs; when it ends, the turn Claude starts by itself is a review turn
// (`auto_turn {trigger: "background"}`, its edits collected) and what the background command wrote after the first turn's
// B is in that review. With RG_LOOP=1 a `/loop 1m` run is checked as well (`auto_turn {trigger: "schedule"}`, ~70 s more).
// With RG_AGENT=1 (§52.2, r1x): a subagent in the background — the main agent starts one that reads a big file (a
// project PreToolUse hook denies the read without offset/limit), sleeps ~20 s and writes agent.txt; a message sent
// meanwhile is answered before the subagent ends; its calls are never denied as unprompted, the hook's deny is a
// `hookDenied` result (no notice), its end is the call's own result, the hand-back no peer card, and agent.txt is in the
// review with the agent's Write as its cause. RG_ONLY=agent skips A. RG_MODE=auto starts the session in auto mode.
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
const AGENT = process.env.RG_AGENT === "1";
const ONLY_AGENT = process.env.RG_ONLY === "agent";
const MODE = process.env.RG_MODE || "default";
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
if (AGENT) {
  // A project hook like the user's read budget: a Read of big.txt without offset/limit is denied (JSON), others pass.
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "read-budget.mjs"), `let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const i=JSON.parse(s);const f=String(i.tool_input?.file_path??"");if(i.tool_name==="Read"&&f.endsWith("big.txt")&&i.tool_input.limit===undefined){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"[ACME READ BUDGET] Denied: big.txt is 9000 bytes and this call has no offset/limit"}}));}});`);
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "node .claude/read-budget.mjs" }] }] } }, null, 2) + "\n");
  writeFileSync(join(repo, "big.txt"), Array.from({ length: 300 }, (_, i) => `line ${i} of the big file`).join("\n") + "\n");
}
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
    ...(MODE !== "default" ? { permissionMode: MODE } : {}),
  };
  await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  await request({ type: "open_project", path: repo });
  await waitFor(() => state?.session.open && !state.session.starting, "session open");

  if (!ONLY_AGENT) {
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
  }

  // C (RG_AGENT=1): a subagent in the background; the main agent answers meanwhile (§52.2).
  if (AGENT) {
    const ends = () => events.filter((e) => e.type === "turn_end").length;
    const startEnds = ends();
    const startAuto = events.filter((e) => e.type === "auto_turn").length;
    const firstEvent = events.length;
    await request({
      type: "send",
      text: "Use the Agent tool (subagent_type general-purpose) to start exactly ONE subagent with this task: 'First read the file big.txt with the Read tool without offset or limit; if that is denied, read it with offset 0 and limit 5. Then run the Bash command `sleep 20`. Then use the Write tool to create the file agent.txt containing the single word agent. Then finish with a one-line report.' Do not wait for it and do not check on it. After starting it, reply with exactly one word: STARTED.",
    });
    await waitFor(() => ends() > startEnds, "the turn that started the agent");
    const agentCall = events.slice(firstEvent).find((e) => e.type === "tool_use" && (e.name === "Agent" || e.name === "Task"));
    observed.agentStarted = { call: agentCall?.id ?? null, input: agentCall ? { run_in_background: agentCall.input.run_in_background ?? null } : null };
    observed.agentLaunched = events.slice(firstEvent).some((e) => e.type === "tool_result" && e.toolUseId === agentCall?.id && e.agentLaunched === true);
    await waitFor(settled, "turn 1 collected");
    const askedAt = Date.now();
    await request({ type: "send", text: "Quick question while that runs: what is 2+2? Answer with just the number." });
    await waitFor(() => ends() > startEnds + 1, "the answer to the question");
    const agentEndedEarly = events.some((e) => e.type === "tool_result" && e.toolUseId === agentCall?.id && e.agentEnded === true);
    const answer = events.filter((e) => e.type === "turn_end").at(-1);
    observed.answer = { seconds: Math.round((Date.now() - askedAt) / 100) / 10, beforeTheAgentEnded: !agentEndedEarly, stopReason: answer?.stopReason ?? null };
    observed.liveWhileAnswered = { tasks: (state?.session.backgroundTasks ?? []).map((t) => t.kind), agents: (state?.hud.agents ?? []).filter((a) => a.isBackground && ["running", "pending"].includes(a.status)).length };
    await waitFor(settled, "the answer collected");
    // The agent ends; Claude goes on by itself (the hand-back turn).
    await waitFor(() => events.some((e) => e.type === "tool_result" && e.toolUseId === agentCall?.id && e.agentEnded === true), "the agent's own result");
    await waitFor(() => events.filter((e) => e.type === "auto_turn").length > startAuto, "the turn after the agent");
    observed.autoTurn = events.filter((e) => e.type === "auto_turn").at(-1);
    await waitFor(() => ends() > startEnds + 2, "the auto turn's end");
    await waitFor(settled, "the auto turn collected");
    await sleep(1000);
    const mine = events.slice(firstEvent);
    observed.agentEnd = mine.filter((e) => e.type === "tool_result" && e.toolUseId === agentCall?.id).map((e) => ({ launched: e.agentLaunched ?? false, ended: e.agentEnded ?? false, isError: e.isError, preview: String(e.preview).slice(0, 120) }));
    observed.hookDenied = mine.filter((e) => e.type === "tool_result" && e.hookDenied).map((e) => e.hookDenied);
    observed.hookNotices = mine.filter((e) => e.type === "error" && (e.code === "hook_blocked" || e.code === "hook_failed")).length;
    observed.unprompted = { denied: mine.filter((e) => e.type === "error" && e.code === "unprompted_blocked").map((e) => e.message), text: mine.some((e) => e.type === "text_delta" && e.unprompted === true) };
    observed.peerCards = mine.filter((e) => e.type === "peer_message").length + (state?.session.peerInbox ?? []).length;
    observed.agentReview = filesOf().filter((f) => f.path === "agent.txt");
    const fileCause = (state?.changedFiles ?? []).find((f) => f.path === "agent.txt");
    observed.agentFileCause = fileCause ? { tools: fileCause.tools, toolUseIds: fileCause.toolUseIds } : null;
    observed.agentFile = (() => {
      try {
        return execFileSync("cat", [join(repo, "agent.txt")], { encoding: "utf8" }).trim();
      } catch {
        return null;
      }
    })();
    const okC = !!agentCall && observed.agentLaunched && observed.answer.beforeTheAgentEnded
      && observed.autoTurn?.trigger === "background" && observed.autoTurn?.task?.kind === "agent"
      && observed.agentEnd.some((r) => r.ended && !r.isError)
      && observed.hookDenied.some((d) => d.hook === "PreToolUse:Read") && observed.hookNotices === 0
      && observed.unprompted.denied.length === 0 && !observed.unprompted.text && observed.peerCards === 0
      && observed.agentFile === "agent" && observed.agentReview.length === 1 && observed.agentReview[0].origin === "tool";
    observed.checkC = okC;
    if (!okC) failed = true;
  }

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
