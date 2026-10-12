#!/usr/bin/env node
// Real-CLI contract driver for docs/PROTOCOL.md §29 — messages from the user's other Claude sessions (audit peer-01…05).
// Both ends are scratch processes of this driver: the RECEIVER is a ReviewGate sidecar session on a fresh scratch repo,
// the SENDER a `claude -p --tools SendMessage` run in a scratch folder that may only address the receiver's own socket
// (its parent pid is checked first). Model: haiku (RG_MODEL), a few cents per run.
//
//   node sidecar/test/driver-peer.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-peer, RE-CREATED; sidecar/dist/sidecar.mjs)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
//
//   1. The receiver CLI runs with `--name "ReviewGate · <repo>"` (registry name) and crossSessionInbound hold.
//   2. A peer message is HELD: peer_message{state:"held"} + state.session.peerInbox, no turn runs, no unprompted banner.
//   3. peer_accept → the message runs as a review turn: peer_message delivering → delivered (body, verifiedPeerPid), the
//      file it asked for is in the review (pending), a peer_message transcript row, turn_end.
//   4. A second message → held → peer_dismiss → dropped / refused; the sender learns it was not delivered.
//   5. restart_session resumes the chat under the same --name (no error).
// Cleans up ~/.claude/projects/<scratch keys> afterwards, asserts no orphans, prints what was observed as JSON.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-peer");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 180_000;

const t0 = Date.now();
const log = (msg) => process.stderr.write(`[peer +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) {
    log(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
/** The CLI's ~/.claude/projects key of a cwd (§30; < 200 chars here). */
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");

// ---------------------------------------------------------------- scratch
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
// The app-wide records (§36.8 cli-versions.json) go to the scratch folder, never the user's ~/.reviewgate.
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };
const REPO = join(ROOT, "receiver");
const SENDER_DIR = join(ROOT, "sender");
mkdirSync(REPO, { recursive: true });
mkdirSync(SENDER_DIR, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "peer@example.com");
git("config", "user.name", "peer");
writeFileSync(join(REPO, "README.md"), "# peer scratch\n");
writeFileSync(join(REPO, ".gitignore"), ".omc/\n");
git("add", "-A");
git("commit", "-q", "-m", "peer: init");

// ---------------------------------------------------------------- receiver: the sidecar
const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
createInterface({ input: child.stderr }).on("line", (l) => {
  if (/peer|held|released|crossSession|resum|exited|external/i.test(l)) log(`STDERR ${l.slice(0, 240)}`);
});
let state = null;
const events = [];
const replies = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.type === "state") state = ev.state;
  else events.push(ev);
  if (ev.type === "peer_message") log(`peer_message ${ev.message.state}${ev.message.outcome ? `/${ev.message.outcome}` : ""} id=${ev.message.id} from=${ev.message.fromName} pid=${ev.message.verifiedPeerPid} body=${JSON.stringify(ev.message.body ?? null).slice(0, 120)}`);
  if (ev.type === "error") log(`ERROR code=${ev.code} fatal=${ev.fatal} ${JSON.stringify(ev.message).slice(0, 160)}`);
  if (ev.type === "permission_request") {
    // The peer asked for a file; a Bash that writes exactly it may run, anything else (a reply by SendMessage, …) not.
    const cmd = String(ev.input?.command ?? "");
    const allow = ev.toolName === "Bash" && cmd.includes("peer-note.txt") && !/rm |curl|ssh/.test(cmd);
    log(`permission_request ${ev.toolName} ${cmd.slice(0, 80)} → ${allow ? "allow" : "deny"}`);
    send({ type: "permission_response", requestId: ev.requestId, allow, ...(allow ? {} : { message: "driver-peer: not needed for this test" }) });
  }
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
const waitFor = async (pred, what, ms = STEP_TIMEOUT_MS) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (state && pred(state)) return state;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const waitEvent = async (pred, what, ms = STEP_TIMEOUT_MS) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const claudeChildren = () => {
  try {
    return execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const settled = (s) => s.session.open && !s.session.starting;

// ---------------------------------------------------------------- sender: one scratch `claude -p`
/** Sends one message to the receiver CLI `pid` — only after checking that pid is the child of OUR sidecar. */
async function sendPeer(pid, text) {
  const parent = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim();
  assert(parent === String(child.pid), `refusing to message pid ${pid}: its parent ${parent} is not our sidecar ${child.pid}`);
  const sock = `/tmp/cc-socks/${pid}.sock`;
  assert(existsSync(sock), `no socket ${sock}`);
  const prompt = `Use the SendMessage tool exactly once. Send this exact message text: '${text}' to this exact address: uds:${sock} . Never send to any other address and do not use any other tool except ToolSearch if you need it to load SendMessage. After the single send, reply with the word DONE.`;
  const sender = spawn(CLAUDE, ["-p", "--model", MODEL, "--setting-sources", "project", "--strict-mcp-config", "--no-session-persistence", "--tools", "SendMessage,ToolSearch", "--allowedTools", "SendMessage", "ToolSearch", "--output-format", "stream-json", "--verbose", prompt], { cwd: SENDER_DIR, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  sender.stdout.setEncoding("utf8");
  sender.stdout.on("data", (d) => (out += d));
  sender.stderr.resume();
  const killer = setTimeout(() => sender.kill("SIGKILL"), 150_000);
  await new Promise((r) => sender.once("close", r));
  clearTimeout(killer);
  // What the SendMessage call answered the sender (delivered / held / refused receipt).
  const receipts = [];
  for (const line of out.split("\n")) {
    try {
      const m = JSON.parse(line);
      if (m.type === "user" && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) if (b.type === "tool_result") receipts.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
      }
    } catch {
      // not JSON
    }
  }
  return receipts.map((r) => r.slice(0, 300));
}

const summary = { cli: execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim(), model: MODEL, steps: {} };
const receiverKey = projectKey(REPO);
const senderKey = projectKey(SENDER_DIR);

try {
  const settings = { ignorePatterns: [".omc/"], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", claudePath: CLAUDE, model: MODEL, ghHost: "github.com" };
  await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  await request({ type: "open_project", path: REPO });
  let s = await waitFor(settled, "session open", 60_000);
  const chat = s.sessions.currentId;

  // 1. name + hold ------------------------------------------------------------
  let pid = null;
  for (let i = 0; i < 150 && !pid; i++) {
    const kids = claudeChildren();
    if (kids.length === 1 && existsSync(`/tmp/cc-socks/${kids[0]}.sock`)) pid = kids[0];
    else await sleep(100);
  }
  assert(pid, "the receiver CLI opened its messaging socket");
  const args = execFileSync("ps", ["-o", "args=", "-p", pid], { encoding: "utf8" });
  assert(args.includes("crossSessionInbound") && args.includes("--replay-user-messages"), "receiver started with hold + replay");
  // The registry entry of OUR receiver only (never another session's file, never a .key file); written just after the socket.
  const regFile = join(homedir(), ".claude", "sessions", `${pid}.json`);
  for (let i = 0; i < 100 && !existsSync(regFile); i++) await sleep(100);
  const registry = JSON.parse(readFileSync(regFile, "utf8"));
  assert(registry.name === `ReviewGate · ${basename(REPO)}`, `registry name (got ${JSON.stringify(registry.name)})`);
  assert(s.session.peerInbound === "ask", "peer mode ask");
  summary.steps.name = { registryName: registry.name, nameSource: registry.nameSource ?? null };
  log(`1. receiver pid ${pid} registered as ${JSON.stringify(registry.name)}`);

  // 2. held -------------------------------------------------------------------
  const receipt1 = await sendPeer(pid, "ReviewGate driver-peer test: please create a file named peer-note.txt in this repository containing exactly the line: hello from peer. Then stop; no reply is needed.");
  log(`2. sender receipt: ${receipt1.join(" | ").slice(0, 200)}`);
  const heldEv = await waitEvent((e) => e.type === "peer_message" && e.message.state === "held", "held", 60_000);
  s = await waitFor((x) => (x.session.peerInbox ?? []).length === 1, "inbox");
  assert(s.gate.phase === "idle" && s.hud.turnCount === 0, "nothing ran while held");
  assert(heldEv.message.cause === "explicit-setting", `held by our setting (cause ${heldEv.message.cause})`);
  summary.steps.held = { id: heldEv.message.id, fromName: heldEv.message.fromName, from: heldEv.message.from, cause: heldEv.message.cause, senderReceipt: receipt1 };

  // 3. accept → review turn ----------------------------------------------------
  const acc = await request({ type: "peer_accept", ids: [heldEv.message.id] }, 30_000);
  assert(acc.ok === true, `peer_accept ok (${JSON.stringify(acc)})`);
  const deliveredEv = await waitEvent((e) => e.type === "peer_message" && e.message.id === heldEv.message.id && e.message.state === "delivered", "delivered");
  const turnEnd = await waitEvent((e) => e.type === "turn_end", "turn_end");
  s = await waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "collected");
  log(`3. delivered body=${JSON.stringify(deliveredEv.message.body).slice(0, 100)}; review: ${s.changedFiles.map((f) => `${f.path}:${f.state}`).join(", ")}`);
  assert(/peer-note\.txt/.test(deliveredEv.message.body ?? ""), "the body arrived with the release");
  assert(typeof deliveredEv.message.verifiedPeerPid === "number", "kernel-verified sender pid");
  assert(s.changedFiles.some((f) => f.path === "peer-note.txt" && f.state === "pending"), "the peer's change is under review");
  assert(!events.some((e) => e.type === "user_message"), "no user message for a peer turn");
  assert(!events.some((e) => e.type === "error" && e.code === "unprompted_blocked"), "no unprompted banner");
  const rows = readFileSync(join(REPO, ".git", "reviewgate", "sessions", `${chat}.ndjson`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert(rows[0]?.kind === "peer_message" && rows[0].state === "delivered" && rows[0].turn === 1, "the peer row opens the turn in the transcript");
  summary.steps.accepted = { body: deliveredEv.message.body, verifiedPeerPid: deliveredEv.message.verifiedPeerPid, review: s.changedFiles.map((f) => [f.path, f.state]), turnEnd: { stopReason: turnEnd.stopReason, files: turnEnd.files, costUsd: turnEnd.usage.costUsd } };
  await request({ type: "accept_all" });

  // 4. dismiss -----------------------------------------------------------------
  const receipt2 = await sendPeer(pid, "ReviewGate driver-peer test: second message, to be dismissed.");
  const held2 = await waitEvent((e) => e.type === "peer_message" && e.message.state === "held" && e.message.id !== heldEv.message.id, "second held", 60_000);
  const dis = await request({ type: "peer_dismiss", ids: [held2.message.id] }, 30_000);
  assert(dis.ok === true, `peer_dismiss ok (${JSON.stringify(dis)})`);
  const dropped = await waitEvent((e) => e.type === "peer_message" && e.message.id === held2.message.id && e.message.state === "dropped", "dropped", 30_000);
  assert(dropped.message.outcome === "refused", `outcome refused (got ${dropped.message.outcome})`);
  s = await waitFor((x) => (x.session.peerInbox ?? []).length === 0, "inbox empty");
  log(`4. dismissed: ${dropped.message.outcome}; sender receipt: ${receipt2.join(" | ").slice(0, 160)}`);
  summary.steps.dismissed = { outcome: dropped.message.outcome, senderReceipt: receipt2 };

  // 5. resume under the same name ------------------------------------------------
  const errorsBefore = events.filter((e) => e.type === "error").length;
  await request({ type: "restart_session" });
  s = await waitFor(settled, "restarted", 60_000);
  await sleep(2500);
  const kids = claudeChildren();
  const args5 = kids.length === 1 ? execFileSync("ps", ["-o", "args=", "-p", kids[0]], { encoding: "utf8" }) : "";
  assert(new RegExp(`--resume[= ]${chat}`).test(args5) && args5.includes("--name"), "resumed with --name");
  assert(events.filter((e) => e.type === "error").length === errorsBefore, "no error on the resume");
  summary.steps.resumed = { ok: true };
  summary.errors = events.filter((e) => e.type === "error").map((e) => e.code);
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
  if (left.length > 0) process.exitCode = 1;
  // The receiver's (and, should one exist, the sender's) CLI project folders under ~/.claude/projects are scratch.
  for (const key of [receiverKey, senderKey]) {
    const dir = join(homedir(), ".claude", "projects", key);
    if (key.includes("rg-peer") || key.includes("scratchpad")) rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  log(process.exitCode ? "FAILED" : "OK");
}
