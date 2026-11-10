#!/usr/bin/env node
// Real-CLI contract driver for docs/PROTOCOL.md §33.5 (r2 M20), §31.1 (r2 M35) and §21 (r2 M18) — a project slash command
// with `allowed-tools`, in the DEFAULT permission mode, through the bundled sidecar on a fresh scratch repo. Model: haiku
// (RG_MODEL), two turns, a few cents per run.
//
//   node sidecar/test/driver-skills.mjs [scratchDir] [sidecar.mjs]   (scratchDir is RE-CREATED; never under /tmp: drivers
//   that make worktrees must not use it — default ~/rg-driver-scratch/r2-skills-side (or $RG_DRIVER_SCRATCH/r2-skills-side))   CLAUDE_PATH=…
//
//   S. `/acme-stamp` — the command's `allowed-tools: Bash(./stamp.sh:*)` holds for its turn: `./stamp.sh` runs without a
//      card (§33.5); the file its `!`./note.sh`` line wrote while the CLI expanded it is the skill's (origin skill, §31.1),
//      the file stamp.sh wrote is Bash's.
//   C. the control: the same `./stamp.sh` asked for in a plain message is a card (default mode) — denied.
//   Q. `side_ask "/acme-stamp"` is refused side_command:acme-stamp (§21: a skill runs in the main conversation).
// Cleans up ~/.claude/projects/<scratch key> afterwards, checks no CLI child is left, prints what was observed as JSON.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(process.env.RG_DRIVER_SCRATCH ?? join(homedir(), "rg-driver-scratch"), "r2-skills-side");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 240_000;

const t0 = Date.now();
const log = (msg) => process.stderr.write(`[skills +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const observed = { cli: null, model: MODEL };
const failures = [];
const check = (cond, msg) => {
  if (!cond) {
    failures.push(msg);
    log(`CHECK FAILED: ${msg}`);
  } else log(`ok: ${msg}`);
};
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");

// ---------------------------------------------------------------- scratch repo
if (/^\/(private\/)?(tmp|var)\//.test(SCRATCH)) throw new Error(`scratch must not be a temporary folder: ${SCRATCH}`);
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: join(ROOT, "rg-data") };
const REPO = join(ROOT, "acme-shop");
mkdirSync(join(REPO, ".claude", "commands"), { recursive: true });
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "skills@example.com");
git("config", "user.name", "skills");
writeFileSync(join(REPO, "README.md"), "# acme-shop\n");
writeFileSync(join(REPO, ".gitignore"), "rg-data/\n");
writeFileSync(join(REPO, "stamp.sh"), "#!/bin/sh\necho stamped > build-stamp.txt\n");
writeFileSync(join(REPO, "note.sh"), "#!/bin/sh\necho noted > note.txt\necho note written\n");
chmodSync(join(REPO, "stamp.sh"), 0o755);
chmodSync(join(REPO, "note.sh"), 0o755);
writeFileSync(
  join(REPO, ".claude", "commands", "acme-stamp.md"),
  [
    "---",
    "description: Stamp the build (acme)",
    "allowed-tools: Bash(./stamp.sh:*), Bash(./note.sh:*)",
    "---",
    "Note: !`./note.sh`",
    "",
    "Run exactly the Bash command `./stamp.sh` (one call, nothing else), then reply with the single word: stamped.",
    "",
  ].join("\n"),
);
git("add", "-A");
git("commit", "-q", "-m", "init");

// ---------------------------------------------------------------- sidecar plumbing
let state = null;
let nextId = 1;
const waiters = [];
const replies = new Map();
const events = [];
const cards = [];

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
      log(`permission_request ${ev.toolName} ${JSON.stringify(ev.input).slice(0, 100)}${ev.allowPatterns ? ` allowPatterns=${JSON.stringify(ev.allowPatterns)}` : ""} → deny`);
      cards.push(ev);
      send({ type: "permission_response", requestId: ev.requestId, allow: false, message: "Denied in this test. Stop here." });
    } else if (ev.type === "tool_use") log(`tool_use ${ev.name} ${JSON.stringify(ev.input).slice(0, 100)}`);
    else if (ev.type === "error") log(`error(${ev.scope}${ev.code ? ` ${ev.code}` : ""}): ${ev.message.slice(0, 200)}`);
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) if (state && w.pred(state)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(state);
  }
});

function send(cmd) {
  child.stdin.write(JSON.stringify(cmd) + "\n");
}
function request(cmd) {
  const id = `s${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type} (${id})`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      if (ev.type === "result" && !ev.ok) reject(Object.assign(new Error(`${cmd.type} failed: ${ev.error}`), { code: ev.code, error: ev.error }));
      else resolve(ev);
    });
    send({ ...cmd, id });
  });
}
function waitState(pred, what, ms = STEP_TIMEOUT_MS) {
  if (state && pred(state)) return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; phase=${state?.gate.phase}`)), ms);
    waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const turnDone = (before) => (x) => x.hud.turnCount > before && x.gate.phase !== "running" && x.gate.phase !== "collecting";
const claudeChildren = () => {
  try {
    return execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const settings = {
  budget: { maxFiles: 10, maxLines: 400 },
  ignorePatterns: [],
  autoAllowTools: [],
  loadUserSettings: false,
  permissionMode: "default",
  systemPromptAppend: "You are running inside ReviewGate. Do exactly what is asked and stop. Answer in English.",
  claudePath: CLAUDE,
  ghHost: "github.com",
  model: MODEL,
};

try {
  observed.cli = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
  await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  await request({ type: "open_project", path: REPO });
  await waitState((s) => s.session.open && !s.session.starting, "session open");
  await waitState((s) => (s.session.capabilities?.slashCommands ?? []).includes("acme-stamp") || (s.session.capabilities?.commands ?? []).some((c) => c.name === "acme-stamp"), "the project command listed", 60_000).catch(() => log("acme-stamp not listed yet"));
  check(state.session.permissionMode === "default", "the session runs in the default mode");

  // ---------------------------------------------------------------- S
  log("=== S: /acme-stamp — its allowed-tools hold for the turn");
  let before = state.hud.turnCount;
  await request({ type: "send", text: "/acme-stamp" });
  await waitState(turnDone(before), "the command's turn");
  observed.S = {
    cards: cards.map((c) => ({ toolName: c.toolName, command: c.input.command })),
    files: state.changedFiles.map((f) => ({ path: f.path, origin: f.origin, tools: f.tools, toolUseIds: f.toolUseIds })),
  };
  check(!cards.some((c) => c.toolName === "Bash" && /stamp\.sh/.test(String(c.input.command))), "S: ./stamp.sh ran without a card (allowed-tools, default mode)");
  check(existsSync(join(REPO, "build-stamp.txt")), "S: stamp.sh ran (build-stamp.txt)");
  const stamp = state.changedFiles.find((f) => f.path === "build-stamp.txt");
  check(stamp?.origin === "bash", `S: build-stamp.txt is Bash's (origin ${stamp?.origin})`);
  const note = state.changedFiles.find((f) => f.path === "note.txt");
  if (existsSync(join(REPO, "note.txt"))) check(note?.origin === "skill" && note.toolUseIds.includes("skill:acme-stamp"), `S: note.txt (the !\`./note.sh\` line) is the skill's (origin ${note?.origin}, causes ${JSON.stringify(note?.toolUseIds)})`);
  else log("S: the CLI did not run the !`./note.sh` line (nothing to attribute)");
  if (state.gate.pendingCount > 0) await request({ type: "accept_all" });

  // ---------------------------------------------------------------- C
  log("=== C: the same command in a plain message asks");
  const mark = cards.length;
  before = state.hud.turnCount;
  rmSync(join(REPO, "build-stamp.txt"), { force: true });
  await request({ type: "send", text: "Run exactly the Bash command `./stamp.sh` (one call). If it is denied, stop and reply 'denied'." });
  await waitState(turnDone(before), "the plain turn");
  observed.C = { cards: cards.slice(mark).map((c) => ({ toolName: c.toolName, command: c.input.command, allowPatterns: c.allowPatterns ?? null })) };
  check(cards.slice(mark).some((c) => c.toolName === "Bash" && /stamp\.sh/.test(String(c.input.command))), "C: without the command, ./stamp.sh is a card in the default mode");

  // ---------------------------------------------------------------- Q
  log("=== Q: a slash command asked in a side question");
  const refusal = await request({ type: "side_ask", question: "/acme-stamp" }).then(() => null, (e) => e);
  observed.Q = { code: refusal?.code ?? null, error: refusal?.error ?? null };
  check(refusal?.code === "side_command" && /acme-stamp/.test(refusal.error ?? ""), `Q: side_ask "/acme-stamp" is refused side_command (got ${refusal?.code})`);
} catch (e) {
  failures.push(`driver: ${e instanceof Error ? e.message : String(e)}`);
  log(`ERROR ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  try {
    await request({ type: "shutdown" });
  } catch {}
  const { code, signal } = await Promise.race([exited, sleep(10_000).then(() => ({ code: "timeout", signal: null }))]);
  observed.sidecarExit = { code, signal };
  if (code === "timeout") child.kill("SIGKILL");
  const left = claudeChildren();
  observed.leftoverChildren = left.length;
  if (left.length > 0) failures.push(`leftover CLI children: ${left.join(", ")}`);
  // The CLI's project folder of the scratch repo is scratch too; so is the scratch folder.
  const key = projectKey(REPO);
  if (key.includes("rg-driver-scratch")) rmSync(join(homedir(), ".claude", "projects", key), { recursive: true, force: true });
  if (!process.env.RG_KEEP) rmSync(ROOT, { recursive: true, force: true });
  observed.failures = failures;
  process.stdout.write(JSON.stringify(observed, null, 1) + "\n");
  log(failures.length > 0 ? "FAILED" : "OK");
  process.exitCode = failures.length > 0 ? 1 : 0;
}
