#!/usr/bin/env node
// Real-CLI check for docs/PROTOCOL.md §50 (Send now): a message sent with `steer` while a turn runs reaches Claude in that
// turn — its reply answers both, the file the second message asked for is in the same review, one turn_end, and the two
// user rows share the turn number (the second marked steered). Composer (§50.2): until the CLI starts the message it
// waits in state.session.steering and has no row; at the end nothing waits. Through the bundled sidecar on a fresh scratch repository
// (loadUserSettings off). One model call on RG_MODEL (default haiku).
//
//   node sidecar/test/driver-steer.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-steer, RE-CREATED)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
// Prints what was observed as JSON; exits 1 when the message did not join the running turn.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-steer");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => process.stderr.write(`[steer +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
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
git(repo, "config", "user.email", "steer@example.com");
git(repo, "config", "user.name", "steer");
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
  await request({ type: "send", text: "Run the Bash command `sleep 10` (just that, nothing else). Then reply with exactly one line: A-DONE" });
  await waitFor(() => events.some((e) => e.type === "tool_use" && e.name === "Bash"), "the Bash call");
  await sleep(1500);
  const steer = await request({ type: "steer", text: "Also: create the file note.txt containing the single word steered, and put the word BANANA in your final reply." });
  observed.steerReply = steer.ok === false ? steer.error : "ok";
  // composer (§50.2): it waits above the input (state.session.steering, no row yet) until the CLI starts it.
  for (let i = 0; i < 30 && (state?.session.steering ?? []).length === 0; i++) await sleep(100); // the next snapshot
  observed.waitingAfterSteer = (state?.session.steering ?? []).map((m) => m.text.slice(0, 20));
  observed.rowsAtSteer = events.filter((e) => e.type === "user_message").length;
  await waitFor(() => events.some((e) => e.type === "turn_end"), "turn end");
  await waitFor(() => state?.gate.phase !== "running" && state?.gate.phase !== "collecting", "review collected");
  await sleep(1500);
  const users = events.filter((e) => e.type === "user_message");
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.text ?? "").join("");
  observed.waitingAtEnd = (state?.session.steering ?? []).length;
  observed.userRows = users.map((u) => ({ turn: u.turn, steered: u.steered ?? false, text: u.text.slice(0, 60) }));
  observed.turnEnds = events.filter((e) => e.type === "turn_end").length;
  observed.files = (state?.changedFiles ?? []).map((f) => f.path);
  observed.banana = /BANANA/.test(text) || JSON.stringify(events).includes("BANANA");
  log(JSON.stringify(observed));
  failed = observed.steerReply !== "ok" || observed.turnEnds !== 1 || users.length !== 2 || users[0].turn !== users[1].turn
    || users[1].steered !== true || !observed.files.includes("note.txt") || !observed.banana
    || observed.waitingAfterSteer.length !== 1 || observed.rowsAtSteer !== 1 || observed.waitingAtEnd !== 0;
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
