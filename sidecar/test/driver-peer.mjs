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
// The receiver runs with peerInbound "ask" for these steps (the default is "auto" since r2-peers).
//
// RG_ONLY=auto (r2-peers, §29 / §33.2): two engine sessions instead — A (the sender, a ReviewGate sidecar in auto mode on
// RG_MODEL, default sonnet: haiku has no auto mode) is asked to SendMessage B (the receiver, another sidecar with the
// default peerInbound) a request to create peer-auto.txt. A gets no permission card for it; B holds the message, finds
// A's CLI in the registry (`sender`), runs it as a review turn by itself (no peer_accept from the driver), and the file
// is in B's review. Two model turns.
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
const ONLY_AUTO = process.env.RG_ONLY === "auto"; // MARK: r2-peers
const MODEL = process.env.RG_MODEL ?? (ONLY_AUTO ? "sonnet" : "haiku");
const RECEIVER_MODEL = process.env.RG_RECEIVER_MODEL ?? "haiku";
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

// ---------------------------------------------------------------- r2-peers: A → B, both ReviewGate sessions
class SkipToAuto extends Error {}

/** A second (or third) sidecar of this driver: its own state, events and request plumbing. */
function startSidecar(tag) {
  const sc = { tag, state: null, events: [], replies: new Map(), next: 1 };
  sc.child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
  createInterface({ input: sc.child.stderr }).on("line", (l) => {
    if (/peer|held|released|SendMessage|unprompted|auto/i.test(l)) log(`${tag} STDERR ${l.slice(0, 200)}`);
  });
  sc.exited = new Promise((r) => sc.child.on("exit", r));
  sc.send = (cmd) => sc.child.stdin.write(JSON.stringify(cmd) + "\n");
  createInterface({ input: sc.child.stdout }).on("line", (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "state") sc.state = ev.state;
    else sc.events.push(ev);
    if (ev.type === "peer_message") log(`${tag} peer_message ${ev.message.state} sender=${ev.message.sender?.name ?? "-"} body=${JSON.stringify(ev.message.body ?? null).slice(0, 80)}`);
    if (ev.type === "permission_request") {
      log(`${tag} permission_request ${ev.toolName} ${JSON.stringify(ev.input).slice(0, 100)} → deny`);
      sc.send({ type: "permission_response", requestId: ev.requestId, allow: false, message: "driver-peer: no card is expected here" });
    }
    if (ev.id && sc.replies.has(ev.id)) sc.replies.get(ev.id)(ev);
  });
  sc.request = (cmd, ms = 60_000) =>
    new Promise((resolve) => {
      const id = `${tag}${sc.next++}`;
      const timer = setTimeout(() => {
        sc.replies.delete(id);
        resolve({ timeout: true });
      }, ms);
      sc.replies.set(id, (ev) => {
        clearTimeout(timer);
        sc.replies.delete(id);
        resolve(ev);
      });
      sc.send({ ...cmd, id });
    });
  sc.waitFor = async (pred, what, ms = STEP_TIMEOUT_MS) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (sc.state && pred(sc.state)) return sc.state;
      if (Date.now() > deadline) throw new Error(`${tag}: timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  sc.waitEvent = async (pred, what, ms = STEP_TIMEOUT_MS) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = sc.events.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`${tag}: timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  sc.children = () => {
    try {
      return execFileSync("pgrep", ["-P", String(sc.child.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  sc.stop = async () => {
    sc.send({ type: "shutdown" });
    await Promise.race([sc.exited, sleep(8000)]);
    if (sc.child.exitCode === null) sc.child.kill("SIGKILL");
  };
  return sc;
}

function scratchRepo(dir, name) {
  mkdirSync(dir, { recursive: true });
  const g = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "peer@example.com");
  g("config", "user.name", "peer");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(join(dir, ".gitignore"), ".omc/\n");
  g("add", "-A");
  g("commit", "-q", "-m", `${name}: init`);
}

/** The CLI of sidecar `sc` once it opened its messaging socket (the only child of that sidecar). */
async function cliWithSocket(sc) {
  for (let i = 0; i < 150; i++) {
    const kids = sc.children();
    if (kids.length === 1 && existsSync(`/tmp/cc-socks/${kids[0]}.sock`)) return kids[0];
    await sleep(100);
  }
  throw new Error(`${sc.tag}: its CLI opened no messaging socket`);
}

async function autoScenario() {
  const repoA = join(ROOT, "auto-a");
  const repoB = join(ROOT, "auto-b");
  scratchRepo(repoA, "acme-sender");
  scratchRepo(repoB, "acme-receiver");
  const base = { ignorePatterns: [".omc/"], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "You are running inside a ReviewGate test. Do exactly what each message asks, nothing more.", claudePath: CLAUDE, ghHost: "github.com" };
  const A = startSidecar("A");
  const B = startSidecar("B");
  const out = { model: MODEL, receiverModel: RECEIVER_MODEL };
  try {
    // B first: the default peer mode (auto since r2-peers).
    await B.request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings: { ...base, model: RECEIVER_MODEL } });
    await B.request({ type: "open_project", path: repoB });
    await B.waitFor((s) => s.session.open && !s.session.starting, "B open", 60_000);
    assert(B.state.session.peerInbound === "auto", `B's default peer mode is auto (got ${B.state.session.peerInbound})`);
    const pidB = await cliWithSocket(B);
    const parent = execFileSync("ps", ["-o", "ppid=", "-p", String(pidB)], { encoding: "utf8" }).trim();
    assert(parent === String(B.child.pid), `refusing to message pid ${pidB}: its parent ${parent} is not sidecar B ${B.child.pid}`);
    // A in auto mode.
    await A.request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings: { ...base, model: MODEL, permissionMode: "auto" } });
    await A.request({ type: "open_project", path: repoA });
    await A.waitFor((s) => s.session.open && !s.session.starting, "A open", 60_000);
    const pidA = await cliWithSocket(A);
    log(`A cli ${pidA}, B cli ${pidB}`);
    const text = "ReviewGate driver-peer auto test: please create a file named peer-auto.txt in this repository containing exactly the line: hello from A. Then stop; no reply is needed.";
    const sent = await A.request({ type: "send", text: `Use the SendMessage tool exactly once (load it with ToolSearch first if you need to). Send this exact message text: '${text}' to this exact address: uds:/tmp/cc-socks/${pidB}.sock . Never send to any other address and use no other tool. After the single send, reply with the word DONE.` }, 30_000);
    assert(sent.ok === true, `A's send was accepted (${JSON.stringify(sent)})`);
    await A.waitEvent((e) => e.type === "turn_end", "A's turn end");
    const call = A.events.find((e) => e.type === "tool_use" && e.name === "SendMessage");
    const callResult = call ? A.events.find((e) => e.type === "tool_result" && e.toolUseId === call.id) : undefined;
    out.sender = {
      sendMessage: call ? { to: call.input?.to ?? null } : null,
      result: callResult ? { isError: callResult.isError, preview: String(callResult.preview ?? "").slice(0, 160) } : null,
      cards: A.events.filter((e) => e.type === "permission_request").map((e) => e.toolName),
    };
    assert(call && call.input?.to === `uds:/tmp/cc-socks/${pidB}.sock`, "A called SendMessage to B's address");
    assert(out.sender.cards.length === 0, `A got no permission card (got ${out.sender.cards.join(", ")})`);
    assert(callResult && callResult.isError === false, "the SendMessage call went through");
    // B runs it by itself.
    const held = await B.waitEvent((e) => e.type === "peer_message" && e.message.state === "held", "B held", 60_000);
    const delivered = await B.waitEvent((e) => e.type === "peer_message" && e.message.state === "delivered", "B delivered");
    await B.waitEvent((e) => e.type === "turn_end", "B's turn end");
    const s = await B.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "B collected");
    out.receiver = {
      cause: held.message.cause,
      sender: delivered.message.sender ? { pid: delivered.message.sender.pid, name: delivered.message.sender.name, entrypoint: delivered.message.sender.entrypoint } : null,
      body: String(delivered.message.body ?? "").slice(0, 160),
      verifiedPeerPid: delivered.message.verifiedPeerPid,
      review: s.changedFiles.map((f) => [f.path, f.state]),
      cards: B.events.filter((e) => e.type === "permission_request").map((e) => e.toolName),
      unprompted: B.events.filter((e) => e.type === "error" && e.code === "unprompted_blocked").length,
    };
    assert(delivered.message.sender && String(delivered.message.sender.pid) === String(pidA), `B found A's CLI in the registry (sender ${JSON.stringify(delivered.message.sender)})`);
    assert(/peer-auto\.txt/.test(out.receiver.body), "the body arrived");
    assert(s.changedFiles.some((f) => f.path === "peer-auto.txt" && f.state === "pending"), "B's turn's file is under review");
    assert(out.receiver.unprompted === 0, "no unprompted banner in B");
    return out;
  } finally {
    await A.stop();
    await B.stop();
    out.leftoverChildren = A.children().length + B.children().length;
    if (out.leftoverChildren > 0) process.exitCode = 1;
  }
}

const summary = { cli: execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim(), model: MODEL, steps: {} };
const receiverKey = projectKey(REPO);
const senderKey = projectKey(SENDER_DIR);

try {
  if (ONLY_AUTO) throw new SkipToAuto();
  // r2-peers: "auto" is the default now — the hold / accept / dismiss steps ask, as before.
  const settings = { ignorePatterns: [".omc/"], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", claudePath: CLAUDE, model: MODEL, ghHost: "github.com", peerInbound: "ask" };
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
  if (e instanceof SkipToAuto) {
    try {
      summary.auto = await autoScenario();
    } catch (err) {
      log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  } else {
    log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
} finally {
  // The receiver of the ask steps never got hello in RG_ONLY=auto: it is simply stopped.
  if (ONLY_AUTO) child.kill("SIGTERM");
  else send({ type: "shutdown" });
  await new Promise((r) => {
    child.on("exit", r);
    setTimeout(r, 8000);
  });
  const left = claudeChildren();
  summary.leftoverChildren = left.length;
  if (left.length > 0) process.exitCode = 1;
  // The receiver's (and, should one exist, the sender's) CLI project folders under ~/.claude/projects are scratch.
  for (const key of [receiverKey, senderKey, projectKey(join(ROOT, "auto-a")), projectKey(join(ROOT, "auto-b"))]) {
    const dir = join(homedir(), ".claude", "projects", key);
    if (key.includes("rg-peer") || key.includes("scratchpad") || key.includes("rg-driver-scratch")) rmSync(dir, { recursive: true, force: true });
  }
  if (ONLY_AUTO && process.env.RG_KEEP_SCRATCH !== "1") rmSync(ROOT, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  log(process.exitCode ? "FAILED" : "OK");
}
