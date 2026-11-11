#!/usr/bin/env node
// Real-CLI check for docs/PROTOCOL.md §50.3 (taking a message back from Claude's turn), two turns in one session:
// - in time: while a `sleep 8` runs, a message is steered in and taken back (`steer_take_back`) before the call ends —
//   the take-back succeeds, the message never gets a row, nothing waits, and the reply never shows the word it asked for;
// - too late: while a `sleep 5` runs, a message is steered in; once Claude read it (its steered row) the take-back is
//   refused `steer_already_read`, the row stays, there is no second row, and the reply has the word it asked for.
// Through the bundled sidecar on a fresh scratch repository (loadUserSettings off). Model calls on RG_MODEL (default haiku).
//
//   node sidecar/test/driver-steer-takeback.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-steer-takeback, RE-CREATED)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
// Prints what was observed as JSON; exits 1 when either case went otherwise.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-steer-takeback");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => process.stderr.write(`[takeback +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
// The app-wide records (§36.8 cli-versions.json) go to the scratch folder, never the user's ~/.reviewgate.
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };

const repo = join(ROOT, "repo");
mkdirSync(repo, { recursive: true });
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "takeback@example.com");
git(repo, "config", "user.name", "takeback");
writeFileSync(join(repo, "README.md"), "steer check\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "init");

const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
const exited = new Promise((resolve) => child.on("exit", resolve));
child.stderr.on("data", () => {});
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
  if (ev.type === "permission_request") send({ type: "permission_response", requestId: ev.requestId, allow: true });
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
});
const request = (cmd) =>
  new Promise((resolve, reject) => {
    const id = `s${next++}`;
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

const observed = { cli: null };
let failed = false;
/** One turn: `sleep secs`, then a steered message asking for `word` in the reply; `takeBack` decides when it is taken back. */
async function turnWith(secs, done, word, takeBack) {
  const from = events.length;
  await request({ type: "send", text: `Run the Bash command \`sleep ${secs}\` (just that, nothing else). Then reply with exactly one line: ${done}` });
  await waitFor(() => events.slice(from).some((e) => e.type === "tool_use" && e.name === "Bash"), "the Bash call");
  await sleep(1500);
  const steer = await request({ type: "steer", text: `Also: put the word ${word} in your final reply.` });
  const out = { steerReply: steer.ok === false ? steer.error : "ok" };
  for (let i = 0; i < 30 && (state?.session.steering ?? []).length === 0; i++) await sleep(100); // the next snapshot
  out.waitingAfterSteer = (state?.session.steering ?? []).map((m) => m.text);
  out.takeBack = await takeBack(out);
  for (let i = 0; i < 20; i++) await sleep(100);
  out.waitingAfterTakeBack = (state?.session.steering ?? []).map((m) => m.text);
  await waitFor(() => events.slice(from).some((e) => e.type === "turn_end"), "turn end");
  await waitFor(() => state?.gate.phase !== "running" && state?.gate.phase !== "collecting", "review collected");
  await sleep(1500);
  const mine = events.slice(from);
  out.userRows = mine.filter((e) => e.type === "user_message").map((u) => ({ turn: u.turn, steered: u.steered ?? false, text: u.text.slice(0, 50) }));
  out.turnEnds = mine.filter((e) => e.type === "turn_end").length;
  out.waitingAtEnd = (state?.session.steering ?? []).length;
  const text = mine.filter((e) => e.type === "text_delta").map((e) => e.text ?? "").join("");
  out.reply = text.trim().slice(-120);
  out.word = text.includes(word) || JSON.stringify(mine.filter((e) => e.type !== "user_message")).includes(word);
  return out;
}
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

  // In time: taken back while the sleep still runs.
  observed.inTime = await turnWith(8, "A-DONE", "BANANA", async (out) => {
    const id = (state?.session.steering ?? [])[0]?.id;
    if (!id) return "nothing waiting";
    const r = await request({ type: "steer_take_back", messageId: id });
    return r.ok === false ? `${r.code}: ${r.error}` : "ok";
  });
  log(JSON.stringify(observed.inTime));

  // Too late: taken back once Claude read it (its steered row came).
  observed.tooLate = await turnWith(5, "B-DONE", "CHERRY", async () => {
    const id = (state?.session.steering ?? [])[0]?.id;
    if (!id) return "nothing waiting";
    await waitFor(() => events.some((e) => e.type === "user_message" && e.steered === true), "Claude reads the message");
    const r = await request({ type: "steer_take_back", messageId: id });
    return r.ok === false ? r.code : "ok";
  });
  log(JSON.stringify(observed.tooLate));

  const a = observed.inTime, b = observed.tooLate;
  failed = a.steerReply !== "ok" || a.waitingAfterSteer.length !== 1 || a.takeBack !== "ok" || a.waitingAfterTakeBack.length !== 0
    || a.userRows.length !== 1 || a.userRows.some((u) => u.steered) || a.turnEnds !== 1 || a.waitingAtEnd !== 0 || a.word
    || b.steerReply !== "ok" || b.takeBack !== "steer_already_read" || b.userRows.length !== 2 || b.userRows[1]?.steered !== true
    || b.userRows[0]?.turn !== b.userRows[1]?.turn || b.turnEnds !== 1 || b.waitingAtEnd !== 0 || !b.word;
} catch (e) {
  failed = true;
  observed.error = e instanceof Error ? e.message : String(e);
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
