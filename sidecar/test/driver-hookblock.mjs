#!/usr/bin/env node
// Real-CLI check for docs/PROTOCOL.md §41.2 (the 0.2.7 regression): a UserPromptSubmit hook that blocks the prompt is ONE
// chat row — with a JSON {"decision":"block"} and with exit 2 — through the bundled sidecar on fresh scratch repositories
// whose own `.claude/settings.json` holds the hook (loadUserSettings off: the project's settings only). No model call is
// made (the hook blocks the prompt before it).
//
//   node sidecar/test/driver-hookblock.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-hookblock, RE-CREATED)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
// Prints what was observed as JSON; exits 1 when a run did not end with exactly one hook_blocked row.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-hookblock");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 90_000;
const HOOKS = {
  json: `printf '%s' '{"decision":"block","reason":"commit first"}'`,
  exit2: "echo 'commit first' >&2; exit 2",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => process.stderr.write(`[hookblock +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
// The app-wide records (§36.8 cli-versions.json) go to the scratch folder, never the user's ~/.reviewgate.
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };

function repoWith(kind) {
  const repo = join(ROOT, kind);
  mkdirSync(join(repo, ".claude"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "hookblock@example.com");
  git(repo, "config", "user.name", "hookblock");
  writeFileSync(join(repo, "README.md"), "hook block\n");
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: HOOKS[kind] }] }] } }, null, 2) + "\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

async function run(kind) {
  const repo = repoWith(kind);
  const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  child.stderr.on("data", () => {});
  let state = null;
  const events = [];
  const replies = new Map();
  let next = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "state") state = ev.state;
    else events.push(ev);
    if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  });
  const request = (cmd) =>
    new Promise((resolve, reject) => {
      const id = `${kind}${next++}`;
      const timer = setTimeout(() => reject(new Error(`${kind}: no reply for ${cmd.type}`)), STEP_TIMEOUT_MS);
      replies.set(id, (ev) => {
        clearTimeout(timer);
        replies.delete(id);
        resolve(ev);
      });
      child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
    });
  const waitFor = async (pred, what) => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`${kind}: timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const settings = {
    budget: { maxFiles: 5, maxLines: 200 },
    ignorePatterns: [], autoAllowTools: [], loadUserSettings: false,
    systemPromptAppend: "You are running inside a ReviewGate test. Reply with just OK.",
    claudePath: CLAUDE, model: MODEL, ghHost: "github.com",
  };
  try {
    await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
    await request({ type: "open_project", path: repo });
    await waitFor(() => state?.session.open && !state.session.starting, "session open");
    await request({ type: "send", text: "hello" });
    await waitFor(() => events.some((e) => e.type === "turn_end") || events.some((e) => e.type === "error" && e.fatal), "turn end");
    await sleep(1500); // a late informational / hook_response would come right after
  } finally {
    child.stdin.write(JSON.stringify({ type: "shutdown", id: "bye" }) + "\n");
    await Promise.race([exited, sleep(10_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  const rows = events.filter((e) => e.type === "error" && e.code === "hook_blocked").map((e) => ({ hookName: e.hookName ?? null, exitCode: e.exitCode ?? null, detail: e.detail ?? null }));
  const others = events.filter((e) => e.type === "error" && e.code !== "hook_blocked").map((e) => `${e.code ?? ""}: ${String(e.message).slice(0, 120)}`);
  log(`${kind}: ${rows.length} hook_blocked row(s) ${JSON.stringify(rows)}`);
  return { kind, rows, others, turnEnded: events.some((e) => e.type === "turn_end") };
}

const observed = { cli: null, runs: [] };
let failed = false;
try {
  observed.cli = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
  for (const kind of Object.keys(HOOKS)) {
    const r = await run(kind);
    observed.runs.push(r);
    if (r.rows.length !== 1) failed = true;
  }
} catch (e) {
  failed = true;
  observed.error = e instanceof Error ? e.message : String(e);
} finally {
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
