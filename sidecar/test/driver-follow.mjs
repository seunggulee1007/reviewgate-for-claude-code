#!/usr/bin/env node
// Real-CLI contract driver for docs/PROTOCOL.md §39.4 — following Claude into another worktree — through two bundled
// sidecars (one per window) on a fresh scratch repository with a second worktree next to it. Model: haiku (RG_MODEL).
//
//   node sidecar/test/driver-follow.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-follow, RE-CREATED; sidecar/dist/sidecar.mjs)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
//
// 1. Window A (repo): Claude is told a word to remember. A second turn runs `sleep`: chat_move without interrupt →
//    session_busy; with interrupt (+ followUp) → chat_moved {interrupted:true, baseline:"disk"} only after A's CLI is gone;
//    A keeps the chat as a record (movedTo) and the review of A stays in A.
// 2. Window B (the other worktree) opens: the moved chat is current, its CLI runs with --resume <same id>, the notice
//    chat_moved_in_disk names A's folder, the follow-up goes out once.
// 3. In B the same conversation still knows the word, and an edit Claude makes in B is in B's review.
// Cleans up ~/.claude/projects/<scratch keys>, checks no CLI child is left, prints what was observed as JSON.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-follow");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 180_000;
const WORD = `COBALT${Math.floor(Math.random() * 9000 + 1000)}`;

const t0 = Date.now();
const log = (m) => process.stderr.write(`[follow +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const observed = { cli: null, model: MODEL, word: WORD, failures: [] };
const check = (cond, msg) => {
  log(`${cond ? "OK  " : "FAIL"} ${msg}`);
  if (!cond) observed.failures.push(msg);
  return cond;
};
/** The CLI's ~/.claude/projects key of a cwd (§30; < 200 chars here). */
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");

// ---------------------------------------------------------------- scratch: a repository and a worktree next to it
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
// The app-wide records (§36.8 cli-versions.json) go to the scratch folder, never the user's ~/.reviewgate.
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };
const REPO = join(ROOT, "repo");
const WT2 = join(ROOT, "repo-4176-17");
mkdirSync(REPO, { recursive: true });
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
git(REPO, "init", "-q", "-b", "main");
git(REPO, "config", "user.email", "follow@example.com");
git(REPO, "config", "user.name", "follow");
writeFileSync(join(REPO, "a.txt"), "one\n");
git(REPO, "add", "-A");
git(REPO, "commit", "-q", "-m", "init");
git(REPO, "worktree", "add", "-q", "-b", "feature/4176-17", WT2);

// ---------------------------------------------------------------- one sidecar = one window
function windowOf(name) {
  const w = { name, state: null, events: [], waiters: [], replies: new Map(), nextId: 1, text: "" };
  w.child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
  createInterface({ input: w.child.stderr }).on("line", (l) => {
    if (/chat_move|moved|handoff|incoming|resum/i.test(l) && !/:debug\]/.test(l)) process.stderr.write(`  [${name}] ${l.slice(0, 240)}\n`);
  });
  w.exited = new Promise((resolve) => w.child.on("exit", resolve));
  w.send = (cmd) => w.child.stdin.write(JSON.stringify(cmd) + "\n");
  createInterface({ input: w.child.stdout }).on("line", (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "state") w.state = ev.state;
    else {
      w.events.push(ev);
      if (ev.type === "text_delta" && !ev.unprompted) w.text += ev.text;
      else if (ev.type === "permission_request") {
        log(`${name}: card ${ev.toolName}${ev.reason ? ` reason=${ev.reason.code}` : ""} → allow`);
        w.send({ type: "permission_response", requestId: ev.requestId, allow: true });
      } else if (ev.type === "tool_use") log(`${name}: tool_use ${ev.name} ${JSON.stringify(ev.input).slice(0, 100)}`);
      else if (ev.type === "error") log(`${name}: error(${ev.code ?? ""} fatal=${ev.fatal}) ${String(ev.message).slice(0, 140)}`);
      else if (["chat_moved", "turn_end", "session_ready"].includes(ev.type)) log(`${name}: event ${ev.type}`);
    }
    if (ev.id && w.replies.has(ev.id)) w.replies.get(ev.id)(ev);
    for (const x of [...w.waiters]) if (w.state && x.pred(w.state)) {
      w.waiters.splice(w.waiters.indexOf(x), 1);
      x.resolve(w.state);
    }
  });
  /** Resolves with the reply (a refusal too: `{ok:false, code}`). */
  w.request = (cmd) => {
    const id = `${name}${w.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name}: no reply for ${cmd.type}`)), STEP_TIMEOUT_MS);
      w.replies.set(id, (ev) => {
        clearTimeout(timer);
        w.replies.delete(id);
        resolve(ev);
      });
      w.send({ ...cmd, id });
    });
  };
  w.waitState = (pred, what, ms = STEP_TIMEOUT_MS) =>
    w.state && pred(w.state)
      ? Promise.resolve(w.state)
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${name}: timed out waiting for ${what}; phase=${w.state?.gate.phase}`)), ms);
          w.waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
        });
  w.waitEvent = async (pred, what, ms = STEP_TIMEOUT_MS) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = w.events.find(pred);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${name}: timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  w.cliArgs = () => {
    let pids = [];
    try {
      pids = execFileSync("pgrep", ["-P", String(w.child.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    } catch {
      /* none */
    }
    return pids.map((p) => {
      try {
        return execFileSync("ps", ["-o", "args=", "-p", p], { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    }).filter(Boolean);
  };
  return w;
}

const settings = {
  ignorePatterns: [".omc/"], autoAllowTools: [], loadUserSettings: false,
  systemPromptAppend: "You are running inside ReviewGate test. Do exactly what is asked, nothing else.",
  claudePath: CLAUDE, model: MODEL, ghHost: "github.com",
};
const idle = (s) => s.gate.phase !== "running" && s.gate.phase !== "collecting";
const ready = (s) => s.session.open && !s.session.starting;
async function turn(w, text) {
  const before = w.state.hud.turnCount;
  w.text = "";
  const r = await w.request({ type: "send", text, acceptPending: true });
  if (r.type === "result" && !r.ok) throw new Error(`${w.name}: send refused: ${r.error}`);
  await w.waitState((s) => s.hud.turnCount > before && idle(s), "turn end");
  return w.text;
}

const A = windowOf("A");
let B = null;
try {
  observed.cli = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
  await A.request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  await A.request({ type: "open_project", path: REPO });
  await A.waitState(ready, "A: session open");

  // 1. ------------------------------------------------------------ remember, then a running turn that is stopped for the move
  await turn(A, `Remember this secret word for later: ${WORD}. Reply with just OK.`);
  const chatId = A.state.sessions.currentId;
  observed.chatId = chatId;
  check(typeof chatId === "string" && chatId.length > 0, "A has a current chat");

  await A.request({ type: "send", text: "Use the Bash tool to run exactly: sleep 20 && echo slept. Then reply DONE." });
  await A.waitEvent((e) => e.type === "tool_use" && e.name === "Bash", "A: the Bash call", 90_000);
  await sleep(1500);
  const busy = await A.request({ type: "chat_move", path: WT2 });
  check(busy.type === "result" && busy.ok === false && busy.code === "session_busy", `chat_move without interrupt mid-turn → session_busy (got ${busy.code ?? busy.ok})`);
  const outside = await A.request({ type: "chat_move", path: ROOT });
  check(outside.ok === false && (outside.code === "not_a_worktree" || outside.code === "session_busy"), `a folder outside the repository is refused (got ${outside.code})`);
  const followUp = "The working folder moved to repo-4176-17. Please continue what you were doing.";
  const moved = await A.request({ type: "chat_move", path: WT2, interrupt: true, followUp });
  check(moved.type === "result" && moved.ok === true, `chat_move with interrupt → ok (${moved.error ?? ""})`);
  const ev = await A.waitEvent((e) => e.type === "chat_moved", "A: chat_moved", 30_000);
  observed.chatMoved = ev;
  check(ev.sessionId === chatId && ev.path === WT2 && ev.interrupted === true && ev.baseline === "disk", "chat_moved names the chat, the worktree, interrupted, baseline disk");
  check(A.cliArgs().every((a) => !a.includes(chatId)), "A no longer runs a CLI on that conversation");
  await A.waitState((s) => s.sessions.list.some((m) => m.id === chatId && m.movedTo?.path === WT2), "A: the chat is a record (movedTo)", 30_000);
  check(true, "A keeps the chat as a record (movedTo)");
  const incoming = join(git(WT2, "rev-parse", "--absolute-git-dir"), "reviewgate", "incoming");
  observed.incoming = existsSync(incoming) ? readdirSync(incoming) : [];
  check(observed.incoming.includes(`${chatId}.json`), "the handoff waits in the worktree's reviewgate/incoming/");
  check(A.state.sessions.currentId === chatId && A.state.sessions.list.some((m) => m.id === chatId), "A still shows the chat (as a record)");

  // 2. ------------------------------------------------------------ window B opens the worktree and takes the chat
  B = windowOf("B");
  await B.request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  await B.request({ type: "open_project", path: WT2 });
  await B.waitState(ready, "B: session open");
  check(B.state.sessions.currentId === chatId, "B: the moved chat is current");
  const args = B.cliArgs();
  observed.bCli = args.map((a) => a.replace(/^.*?(--resume[= ]\S+).*$/, "$1"));
  check(args.some((a) => new RegExp(`--resume[= ]${chatId}`).test(a)), "B: the CLI resumes the same conversation");
  const notice = await B.waitEvent((e) => e.type === "error" && (e.code === "chat_moved_in_disk" || e.code === "chat_moved_in"), "B: the moved-in notice", 30_000);
  check(notice.code === "chat_moved_in_disk" && notice.path === REPO && notice.fatal === false, "B: chat_moved_in_disk names A's folder");
  check(!existsSync(join(incoming, `${chatId}.json`)), "B took the handoff");
  // The follow-up goes out once as a normal turn.
  await B.waitEvent((e) => e.type === "turn_end", "B: the follow-up turn", STEP_TIMEOUT_MS);
  await B.waitState(idle, "B: the follow-up turn collected");
  observed.followUpTurns = B.events.filter((e) => e.type === "turn_end").length;
  check(observed.followUpTurns === 1, "B: the follow-up went out once");

  // 3. ------------------------------------------------------------ the same conversation, reviewed here
  const answer = await turn(B, "What was the secret word I told you to remember? Reply with just the word.");
  observed.answer = answer.trim().slice(0, 80);
  check(answer.includes(WORD), `B: the conversation remembers ${WORD} (answered ${JSON.stringify(observed.answer)})`);
  await turn(B, "Use the Write tool to create note.txt containing exactly the line: moved. Then reply DONE.");
  await sleep(1000);
  const files = B.state.changedFiles.map((f) => `${f.path}:${f.state}`);
  observed.bReview = files;
  check(B.state.changedFiles.some((f) => f.path === "note.txt" && f.state === "pending"), "B: the edit made after the move is in B's review");
  check(!A.state.changedFiles.some((f) => f.path === "note.txt"), "A's review does not see it");
} catch (e) {
  log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  observed.failures.push(e instanceof Error ? e.message : String(e));
} finally {
  for (const w of [A, B].filter(Boolean)) {
    w.send({ type: "shutdown" });
    await Promise.race([w.exited, sleep(8000)]);
    const left = w.cliArgs();
    if (left.length > 0) {
      observed.failures.push(`${w.name}: leftover CLI children`);
      try {
        w.child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  for (const cwd of [REPO, WT2]) {
    const key = projectKey(cwd);
    if (key.includes("rg-follow") || key.includes("scratchpad")) rmSync(join(homedir(), ".claude", "projects", key), { recursive: true, force: true });
  }
  process.exitCode = observed.failures.length ? 1 : 0;
  process.stdout.write(JSON.stringify(observed, null, 2) + "\n");
  log(observed.failures.length ? `FAILED (${observed.failures.length})` : "OK");
}
