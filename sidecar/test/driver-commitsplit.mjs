#!/usr/bin/env node
// Real-CLI check for docs/PROTOCOL.md §53 (commits in meaningful units): a turn leaves two unrelated changes — two hunks
// in one file and another file — all accepted; `commit_split_draft` has a read-only fork of the main session propose the
// smallest meaningful commits, and `commit_series` makes them: the log holds the proposed commits in order and the
// worktree is not written. Through the bundled sidecar on a fresh scratch repository (loadUserSettings off). Two model
// calls on RG_MODEL (default haiku).
//
//   node sidecar/test/driver-commitsplit.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-commitsplit, RE-CREATED)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
// Prints what was observed as JSON; exits 1 when fewer than two commits are proposed or the series does not match them.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-commitsplit");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 180_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => process.stderr.write(`[commitsplit +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
// The app-wide records (§36.8 cli-versions.json) go to the scratch folder, never the user's ~/.reviewgate.
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };

// greet() at the top and farewell() at the bottom of app.js: an edit in each is two hunks of one file.
const filler = Array.from({ length: 12 }, (_, i) => `export const step${i + 1} = ${i + 1};`).join("\n");
const repo = join(ROOT, "repo");
mkdirSync(repo, { recursive: true });
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "commitsplit@example.com");
git(repo, "config", "user.name", "commitsplit");
writeFileSync(join(repo, "app.js"), `export function greet(name) {\n  return "Hello, " + name;\n}\n\n${filler}\n\nexport function farewell(name) {\n  return "Bye, " + name;\n}\n`);
writeFileSync(join(repo, "config.json"), '{\n  "name": "acme-shop",\n  "version": "1.0.0"\n}\n');
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "feat: greet and farewell");
git(repo, "commit", "-q", "--allow-empty", "-m", "chore: release 1.0.0");
const base = git(repo, "rev-parse", "HEAD");

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
    const id = `p${next++}`;
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
  // Two unrelated changes: the greeting's wording (two hunks of app.js) and a version bump (config.json).
  await request({ type: "send", text:
    "Make exactly these three edits with the Edit tool, nothing else, then reply DONE:\n" +
    "1. In app.js, function greet: replace \"Hello, \" with \"Hi, \".\n" +
    "2. In app.js, function farewell: replace \"Bye, \" with \"Goodbye, \".\n" +
    "3. In config.json: replace \"1.0.0\" with \"1.0.1\"." });
  await waitFor(() => events.some((e) => e.type === "turn_end"), "turn end");
  await waitFor(() => state?.gate.phase === "reviewing" && state.changedFiles.length >= 2, "review collected");
  await request({ type: "accept_all" });
  await waitFor(() => state?.commit.acceptedPaths.length >= 2, "accepted");
  const hunks = await request({ type: "commit_hunks" });
  observed.hunks = (hunks.files ?? []).map((f) => ({ path: f.path, status: f.status, hunks: f.hunks.map((h) => h.header) }));
  const worktree = Object.fromEntries(["app.js", "config.json"].map((p) => [p, readFileSync(join(repo, p), "utf8")]));

  const draft = await request({ type: "commit_split_draft" });
  observed.draft = draft.type === "commit_split_draft" ? { commits: draft.commits, unassigned: draft.unassigned } : draft;
  const proposed = draft.type === "commit_split_draft" ? draft.commits : [];
  const known = new Map((hunks.files ?? []).map((f) => [f.path, f.hunks.map((h) => h.id)]));
  const validParts = proposed.length > 0 && proposed.every((c) => c.message && c.parts.length > 0
    && c.parts.every((p) => known.has(p.path) && (p.hunks === undefined || p.hunks.every((id) => known.get(p.path).includes(id)))));

  const series = await request({ type: "commit_series", commits: proposed, push: false });
  observed.series = series.type === "committed_series" ? series.commits.map((c) => ({ shortSha: c.shortSha, subject: c.message.split("\n")[0], files: c.files })) : series;
  const subjects = git(repo, "log", "--reverse", "--format=%s", `${base}..HEAD`).split("\n").filter(Boolean);
  observed.log = subjects;
  observed.commitFiles = git(repo, "log", "--reverse", "--format=%h", `${base}..HEAD`).split("\n").filter(Boolean)
    .map((sha) => `${sha}: ${git(repo, "show", "--name-only", "--format=", sha).split("\n").filter(Boolean).join(", ")}`);
  observed.worktreeUnchanged = Object.entries(worktree).every(([p, text]) => readFileSync(join(repo, p), "utf8") === text);
  observed.status = git(repo, "status", "--porcelain");
  log(JSON.stringify(observed));
  failed = proposed.length < 2 || !validParts || series.type !== "committed_series" || subjects.length !== proposed.length
    || !subjects.every((s, i) => s === proposed[i].message.split("\n")[0]) || !observed.worktreeUnchanged;
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
