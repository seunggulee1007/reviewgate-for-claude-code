#!/usr/bin/env node
// Real-CLI contract driver for docs/PROTOCOL.md §30 — session start and recovery (audit crash-1 / crash-2 / crash-5).
// NO model call: conversations are created with the CLI's local `/cost` command, and the CLI runs with an isolated
// CLAUDE_CONFIG_DIR inside the scratch folder (no login needed, nothing is written to ~/.claude).
//
//   node sidecar/test/driver-crash.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-crash, RE-CREATED; sidecar/dist/sidecar.mjs)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
//
//   1. crash-1 — the chat a peer message created: the index says turns 0 / no user text (nothing marks it cliKnown),
//      but the CLI has its record. open_project must resume it (`--resume`), with no error event, and the session must
//      stay up past the 2 s auto-restart window; restart_session resumes it again.
//   2. crash-5 — a chat whose CLI record is gone (the CLI's 30-day cleanup): session_open falls back to a new chat with
//      exactly one error{code:"resume_not_found", fatal:false} (no session_crashed), the old chat is flagged
//      resumeFailed, and the notice is a row of the new chat's transcript.
//   3. crash-2 — a CLI that dies before initialize (stderr "Error: unknown option …", exit 1): exactly one
//      error{code:"session_start_failed", detail, exitCode:1}, no automatic restart; restart_session → the same code +
//      detail again (clients merge repeats on them).
// Asserts no `claude` / sidecar orphans at the end and prints what was observed as JSON.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-crash");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;

const t0 = Date.now();
const log = (msg) => process.stderr.write(`[crash +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) {
    log(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
};

// ---------------------------------------------------------------- scratch: repo + isolated CLI config
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
// The app-wide records (§36.8 cli-versions.json) go to the scratch folder, never the user's ~/.reviewgate.
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };
const REPO = join(ROOT, "repo");
const CONFIG = join(ROOT, "claude-config");
mkdirSync(REPO, { recursive: true });
mkdirSync(CONFIG, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "crash@example.com");
git("config", "user.name", "crash");
writeFileSync(join(REPO, "README.md"), "# crash scratch\n");
git("add", "-A");
git("commit", "-q", "-m", "crash: init");
const GITDIR = join(REPO, ".git");
const cliEnv = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG };

/** A conversation the CLI has a record of — written by the CLI itself (local /cost, no model call). */
function cliRecord(id) {
  execFileSync(CLAUDE, ["-p", "--session-id", id, "--setting-sources", "project", "--output-format", "json", "/cost"], { cwd: REPO, env: cliEnv, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
}

/** reviewgate-session.json + sessions/index.json as an older engine left them (no cliKnown). */
function seedChats(current, metas) {
  mkdirSync(join(GITDIR, "reviewgate", "sessions"), { recursive: true });
  writeFileSync(join(GITDIR, "reviewgate-session.json"), JSON.stringify({ version: 1, sessionId: current, openTabIds: [current], permissionMode: "default", savedAt: "2026-10-20T12:25:46.000Z" }));
  writeFileSync(join(GITDIR, "reviewgate", "sessions", "index.json"), JSON.stringify({ version: 1, sessions: metas }));
}
const meta = (id, extra = {}) => ({ id, title: "New chat", createdAt: "2026-09-15T05:15:55.096Z", updatedAt: "2026-09-15T05:15:55.096Z", turns: 0, costUSD: 0, lastUserText: null, ...extra });

const PEER_CHAT = randomUUID();
const GONE_CHAT = randomUUID();
cliRecord(PEER_CHAT);
seedChats(PEER_CHAT, [meta(PEER_CHAT), meta(GONE_CHAT, { title: "acme-1200 작업", turns: 3, lastUserText: "이어서 해줘", updatedAt: "2026-09-16T00:00:00.000Z" })]);
// The peer turn's rows, as ReviewGate kept them (unprompted text only).
writeFileSync(join(GITDIR, "reviewgate", "sessions", `${PEER_CHAT}.ndjson`), JSON.stringify({ at: "2026-10-20T12:38:40.000Z", turn: 0, kind: "assistant_text", text: "허락해 주면 답장 보낼게.", unprompted: true }) + "\n");
// A CLI that dies before initialize, like an older CLI given an option it does not know.
const DYING = join(ROOT, "dying-claude.sh");
writeFileSync(DYING, "#!/bin/sh\necho \"Error: unknown option '--replay-user-messages'\" >&2\nexit 1\n");
chmodSync(DYING, 0o755);

// ---------------------------------------------------------------- sidecar
const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
createInterface({ input: child.stderr }).on("line", (l) => {
  if (/claude exited|resum|session died|automatic restart|fresh|not restarted|Session ID|already/i.test(l)) log(`STDERR ${l.slice(0, 300)}`);
});
let state = null;
const errors = [];
const logs = [];
const restores = [];
const replies = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    log(`BAD ${line.slice(0, 200)}`);
    return;
  }
  if (ev.type === "state") state = ev.state;
  else if (ev.type === "error") {
    errors.push(ev);
    log(`ERROR#${errors.length} code=${ev.code} fatal=${ev.fatal} detail=${JSON.stringify(ev.detail ?? null)} message=${JSON.stringify(ev.message).slice(0, 160)}`);
  } else if (ev.type === "log") logs.push(ev.message);
  else if (ev.type === "transcript_restore") restores.push(ev.items);
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
});
const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");
const request = (cmd, ms = 60_000) =>
  new Promise((resolve) => {
    const id = `r${nextId++}`;
    const timer = setTimeout(() => {
      replies.delete(id);
      resolve({ timeout: true });
    }, ms);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      resolve(ev);
    });
    send({ ...cmd, id });
  });
const waitFor = async (pred, what, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!(state && pred(state))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
  return state;
};
const claudeChildren = () => {
  try {
    return execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const argsOf = (pid) => {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", pid], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const cliArgs = () => claudeChildren().map(argsOf).filter(Boolean);
const settled = (s) => !s.session.starting && s.session.open;

const settings = { ignorePatterns: [".omc/"], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", claudePath: CLAUDE, model: "haiku", ghHost: "github.com" };
const summary = { cli: execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim(), steps: {} };

try {
  await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "", CLAUDE_CONFIG_DIR: CONFIG }, settings });

  // 1. crash-1 ---------------------------------------------------------------
  log(`1. open_project: chat ${PEER_CHAT} (turns 0, CLI record present)`);
  await request({ type: "open_project", path: REPO });
  await waitFor(settled, "session open");
  await sleep(6000); // the old engine crashed within 0.5 s and once more after the 2 s auto-restart
  let s = state;
  const args1 = cliArgs();
  log(`   claude: ${args1.map((a) => a.replace(/^.*?(--resume[= ]\S+|--session-id[= ]\S+).*$/, "$1")).join(" | ")}`);
  assert(errors.length === 0, `no error after open_project (got ${errors.map((e) => e.code).join(", ")})`);
  assert(s.session.open && s.sessions.currentId === PEER_CHAT, "the peer-only chat is current and its session is up");
  assert(args1.length === 1 && new RegExp(`--resume[= ]${PEER_CHAT}`).test(args1[0]), "the CLI runs with --resume <chat>");
  assert(logs.some((l) => l.includes(`resuming session ${PEER_CHAT}`)), "engine log says it resumed");
  await request({ type: "restart_session" });
  await waitFor(settled, "restarted");
  await sleep(3000);
  const args1b = cliArgs();
  assert(errors.length === 0, "restart_session: still no error");
  assert(args1b.length === 1 && new RegExp(`--resume[= ]${PEER_CHAT}`).test(args1b[0]), "restart_session resumes again");
  summary.steps.crash1 = { errors: errors.length, resumed: true, restartResumed: true, restoreRows: restores[0]?.length ?? 0 };

  // 2. crash-5 ---------------------------------------------------------------
  log(`2. session_open ${GONE_CHAT} (turns 3, CLI record gone)`);
  await request({ type: "session_open", sessionId: GONE_CHAT });
  s = await waitFor((x) => settled(x) && x.sessions.currentId !== PEER_CHAT && x.sessions.currentId !== GONE_CHAT, "fallback chat", 30_000);
  await sleep(3000);
  s = state;
  const fresh = s.sessions.currentId;
  const notices = errors.filter((e) => e.code === "resume_not_found");
  assert(errors.length === 1 && notices.length === 1, `exactly one error: the resume_not_found notice (got ${errors.map((e) => e.code).join(", ")})`);
  assert(notices[0].fatal === false && notices[0].sessionId === GONE_CHAT && /No conversation found/.test(notices[0].detail ?? ""), "notice: non-fatal, names the chat, CLI's words as detail");
  assert(s.sessions.list.find((m) => m.id === GONE_CHAT)?.resumeFailed === true, "the old chat is flagged resumeFailed");
  const freshRows = readFileSync(join(GITDIR, "reviewgate", "sessions", `${fresh}.ndjson`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert(freshRows.some((r) => r.kind === "error" && r.code === "resume_not_found"), "the notice is a row of the new chat");
  assert(cliArgs().every((a) => !a.includes("--resume")) && cliArgs().length === 1, "the new chat runs a fresh CLI session");
  summary.steps.crash5 = { notice: { code: notices[0].code, fatal: notices[0].fatal, detail: notices[0].detail }, newChat: fresh, rowKept: true };

  // 3. crash-2 ---------------------------------------------------------------
  log("3. a CLI that dies before initialize");
  const before = errors.length;
  await request({ type: "set_settings", settings: { claudePath: DYING } });
  await request({ type: "restart_session" });
  await sleep(6000); // past the 2 s auto-restart window
  const deaths = errors.slice(before);
  assert(deaths.length === 1, `one error, no automatic restart (got ${deaths.length})`);
  assert(deaths[0].code === "session_start_failed" && deaths[0].fatal === true && deaths[0].exitCode === 1, "session_start_failed, fatal, exitCode 1");
  assert(deaths[0].detail === "Error: unknown option '--replay-user-messages'", `detail is the CLI's line (got ${JSON.stringify(deaths[0].detail)})`);
  await request({ type: "restart_session" });
  await sleep(3000);
  const again = errors.slice(before + 1);
  assert(again.length === 1 && again[0].code === deaths[0].code && again[0].detail === deaths[0].detail, "the same code + detail on retry");
  await request({ type: "set_settings", settings: { claudePath: CLAUDE } });
  await request({ type: "restart_session" });
  await waitFor(settled, "back on the real CLI");
  await sleep(2000);
  assert(errors.length === before + 2, "the real CLI starts again without an error");
  summary.steps.crash2 = { code: deaths[0].code, detail: deaths[0].detail, exitCode: deaths[0].exitCode, autoRestarts: 0 };
} catch (e) {
  log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  send({ type: "shutdown" });
  await new Promise((r) => {
    child.on("exit", r);
    setTimeout(r, 8000);
  });
  const left = claudeChildren();
  summary.leftoverChildren = left.length;
  if (left.length > 0) {
    log(`leftover children: ${left.join(", ")}`);
    process.exitCode = 1;
  }
  summary.cliProjects = existsSync(join(CONFIG, "projects")) ? readdirSync(join(CONFIG, "projects")) : [];
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  log(process.exitCode ? "FAILED" : "OK");
}
