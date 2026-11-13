#!/usr/bin/env node
// Real-CLI check for docs/PROTOCOL.md §56.2 (Esc gives back what Claude has not read): while a `sleep 10` runs, two messages
// are put into the turn, then `interrupt {takeBack: true}`. Expected: `interrupted` with both messages (text, order), none
// read, nothing waiting, no row for either, the turn ends interrupted once, and neither runs afterwards as a turn of its
// own (no second turn_end, no reply naming their words). Also reports which way the engine took them back (cancel_queued
// in the interrupt, or one by one). Through the bundled sidecar on a fresh scratch repository (loadUserSettings off),
// RG_MODEL (default haiku).
//
//   node sidecar/test/driver-esc-takeback.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-esc-takeback, RE-CREATED)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
// Prints what was observed as JSON; exits 1 when it went otherwise.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-esc-takeback");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => process.stderr.write(`[esc +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
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
git(repo, "config", "user.email", "esc@example.com");
git(repo, "config", "user.name", "esc");
writeFileSync(join(repo, "README.md"), "esc check\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "init");

const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
const exited = new Promise((resolve) => child.on("exit", resolve));
const engineLog = [];
createInterface({ input: child.stderr }).on("line", (line) => {
  if (/interrupt:/.test(line)) engineLog.push(line.replace(/^\[sidecar:\w+\] /, ""));
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
  await request({ type: "send", text: "Run the Bash command `sleep 10` (just that, nothing else). Then reply with exactly one line: A-DONE" });
  await waitFor(() => events.slice(from).some((e) => e.type === "tool_use" && e.name === "Bash"), "the Bash call");
  await sleep(1000);
  const s1 = await request({ type: "steer", text: "Also: put the word BANANA in your final reply." });
  const s2 = await request({ type: "steer", text: "And put the word CHERRY in it too." });
  observed.steers = [s1.ok === false ? s1.error : "ok", s2.ok === false ? s2.error : "ok"];
  for (let i = 0; i < 30 && (state?.session.steering ?? []).length < 2; i++) await sleep(100);
  observed.waitingBeforeEsc = (state?.session.steering ?? []).map((m) => m.text);
  const r = await request({ type: "interrupt", takeBack: true });
  observed.reply = r.type === "interrupted" ? { takenBack: r.takenBack.map((m) => m.text), read: r.read.length } : r;
  await sleep(1500);
  observed.waitingAfterEsc = (state?.session.steering ?? []).length;
  await waitFor(() => events.slice(from).some((e) => e.type === "turn_end"), "turn end");
  await waitFor(() => state?.gate.phase !== "running" && state?.gate.phase !== "collecting", "review collected");
  // Neither message runs afterwards as a turn of its own.
  await sleep(8000);
  const mine = events.slice(from);
  observed.turnEnds = mine.filter((e) => e.type === "turn_end").map((e) => e.stopReason);
  observed.userRows = mine.filter((e) => e.type === "user_message").map((u) => ({ steered: u.steered ?? false, text: u.text.slice(0, 40) }));
  const text = mine.filter((e) => e.type === "text_delta").map((e) => e.text ?? "").join("");
  observed.words = /BANANA|CHERRY/.test(text);
  observed.path = engineLog.filter((l) => /cancel_queued/.test(l));
  log(JSON.stringify(observed));

  failed = observed.steers.some((x) => x !== "ok") || observed.waitingBeforeEsc.length !== 2
    || JSON.stringify(observed.reply?.takenBack) !== JSON.stringify(observed.waitingBeforeEsc) || observed.reply?.read !== 0
    || observed.waitingAfterEsc !== 0 || observed.turnEnds.length !== 1 || observed.turnEnds[0] !== "interrupted"
    || observed.userRows.length !== 1 || observed.userRows[0].steered || observed.words;
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
