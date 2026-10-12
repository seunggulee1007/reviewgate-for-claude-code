#!/usr/bin/env node
// Real-CLI contract driver for docs/PROTOCOL.md §34.1–34.5 — review round 2, the review half: the diff being read survives a
// send, accept during a turn, "this turn" / "since the request" / "since the accept" ranges, notes that survive
// request_changes, blob. Through the bundled sidecar on a fresh scratch repo. Model: haiku (RG_MODEL), a few cents per run.
//
//   node sidecar/test/driver-review2.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-review2, RE-CREATED; sidecar/dist/sidecar.mjs)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
//
// 1. Turn 1 edits Svc.java and writes new.txt → reviewing; changedThisTurn / blob; turn_end counts this turn.
// 2. A question (it sleeps 4 s in Bash, changes nothing) is sent with both files pending: while it runs select_file /
//    full_file answer from the held B (stale), accept Svc.java applies at once; afterwards turn_end counts 0 files (merged),
//    no turn_summary, Svc.java is still accepted.
// 3. A turn edits new.txt; new.txt is accepted right after the send → after the collection it is pending with
//    changedSinceAccepted, `since: "accepted"` / `since: "turn"` show only that edit.
// 4. A note + request_changes: the follow-up rewrites the line; the note stays (sent), lastRequest, changedSinceRequest,
//    `since: "request"`, review_history.current.
// Cleans up ~/.claude/projects/<scratch key> afterwards, checks no CLI child is left, prints what was observed as JSON.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-review2");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 240_000;

const t0 = Date.now();
const log = (m) => process.stderr.write(`[review2 +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const observed = { cli: null, model: MODEL, failures: [] };
const check = (cond, msg) => {
  log(`${cond ? "OK  " : "FAIL"} ${msg}`);
  if (!cond) observed.failures.push(msg);
};
/** The CLI's ~/.claude/projects key of a cwd (§30; < 200 chars here). */
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
const adds = (d) => d.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.text));
const dels = (d) => d.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "del").map((l) => l.text));

// ---------------------------------------------------------------- scratch repo
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
// The app-wide records (§36.8 cli-versions.json) go to the scratch folder, never the user's ~/.reviewgate.
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };
const REPO = join(ROOT, "repo");
mkdirSync(REPO, { recursive: true });
const git = (...a) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "review2@example.com");
git("config", "user.name", "review2");
const svc = Array.from({ length: 20 }, (_, i) => `v${String(i + 1).padStart(2, "0")}`); // unique lines: an Edit old_string matches once
writeFileSync(join(REPO, "Svc.java"), svc.join("\n") + "\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

// ---------------------------------------------------------------- sidecar plumbing
let state = null;
let nextId = 1;
const waiters = [];
const replies = new Map();
const events = [];
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
      log(`permission_request ${ev.toolName} ${JSON.stringify(ev.input).slice(0, 100)} → allow`);
      send({ type: "permission_response", requestId: ev.requestId, allow: true });
    } else if (ev.type === "tool_use") log(`tool_use ${ev.name} ${JSON.stringify(ev.input).slice(0, 120)}`);
    else if (ev.type === "error") log(`error(${ev.scope} ${ev.code ?? ""}): ${ev.message.slice(0, 160)}`);
    else if (!["log", "activity", "text_delta", "tool_result", "tool_files", "mcp_status"].includes(ev.type)) log(`event ${ev.type}`);
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) if (state && w.pred(state)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(state);
  }
});
const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");
/** The typed reply (or `result`); a refusal resolves too (`ev.ok === false`) unless `strict`. */
const request = (cmd, strict = true) => {
  const id = `r${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type}`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      if (strict && ev.type === "result" && !ev.ok) reject(new Error(`${cmd.type} failed: ${ev.error}`));
      else resolve(ev);
    });
    send({ ...cmd, id });
  });
};
const waitState = (pred, what) =>
  state && pred(state)
    ? Promise.resolve(state)
    : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; phase=${state?.gate.phase}`)), STEP_TIMEOUT_MS);
        waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
      });
const claudeChildren = () => {
  try {
    return execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
/** Runs `cmd` (a send / request_changes) and resolves once its turn was collected (the turn count moved, nothing in flight). */
async function turn(cmd, during = async () => {}) {
  const before = state.hud.turnCount;
  await request(cmd);
  await during();
  await waitState((s) => s.hud.turnCount > before && s.gate.phase !== "running" && s.gate.phase !== "collecting", `${cmd.type} turn collected`);
  await sleep(800); // turn_end / turn_summary and the tail of the collection
  return state;
}
const say = (text) => ({ type: "send", text });
const file = (s, p) => s.changedFiles.find((f) => f.path === p);
/** The first snapshot (now or within `ms`) that satisfies `pred`, else null. */
const soon = (pred, ms = 3000) => Promise.race([waitState(pred, "snapshot").catch(() => null), sleep(ms).then(() => null)]);
const lastOf = (type) => events.filter((e) => e.type === type).at(-1);
const countOf = (type) => events.filter((e) => e.type === type).length;

try {
  observed.cli = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
  await request({
    type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" },
    settings: {
      ignorePatterns: [".omc/"], autoAllowTools: [], loadUserSettings: false,
      systemPromptAppend: "You are running inside ReviewGate. Do exactly the requested steps, in order, then stop. Never run git commands.",
      claudePath: CLAUDE, model: MODEL, ghHost: "github.com",
    },
  });
  await request({ type: "open_project", path: REPO });
  await waitState((s) => s.session.open && !s.session.starting, "session open");

  // ---- 1. a fresh turn
  let s = await turn(say("Do exactly this, nothing else: 1. Use the Edit tool on Svc.java to replace the line `v02` with `v02 changed`. 2. Use the Write tool to create new.txt containing the single line `brand new`. Then reply DONE."));
  const b1 = s.gate.turnEndTree;
  const a = s.gate.turnStartTree;
  observed.turn1 = { files: s.changedFiles.map((f) => [f.path, f.state, f.changedThisTurn ?? false, f.blob ?? null]), turnEnd: lastOf("turn_end") && { files: lastOf("turn_end").files, review: lastOf("turn_end").review, merged: lastOf("turn_end").merged ?? false } };
  check(file(s, "Svc.java")?.state === "pending" && file(s, "new.txt")?.state === "pending", "turn 1: Svc.java and new.txt pending");
  check(s.changedFiles.every((f) => f.changedThisTurn === true), "turn 1: every file changedThisTurn");
  check(file(s, "Svc.java")?.blob === git("rev-parse", `${b1}:Svc.java`), "turn 1: blob = B:Svc.java");
  check(s.gate.reviewEndTree === b1 && s.gate.lastTurnChanges?.files === 2, "turn 1: reviewEndTree = B, lastTurnChanges.files = 2");
  check(lastOf("turn_end")?.files === 2 && lastOf("turn_end")?.review?.files === 2 && !lastOf("turn_end")?.merged, "turn 1: turn_end counts 2 files, not merged");
  const summaries1 = countOf("turn_summary");

  // ---- 2. a question while both files are pending: the held B stays readable, accept applies at once
  const reads = {};
  s = await turn(say("Use the Bash tool to run exactly: sleep 4 — then, without changing any file, reply with the single word OK."), async () => {
    await sleep(300);
    reads.phase = state.gate.phase;
    reads.reviewEndTree = state.gate.reviewEndTree;
    reads.turnEndTree = state.gate.turnEndTree;
    const d = await request({ type: "select_file", path: "Svc.java" });
    reads.diff = { stale: d.stale ?? false, endTree: d.endTree, baseTree: d.baseTree, adds: adds(d.diff) };
    const ff = await request({ type: "full_file", path: "Svc.java" });
    reads.full = { stale: ff.stale ?? false, endTree: ff.endTree, line2: ff.lines[1] };
    const acc = await request({ type: "accept", paths: ["Svc.java"] }, false);
    reads.accept = acc.ok;
    // The `result` goes out before the snapshot that shows it (state is coalesced): wait for that snapshot.
    const after = await soon((x) => file(x, "Svc.java")?.state === "accepted");
    reads.stateAfterAccept = after ? "accepted" : file(state, "Svc.java")?.state;
    reads.phaseAfter = (after ?? state).gate.phase;
  });
  observed.question = { ...reads, turnEnd: { files: lastOf("turn_end").files, review: lastOf("turn_end").review, merged: lastOf("turn_end").merged ?? false }, summaries: countOf("turn_summary") - summaries1 };
  check(reads.phase === "running" && reads.turnEndTree === null && reads.reviewEndTree === b1, "question: while it runs turnEndTree is null and reviewEndTree is the held B");
  check(reads.diff.stale && reads.diff.endTree === b1 && reads.diff.baseTree === a && reads.diff.adds.includes("v02 changed"), "question: select_file answers from the held B (stale)");
  check(reads.full.stale && reads.full.endTree === b1 && reads.full.line2 === "v02 changed", "question: full_file answers from the held B (stale)");
  check(reads.accept === true && reads.stateAfterAccept === "accepted" && reads.phaseAfter === "running", "question: accept during the turn applied at once");
  check(lastOf("turn_end").files === 0 && lastOf("turn_end").merged === true && lastOf("turn_end").review?.files === 2, "question: turn_end counts 0 files (merged), review totals 2");
  check(countOf("turn_summary") === summaries1, "question: no turn_summary for a turn that changed nothing");
  check(file(s, "Svc.java")?.state === "accepted" && s.changedFiles.every((f) => !f.changedThisTurn), "question: Svc.java still accepted, no changedThisTurn");
  check(s.gate.lastReviewSummary?.includes("Accepted: Svc.java") === true, "question: the accept is in the next message's summary");

  // ---- 3. a turn that edits a file accepted right after the send
  const b2 = s.gate.turnEndTree;
  s = await turn(say("Use the Edit tool on new.txt to replace `brand new` with `brand new v2`. Then reply DONE."), async () => {
    const acc = await request({ type: "accept", paths: ["new.txt"] }, false);
    const after = await soon((x) => file(x, "new.txt")?.state === "accepted");
    observed.acceptDuringEdit = { ok: acc.ok, state: after ? "accepted" : file(state, "new.txt")?.state, phase: (after ?? state).gate.phase };
  });
  const sinceAccepted = await request({ type: "select_file", path: "new.txt", since: "accepted" });
  const sinceTurn = await request({ type: "select_file", path: "new.txt", since: "turn" });
  const svcTurn = await request({ type: "select_file", path: "Svc.java", since: "turn" });
  observed.edit = {
    files: s.changedFiles.map((f) => [f.path, f.state, f.changedSinceAccepted ?? false, f.changedThisTurn ?? false]),
    sinceAccepted: { baseTree: sinceAccepted.baseTree, adds: adds(sinceAccepted.diff), dels: dels(sinceAccepted.diff) },
    sinceTurn: { adds: adds(sinceTurn.diff), dels: dels(sinceTurn.diff) },
    svcTurnHunks: svcTurn.diff.hunks.length,
    summaryFiles: lastOf("turn_summary")?.files.map((f) => [f.path, f.adds, f.dels, f.reviewAdds, f.reviewDels]),
  };
  check(observed.acceptDuringEdit.ok === true && observed.acceptDuringEdit.state === "accepted", "edit: new.txt accepted during the turn");
  check(file(s, "new.txt")?.state === "pending" && file(s, "new.txt")?.changedSinceAccepted === true, "edit: the turn changed it — pending again with changedSinceAccepted");
  check(file(s, "Svc.java")?.state === "accepted", "edit: Svc.java (untouched) stays accepted");
  check(sinceAccepted.baseTree === b2 && adds(sinceAccepted.diff).includes("brand new v2") && !adds(sinceAccepted.diff).includes("v02 changed"), "edit: since accepted = held B → new B, only the v2 edit");
  check(adds(sinceTurn.diff).includes("brand new v2") && dels(sinceTurn.diff).includes("brand new"), "edit: since turn shows only this turn's edit of new.txt");
  check(svcTurn.diff.hunks.length === 0, "edit: Svc.java has no change this turn");
  check(!(s.gate.lastReviewSummary ?? "").includes("new.txt"), "edit: new.txt left the summary's accepted list");
  check(lastOf("turn_end").files === 1 && lastOf("turn_end").merged === true, "edit: turn_end counts this turn's 1 file");

  // ---- 4. a note and request_changes: the note stays (sent), "since the request" shows what the follow-up did
  await request({ type: "add_note", path: "Svc.java", line: 2, side: "new", excerpt: "v02 changed", body: "Change this line to exactly `v02 final` with the Edit tool. Change nothing else." });
  const b3 = state.gate.turnEndTree;
  s = await turn({ type: "request_changes" }, async () => {
    observed.requestRunning = { notes: state.reviewNotes.map((n) => ({ sent: n.sent ?? null })), lastRequest: state.gate.lastRequest, canRequestChanges: state.gate.canRequestChanges, svc: { state: file(state, "Svc.java")?.state, noteCount: file(state, "Svc.java")?.noteCount, sentNoteCount: file(state, "Svc.java")?.sentNoteCount ?? 0 } };
  });
  const sinceRequest = await request({ type: "select_file", path: "Svc.java", since: "request" });
  const history = await request({ type: "review_history" });
  observed.request = {
    notes: s.reviewNotes.map((n) => ({ line: n.line, anchor: n.anchor ?? null, sent: n.sent ?? null })),
    lastRequest: s.gate.lastRequest,
    files: s.changedFiles.map((f) => [f.path, f.state, f.changedSinceRequest ?? false, f.noteCount, f.sentNoteCount ?? 0]),
    sinceRequest: { baseTree: sinceRequest.baseTree, adds: adds(sinceRequest.diff), dels: dels(sinceRequest.diff) },
    current: history.current && { inProgress: history.current.inProgress, turns: history.current.turns, notes: history.current.notes.length },
    entries: history.entries.length,
  };
  const turnNo = observed.requestRunning.lastRequest?.turn;
  check(observed.requestRunning.notes.every((n) => n.sent?.turn === turnNo) && observed.requestRunning.lastRequest?.notes === 1, "request: the note is marked sent with the follow-up's turn; lastRequest");
  check(observed.requestRunning.canRequestChanges === false && observed.requestRunning.svc.noteCount === 0 && observed.requestRunning.svc.sentNoteCount === 1, "request: no unsent note left (noteCount 0, sentNoteCount 1)");
  check(s.reviewNotes.length === 1 && s.reviewNotes[0].sent?.turn === turnNo, "request: the follow-up kept the sent note");
  check(file(s, "Svc.java")?.changedSinceRequest === true && file(s, "new.txt")?.changedSinceRequest !== true, "request: changedSinceRequest only on the file the follow-up changed");
  check(sinceRequest.baseTree === b3 && adds(sinceRequest.diff).some((t) => t.includes("v02 final")) && dels(sinceRequest.diff).includes("v02 changed"), "request: since request = the request's B → new B");
  check(history.current?.inProgress === true && history.entries.length === 0 && history.current.notes.length === 1, "request: review_history.current is the round in progress");

  observed.rangePinsBeforeFinish = git("for-each-ref", "--format=%(refname)", "refs/reviewgate/main/range/").split("\n").filter(Boolean).length;
  check(observed.rangePinsBeforeFinish > 0, "the range trees are pinned while the review stands");
  await request({ type: "finish_review" });
  await waitState((x) => x.changedFiles.length === 0, "finish_review snapshot").catch(() => state);
  for (let i = 0; i < 50 && git("for-each-ref", "refs/reviewgate/main/range/") !== ""; i++) await sleep(100);
  check(git("for-each-ref", "refs/reviewgate/main/range/") === "", "the range pins went with the review");
  await request({ type: "shutdown" });
  const { code } = await Promise.race([exited, sleep(10_000).then(() => ({ code: "timeout" }))]);
  check(code === 0, `sidecar exited 0 (got ${code})`);
} catch (e) {
  observed.failures.push(String(e));
  log(String(e));
  child.kill("SIGKILL");
} finally {
  const left = claudeChildren();
  observed.leftoverChildren = left.length;
  if (left.length > 0) observed.failures.push(`leftover CLI children: ${left.join(", ")}`);
  // The CLI project folder of the scratch repo is scratch too.
  const key = projectKey(REPO);
  if (key.includes("rg-review2") || key.includes("scratchpad")) rmSync(join(homedir(), ".claude", "projects", key), { recursive: true, force: true });
  process.stdout.write(JSON.stringify(observed, null, 2) + "\n");
  log(observed.failures.length > 0 ? "FAILED" : "OK");
  process.exit(observed.failures.length > 0 ? 1 : 0);
}
