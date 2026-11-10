#!/usr/bin/env node
// Engine-level E2E for docs/PROTOCOL.md §43.3 (wave 5, w5-graph) against the real `claude` CLI and graphify.
//
//   node sidecar/test/driver-board.mjs <scratch dir> [sidecar.mjs] [mod folder to copy]
//   RG_MODEL=haiku (default) — two one-line prompts in all.
//
// The scratch dir (created / reset) holds repo/ (a git repo with three Java files, graphify-out/ ignored), mods/ (a COPY of
// the mod folder given — the user's own folder is only read) and data/ (REVIEWGATE_DATA_DIR).
// sidecar #1 (CLAUDE_CODE_PLUGIN_DIRS=<scratch>/mods, as a user who registered the mod would have it):
//   a. the session reports the mod among its plugins; extensions.mods marks it loaded; its hooks module ran (the slash
//      command it registers is listed) — or the driver says it did not;
//   b. a one-line turn completes; the time from open_project to the session's initialize and the turn's time are printed;
//   c. code_graph before a build (no report), code_graph_build with the real graphify (when installed) → the finished build
//      and its report (nodes > 0, behind 0).
// sidecar #2 (no CLAUDE_CODE_PLUGIN_DIRS): the same turn, for the timing baseline; the mod is not loaded.
// Finally the scratch conversations under ~/.claude/projects are removed. Prints only the scratch repo's data.
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH_ARG = process.argv[2];
if (!SCRATCH_ARG) {
  console.error("usage: node sidecar/test/driver-board.mjs <scratch dir> [sidecar.mjs] [mod folder]");
  process.exit(2);
}
mkdirSync(SCRATCH_ARG, { recursive: true });
const SCRATCH = realpathSync(SCRATCH_ARG);
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const MOD_SRC = process.argv[4] ?? null;
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 180_000;
const REPO = join(SCRATCH, "repo");
const MODS = join(SCRATCH, "mods");
const DATA = join(SCRATCH, "data");

const t0 = Date.now();
const log = (msg) => process.stderr.write(`[board +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const results = {};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

// ---------------------------------------------------------------- scratch prep
rmSync(REPO, { recursive: true, force: true });
rmSync(MODS, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });
mkdirSync(join(REPO, "src", "demo"), { recursive: true });
mkdirSync(DATA, { recursive: true });
git(REPO, "init", "-q", "-b", "main");
git(REPO, "config", "user.email", "driver@example.com");
git(REPO, "config", "user.name", "driver");
writeFileSync(join(REPO, ".gitignore"), "graphify-out/\n.omc/\n");
writeFileSync(join(REPO, "src", "demo", "Alpha.java"), "package demo;\npublic class Alpha {\n  private final Beta beta = new Beta();\n  public int run(int x) { return beta.twice(x) + Gamma.one(); }\n}\n");
writeFileSync(join(REPO, "src", "demo", "Beta.java"), "package demo;\npublic class Beta {\n  public int twice(int x) { return x * 2 + Gamma.one(); }\n}\n");
writeFileSync(join(REPO, "src", "demo", "Gamma.java"), "package demo;\npublic class Gamma {\n  public static int one() { return 1; }\n}\n");
git(REPO, "add", "-A");
git(REPO, "commit", "-q", "-m", "driver-board: scratch");
if (MOD_SRC) {
  mkdirSync(MODS, { recursive: true });
  const name = MOD_SRC.split("/").filter(Boolean).at(-1);
  cpSync(MOD_SRC, join(MODS, name), { recursive: true, dereference: false });
  log(`copied the mod ${name} into ${MODS}`);
}

// ---------------------------------------------------------------- sidecar plumbing
let state = null;
let nextId = 1;
let waiters = [];
const replies = new Map();
let events = [];
let child = null;
let exited = null;
let stderrLines = [];

function startSidecar(extraEnv) {
  const env = { ...process.env, REVIEWGATE_DATA_DIR: DATA, ...extraEnv };
  if (extraEnv.CLAUDE_CODE_PLUGIN_DIRS === undefined) delete env.CLAUDE_CODE_PLUGIN_DIRS;
  child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env });
  stderrLines = [];
  createInterface({ input: child.stderr }).on("line", (l) => {
    stderrLines.push(l);
    if (/board|plugin|mod\b|error/i.test(l) && !/:debug\]/.test(l)) process.stderr.write(`  [sidecar] ${l.slice(0, 300)}\n`);
  });
  exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  state = null;
  waiters = [];
  events = [];
  createInterface({ input: child.stdout }).on("line", onLine);
}

function onLine(line) {
  const ev = JSON.parse(line);
  if (ev.type === "state") state = ev.state;
  else {
    events.push(ev);
    if (ev.type === "permission_request") send({ type: "permission_response", requestId: ev.requestId, allow: false });
    else if (ev.type === "error") log(`error(${ev.scope}${ev.code ? `, ${ev.code}` : ""}): ${String(ev.message).slice(0, 200)}`);
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) if (state && w.pred(state)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(state);
  }
}

const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");

function request(cmd) {
  const id = `b${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type} within ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      if (ev.type === "result" && !ev.ok) reject(Object.assign(new Error(`${cmd.type} failed: ${ev.error}`), { code: ev.code }));
      else resolve(ev);
    });
    send({ ...cmd, id });
  });
}

function waitState(pred, what, timeoutMs = STEP_TIMEOUT_MS) {
  if (state && pred(state)) return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
    waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
  });
}

function waitEvent(pred, what, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + timeoutMs;
    const tick = () => {
      const ev = events.find(pred);
      if (ev) return resolve(ev);
      if (Date.now() > end) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

const settings = {
  budget: { maxFiles: 5, maxLines: 200 },
  ignorePatterns: [".omc/"],
  autoAllowTools: [],
  loadUserSettings: true,
  systemPromptAppend: "You are running inside ReviewGate's test driver. Answer in one short line. Never use tools.",
  claudePath: CLAUDE,
  model: MODEL,
  ghHost: "github.com",
};

async function session(tag, extraEnv) {
  startSidecar(extraEnv);
  const r = {};
  await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  const opened = Date.now();
  await request({ type: "open_project", path: REPO });
  const s = await waitState((x) => x.session.open && x.session.extensions?.memoryFiles !== null && x.session.capabilities?.state !== "starting", `${tag}: session ready`);
  r.initMs = Date.now() - opened;
  const ext = s.session.extensions;
  r.plugins = (ext?.plugins ?? []).map((p) => `${p.name}${p.id ? "" : " (folder)"}`);
  r.modsLoaded = (ext?.mods ?? []).filter((m) => m.loaded).map((m) => m.name);
  r.modsListed = (ext?.mods ?? []).map((m) => `${m.name}:${m.source}`).slice(0, 10);
  r.boardCommand = (s.session.capabilities?.slashCommands ?? []).some((c) => (typeof c === "string" ? c : c.name) === "board");
  const turnStart = Date.now();
  const before = s.hud.turnCount;
  await request({ type: "send", text: "Reply with the single word: pong" });
  await waitState((x) => x.hud.turnCount > before && x.gate.phase !== "running" && x.gate.phase !== "collecting", `${tag}: turn`);
  r.turnMs = Date.now() - turnStart;
  r.answer = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("").trim().slice(0, 60);
  // A second turn: the mod's per-turn hooks on a warm session (timing sample).
  const second = Date.now();
  const before2 = state.hud.turnCount;
  await request({ type: "send", text: "Reply with the single word: ping" });
  await waitState((x) => x.hud.turnCount > before2 && x.gate.phase !== "running" && x.gate.phase !== "collecting", `${tag}: second turn`);
  r.secondTurnMs = Date.now() - second;
  // What the session reported once the turns ran (plugins can arrive after the first snapshot).
  const after = state.session.extensions;
  r.allPluginsAfterTurn = (after?.plugins ?? []).map((p) => p.name);
  r.pluginsAfterTurn = (after?.plugins ?? []).filter((p) => !p.id).map((p) => `${p.name} @ ${p.path}`);
  r.modsLoadedAfterTurn = (after?.mods ?? []).filter((m) => m.loaded).map((m) => `${m.name} @ ${m.path}`);
  r.boardCommandAfterTurn = (state.session.capabilities?.slashCommands ?? []).some((c) => (typeof c === "string" ? c : c.name) === "board");
  r.errors = events.filter((e) => e.type === "error").map((e) => `${e.code ?? ""} ${String(e.message).slice(0, 120)}`);
  r.modStderr = stderrLines.filter((l) => /board|hooks module|register\.tsx/i.test(l)).slice(0, 5).map((l) => l.slice(0, 200));
  return r;
}

async function stopSidecar() {
  await request({ type: "shutdown" }).catch(() => undefined);
  await exited;
}

const projectKey = (cwd) => realpathSync(cwd).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
const projectsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");

try {
  // ---- sidecar #1: the mod registered in CLAUDE_CODE_PLUGIN_DIRS
  if (MOD_SRC) {
    log("sidecar #1: CLAUDE_CODE_PLUGIN_DIRS=<scratch>/mods");
    results.withMod = await session("with mod", { CLAUDE_CODE_PLUGIN_DIRS: MODS });
    log(`with mod: ${JSON.stringify(results.withMod)}`);
    // ---- the code graph through the same engine
    const before = await request({ type: "code_graph" });
    results.graphBefore = { reportPath: before.reportPath, graphify: before.graphify, outIgnored: before.outIgnored, head: before.head };
    if (before.graphify) {
      const started = Date.now();
      const b = await request({ type: "code_graph_build" });
      results.buildStarted = b.build?.running === true;
      const done = await waitEvent((e) => e.type === "code_graph" && !e.id && e.build && !e.build.running, "the build's end", 600_000);
      results.build = { ok: done.build.ok, line: done.build.line, ms: Date.now() - started, nodes: done.report?.nodes, edges: done.report?.edges, behind: done.behind, commit: done.report?.commit, html: done.htmlPath !== null };
      try {
        await request({ type: "code_graph_build" });
        results.secondBuild = "started";
      } catch (e) {
        results.secondBuild = e.code;
      }
      await waitEvent((e) => e.type === "code_graph" && !e.id && e.build && !e.build.running && e !== done, "second build end", 600_000).catch(() => undefined);
    }
    log(`graph: ${JSON.stringify({ before: results.graphBefore, build: results.build, second: results.secondBuild })}`);
    await stopSidecar();
  }
  // ---- sidecar #2: baseline, no mod
  log("sidecar #2: no CLAUDE_CODE_PLUGIN_DIRS");
  results.baseline = await session("baseline", { CLAUDE_CODE_PLUGIN_DIRS: undefined });
  log(`baseline: ${JSON.stringify(results.baseline)}`);
  await stopSidecar();
} catch (e) {
  log(`FAILED: ${e.message}`);
  process.exitCode = 1;
  if (child && child.exitCode === null) child.kill("SIGKILL");
} finally {
  const key = projectKey(REPO);
  for (const name of existsSync(projectsDir) ? readdirSync(projectsDir) : []) {
    if (name === key || name.startsWith(`${key}-`)) rmSync(join(projectsDir, name), { recursive: true, force: true });
  }
  console.log(JSON.stringify(results, null, 2));
}
