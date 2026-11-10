#!/usr/bin/env node
// MARK: r2-peers — real-CLI check for docs/PROTOCOL.md §18 / §52.2: work Claude was asked to do in the background is not
// blocked as "unprompted", and a subagent's hand-back is never "a message from another session".
//
//   node sidecar/test/driver-bgresume.mjs [scratchDir] [sidecar.mjs]
//     scratchDir: default ~/rg-driver-scratch/bgresume (or $RG_DRIVER_SCRATCH/bgresume) — RE-CREATED and removed at the end (RG_KEEP_SCRATCH=1
//     keeps it). Never under /tmp, /private/tmp or /var/folders.
//   RG_MODEL (default haiku), RG_MODE (default "default"; "auto" needs a model with auto mode, e.g. sonnet),
//   CLAUDE_PATH=… (default ~/.local/bin/claude).
//
// Through the bundled sidecar on a fresh scratch repository (user settings off); cards are allowed by the driver:
//   1. "start ONE subagent (general-purpose) that replies ready" — it runs in the background (§52.2); the driver waits
//      for its end and the turn Claude runs after it.
//   2. "SendMessage that subagent: sleep, then Write resumed.txt" — the main turn ends at once (SENT) while the
//      continued subagent sleeps; it writes resumed.txt after the main turn.
// Checks: resumed.txt exists with "resumed" and is in a review (the turn after it, or the next one); in auto mode the
// SendMessage to the session's own subagent got no card (§33.2); no call was denied
// as unprompted (no unprompted_blocked notice, no §18 deny reason in a tool result); no peer_message event and no
// peer_message row in the chat's record for any of it. At most four model turns (two of ours, two Claude starts).
// Removes the scratch conversations under ~/.claude/projects, checks no CLI child is left, prints what it saw as JSON.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(process.env.RG_DRIVER_SCRATCH ?? join(homedir(), "rg-driver-scratch"), "bgresume");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const MODE = process.env.RG_MODE || "default";
const STEP_TIMEOUT_MS = 240_000;

if (/^(\/tmp|\/private\/tmp|\/var\/folders|\/private\/var\/folders)(\/|$)/.test(SCRATCH)) {
  process.stderr.write(`driver-bgresume: ${SCRATCH} is a temporary folder — pick another\n`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => process.stderr.write(`[bgresume +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const failures = [];
const check = (cond, msg) => {
  if (!cond) {
    failures.push(msg);
    log(`CHECK FAILED: ${msg}`);
  } else log(`ok: ${msg}`);
};
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };
delete sidecarEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;

const repo = join(ROOT, "acme-bg");
mkdirSync(repo, { recursive: true });
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "bgresume@example.com");
git(repo, "config", "user.name", "bgresume");
writeFileSync(join(repo, "README.md"), "bgresume check\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "init");

const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
const exited = new Promise((resolve) => child.on("exit", resolve));
createInterface({ input: child.stderr }).on("line", (l) => {
  if (/unprompted|peer|auto turn|started a turn itself|Claude Code started/i.test(l)) log(`STDERR ${l.slice(0, 200)}`);
});
let state = null;
const events = [];
const replies = new Map();
let next = 1;
const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");
createInterface({ input: child.stdout }).on("line", (line) => {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.type === "state") state = ev.state;
  else events.push(ev);
  if (ev.type === "permission_request") {
    log(`permission_request ${ev.toolName} ${JSON.stringify(ev.input).slice(0, 100)}${ev.agent ? ` (agent ${ev.agent.agentId})` : ""} → allow`);
    send({ type: "permission_response", requestId: ev.requestId, allow: true });
  }
  if (ev.type === "auto_turn") log(`auto_turn ${ev.trigger} ${ev.task?.kind ?? ""} ${String(ev.task?.summary ?? "").slice(0, 80)}`);
  if (ev.type === "error") log(`error ${ev.code} ${String(ev.message).slice(0, 120)}`);
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
});
const request = (cmd) =>
  new Promise((resolve, reject) => {
    const id = `g${next++}`;
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type}`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      resolve(ev);
    });
    send({ ...cmd, id });
  });
const waitFor = async (pred, what, ms = STEP_TIMEOUT_MS) => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
};
const settled = () => state && state.gate.phase !== "running" && state.gate.phase !== "collecting" && !state.session.externalTurn;
const ends = () => events.filter((e) => e.type === "turn_end").length;
const children = () => {
  try {
    return execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const observed = { model: MODEL, mode: MODE };
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
  const chat = state.sessions.currentId;

  // 1. a subagent in the background, and its end.
  const first = events.length;
  await request({
    type: "send",
    text: "Use the Agent tool (subagent_type general-purpose) to start exactly ONE subagent with this task: 'Reply with exactly the word ready and nothing else.' Do not wait for it. After starting it, reply with exactly one word: STARTED.",
  });
  await waitFor(() => ends() >= 1, "turn 1");
  const agentCall = events.slice(first).find((e) => e.type === "tool_use" && (e.name === "Agent" || e.name === "Task"));
  check(!!agentCall, "Claude started a subagent");
  await waitFor(() => events.some((e) => e.type === "tool_result" && e.toolUseId === agentCall?.id && e.agentEnded === true), "the subagent's end");
  await waitFor(settled, "settled after the agent");
  await sleep(1500);
  await waitFor(settled, "settled after its turn");
  const node = (state.hud.agents ?? []).find((a) => a.toolUseId === agentCall?.id) ?? (state.hud.agentHistory ?? []).find((a) => a.toolUseId === agentCall?.id);
  const agentId = node?.cliAgentId ?? node?.taskId ?? node?.id ?? null;
  observed.agent = { call: agentCall?.id ?? null, agentId };
  check(typeof agentId === "string" && agentId.length > 0, "the subagent's id is known");
  await request({ type: "accept_all" }).catch(() => undefined);

  // 2. continue it with SendMessage: it sleeps past the main turn's end, then writes.
  const second = events.length;
  const endsBefore = ends();
  await request({
    type: "send",
    text: `Use the SendMessage tool exactly once (load it with ToolSearch first if you need to) with to: '${agentId}' and this message: 'Now run the Bash command \`sleep 12\`, then use the Write tool to create the file resumed.txt containing the single word resumed, then finish with a one-line report.' Do not wait for it and do not check on it. After the send, reply with exactly one word: SENT.`,
  });
  await waitFor(() => ends() > endsBefore, "turn 2");
  const sendCall = events.slice(second).find((e) => e.type === "tool_use" && e.name === "SendMessage");
  observed.sendMessage = sendCall ? { to: sendCall.input?.to ?? null, continues: sendCall.continues ?? null } : null;
  check(!!sendCall, "Claude continued the subagent with SendMessage");
  // §33.2: in auto mode a message to the session's own subagent needs no card (in the other modes it keeps one).
  observed.sendMessageCards = events.slice(second).filter((e) => e.type === "permission_request" && e.toolName === "SendMessage").length;
  if (MODE === "auto") check(observed.sendMessageCards === 0, "no SendMessage card in auto mode (the session's own subagent)");
  observed.fileAtTurn2End = existsSync(join(repo, "resumed.txt"));
  // The continued run writes after the main turn; the turn Claude runs after it (or our next message) reviews it.
  await waitFor(() => existsSync(join(repo, "resumed.txt")), "resumed.txt", 180_000);
  await waitFor(() => (state?.changedFiles ?? []).some((f) => f.path === "resumed.txt"), "resumed.txt in a review", 120_000).catch(() => undefined);
  await waitFor(settled, "settled after the continued run");
  await sleep(1500);
  const mine = events.slice(first);
  observed.resumedFile = (() => {
    try {
      return readFileSync(join(repo, "resumed.txt"), "utf8").trim();
    } catch {
      return null;
    }
  })();
  observed.review = (state?.changedFiles ?? []).map((f) => ({ path: f.path, state: f.state, origin: f.origin }));
  observed.autoTurns = mine.filter((e) => e.type === "auto_turn").map((e) => ({ trigger: e.trigger, kind: e.task?.kind ?? null }));
  observed.unprompted = {
    notices: mine.filter((e) => e.type === "error" && e.code === "unprompted_blocked").length,
    deniedResults: mine.filter((e) => e.type === "tool_result" && /no user request is running/.test(String(e.preview ?? ""))).map((e) => String(e.preview).slice(0, 100)),
    text: mine.some((e) => e.type === "text_delta" && e.unprompted === true),
  };
  observed.peerMessages = mine.filter((e) => e.type === "peer_message").length + (state?.session.peerInbox ?? []).length;
  const rows = (() => {
    try {
      return readFileSync(join(repo, ".git", "reviewgate", "sessions", `${chat}.ndjson`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  })();
  observed.peerRows = rows.filter((r) => r.kind === "peer_message").length;
  observed.turns = ends();
  check(observed.resumedFile === "resumed", "the continued subagent wrote resumed.txt");
  check(observed.review.some((f) => f.path === "resumed.txt"), "resumed.txt is in the review");
  check(observed.unprompted.notices === 0 && observed.unprompted.deniedResults.length === 0, "nothing was denied as unprompted");
  check(observed.peerMessages === 0 && observed.peerRows === 0, "no 'message from another session' (event or row) for the subagent");
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
  log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  observed.filesAtError = (state?.changedFiles ?? []).map((f) => f.path);
} finally {
  send({ type: "shutdown", id: "bye" });
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  observed.leftoverChildren = children().length;
  if (observed.leftoverChildren > 0) failures.push("a CLI child was left");
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
  if (process.env.RG_KEEP_SCRATCH !== "1") rmSync(ROOT, { recursive: true, force: true });
}
observed.failures = failures;
process.stdout.write(JSON.stringify(observed, null, 2) + "\n");
log(failures.length ? "FAILED" : "OK");
process.exit(failures.length ? 1 : 0);
