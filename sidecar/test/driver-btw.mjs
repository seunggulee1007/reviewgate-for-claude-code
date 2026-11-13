#!/usr/bin/env node
// Real-CLI check for docs/PROTOCOL.md §56.1 (`btw_ask`, /btw): while a `sleep 15` turn runs, a side question is answered by
// the live session (`via: "session"`) from the conversation — the code word the first message gave — before the turn ends;
// a second one gets the first exchange as history. The turn ends once with its own reply, and neither question gets a
// row nor reaches the turn. Through the bundled sidecar on a fresh scratch repository (loadUserSettings off), RG_MODEL
// (default haiku).
//
//   node sidecar/test/driver-btw.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-btw, RE-CREATED)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
// Prints what was observed as JSON; exits 1 when it went otherwise.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-btw");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => process.stderr.write(`[btw +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
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
git(repo, "config", "user.email", "btw@example.com");
git(repo, "config", "user.name", "btw");
writeFileSync(join(repo, "README.md"), "btw check\n");
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

  const from = events.length;
  await request({ type: "send", text: "The code word is PAPAYA. Run the Bash command `sleep 15` (just that, nothing else). Then reply with exactly one line: A-DONE" });
  await waitFor(() => events.slice(from).some((e) => e.type === "tool_use" && e.name === "Bash"), "the Bash call");
  await sleep(1000);
  const asked = Date.now();
  const first = await request({ type: "btw_ask", question: "What is the code word I gave you? Answer with the word only." });
  observed.first = { ok: first.ok !== false, via: first.via, answer: (first.answer ?? first.error ?? "").slice(0, 120), secs: (Date.now() - asked) / 1000 };
  observed.first.turnRunningAtAnswer = state?.gate.phase === "running" && !events.slice(from).some((e) => e.type === "turn_end");
  log(JSON.stringify(observed.first));
  const second = await request({ type: "btw_ask", question: "What did I ask you on the side a moment ago? Answer in five words or fewer." });
  observed.second = { ok: second.ok !== false, via: second.via, answer: (second.answer ?? second.error ?? "").slice(0, 120) };
  log(JSON.stringify(observed.second));

  await waitFor(() => events.slice(from).some((e) => e.type === "turn_end"), "turn end");
  await waitFor(() => state?.gate.phase !== "running" && state?.gate.phase !== "collecting", "review collected");
  await sleep(1500);
  const mine = events.slice(from);
  observed.userRows = mine.filter((e) => e.type === "user_message").map((u) => u.text.slice(0, 60));
  observed.turnEnds = mine.filter((e) => e.type === "turn_end").length;
  observed.reply = mine.filter((e) => e.type === "text_delta").map((e) => e.text ?? "").join("").trim().slice(-120);
  // Neither question reached the turn: no row, no streamed text of the turn carries them.
  observed.questionInTurn = mine.some((e) => (e.type === "user_message" || e.type === "text_delta") && /code word I gave|on the side/.test(e.text ?? ""));

  const a = observed.first, b = observed.second;
  failed = !a.ok || a.via !== "session" || !/papaya/i.test(a.answer) || !a.turnRunningAtAnswer
    || !b.ok || b.via !== "session" || !b.answer
    || observed.userRows.length !== 1 || observed.turnEnds !== 1 || !observed.reply.includes("A-DONE") || observed.questionInTurn;
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
