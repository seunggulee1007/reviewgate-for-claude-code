#!/usr/bin/env node
// Engine-level E2E for docs/PROTOCOL.md §36.5–36.9 (wave 3, engine-session) against the real `claude` CLI.
//
//   node sidecar/test/driver-session.mjs <scratch dir> [sidecar.mjs]
//   RG_MODEL=haiku (default) — two Haiku-sized prompts in all.
//
// The scratch dir (created / reset) holds repo/ (a git repo on main), stall/ (a git repo whose local SessionStart hook never
// returns), data/ (REVIEWGATE_DATA_DIR: the app-wide records, so the user's ~/.reviewgate is never touched) and markers/.
// sidecar #1 (defaults: user + local settings):
//   a. §36.5 before any message: capabilities.commands with description / argument hint / source (a project command and
//      a built-in one), capabilities.state starting → ready; what extensionsWaitingOn named while the user's hooks ran.
//   b. §36.6 settingSources has "local"; the local SessionStart hook ran with the local env (marker file); notApplied null.
//   c. §36.8 session.cli = `claude --version`, verified; the seeded record (2.1.308) → one cli_version_changed notice and
//      previous 2.1.308; cli_versions (count, current).
//   d. §36.9 cli_sessions (counts only); a print-mode conversation made here (relabelled as a terminal one: `-p` is
//      programmatic, which /resume and the app leave out) is resumable, imported as a new chat, and resumed (PELICAN).
// sidecar #2 (loadLocalSettings: false): no "local"; notApplied names the hook and the env key; the hook did not run.
// sidecar #3 (stall/, extensionsInitTimeoutMs 20 000 as Electron sends): extensionsWaitingOn names the silent hook; the
//   fallback comes only after the ≥ 45 s stall limit (not at 20 s), says what it waited for, and runs project-only.
// Finally: the scratch conversations under ~/.claude/projects are removed; no registered claude process of the scratch
// dir is left alive. Prints only counts / booleans about the user's other sessions — never their content.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH_ARG = process.argv[2];
if (!SCRATCH_ARG) {
  console.error("usage: node sidecar/test/driver-session.mjs <scratch dir> [sidecar.mjs]");
  process.exit(2);
}
mkdirSync(SCRATCH_ARG, { recursive: true });
const SCRATCH = realpathSync(SCRATCH_ARG);
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 150_000;
const REPO = join(SCRATCH, "repo");
const STALL = join(SCRATCH, "stall");
const DATA = join(SCRATCH, "data");
const MARKERS = join(SCRATCH, "markers");
const STALL_TOKEN = "rg-driver-session-stall";

const t0 = Date.now();
const log = (msg) => process.stderr.write(`[session +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const assert = (cond, msg) => {
  if (!cond) {
    log(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

// ---------------------------------------------------------------- scratch prep
function makeRepo(dir, local) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "driver@example.com");
  git(dir, "config", "user.name", "driver");
  writeFileSync(join(dir, "README.md"), "# driver-session scratch\n");
  writeFileSync(join(dir, ".gitignore"), ".claude/settings.local.json\n.omc/\n");
  writeFileSync(join(dir, ".claude", "commands", "rg-driver-cmd.md"), "---\ndescription: A project command of the driver\nargument-hint: <ticket>\n---\nSay the ticket $ARGUMENTS back.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "driver-session: scratch");
  writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify(local, null, 2));
}

rmSync(DATA, { recursive: true, force: true });
rmSync(MARKERS, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(MARKERS, { recursive: true });
const MARKER = join(MARKERS, "local-hook.marker");
makeRepo(REPO, {
  env: { RG_DRIVER_LOCAL: "driver-local-ok" },
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: `printf '%s' "$RG_DRIVER_LOCAL" > '${MARKER}'` }] }] },
});
makeRepo(STALL, {
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: `perl -e 'sleep 90' ${STALL_TOKEN}`, timeout: 120 }] }] },
});
// §36.8: the app-wide record says the last CLI seen was 2.1.308 (installed by the native installer on the dev machines).
writeFileSync(join(DATA, "cli-versions.json"), JSON.stringify({ version: 1, last: "2.1.308", previous: null, updatedAt: "2026-10-22T00:00:00.000Z" }));
const cliVersion = /^(\d+\.\d+\.\d+)/.exec(execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim())?.[1];
assert(cliVersion, "claude --version reads x.y.z");

// ---------------------------------------------------------------- sidecar plumbing
let state = null;
let nextId = 1;
let waiters = [];
const replies = new Map();
const events = [];
const states = [];
let child = null;
let exited = null;
let sidecarNo = 0;

function startSidecar() {
  sidecarNo += 1;
  const tag = `sidecar#${sidecarNo}`;
  child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, REVIEWGATE_DATA_DIR: DATA } });
  createInterface({ input: child.stderr }).on("line", (l) => {
    if (!/:debug\]/.test(l)) process.stderr.write(`  [${tag}] ${l}\n`);
  });
  exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  state = null;
  waiters = [];
  createInterface({ input: child.stdout }).on("line", onLine);
}

function onLine(line) {
  const ev = JSON.parse(line);
  if (ev.type === "state") {
    state = ev.state;
    states.push(ev.state);
  } else {
    events.push(ev);
    if (ev.type === "permission_request") {
      log(`permission_request ${ev.toolName} → deny (the driver's prompts need no tools)`);
      send({ type: "permission_response", requestId: ev.requestId, allow: false });
    } else if (ev.type === "error") {
      log(`error(${ev.scope}${ev.fatal ? ", fatal" : ""}${ev.code ? `, ${ev.code}` : ""}): ${ev.message}`);
    } else if (!["log", "activity", "text_delta", "tool_result", "tool_use", "tool_files", "state"].includes(ev.type)) {
      log(`event ${ev.type}${ev.id ? ` id=${ev.id}` : ""}${ev.type === "result" && !ev.ok ? ` error=${ev.error}` : ""}`);
    }
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
  for (const w of [...waiters]) if (state && w.pred(state)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(state);
  }
}

function send(cmd) {
  child.stdin.write(JSON.stringify(cmd) + "\n");
}

function request(cmd) {
  const id = `s${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type} (${id}) within ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      if (ev.type === "result" && !ev.ok) reject(new Error(`${cmd.type} failed: ${ev.error} (${ev.code})`));
      else resolve(ev);
    });
    send({ ...cmd, id });
  });
}

function waitState(pred, what, timeoutMs = STEP_TIMEOUT_MS) {
  if (state && pred(state)) return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; phase=${state?.gate.phase} ready=${state?.session.ready} lastError=${state?.lastError}`)), timeoutMs);
    waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
  });
}

const since = (mark, type) => events.slice(mark).filter((e) => e.type === type);

async function turn(text) {
  const before = state.hud.turnCount;
  const mark = events.length;
  await request({ type: "send", text });
  await waitState((x) => x.hud.turnCount > before && x.gate.phase !== "running" && x.gate.phase !== "collecting", `turn "${text.slice(0, 40)}"`);
  await new Promise((r) => setTimeout(r, 300));
  return since(mark, "text_delta").map((e) => e.text).join("");
}

async function stopSidecar() {
  await request({ type: "shutdown" });
  const { code, signal } = await exited;
  assert(code === 0 && signal === null, `sidecar exit ${code} ${signal}`);
}

const baseSettings = {
  budget: { maxFiles: 5, maxLines: 200 },
  ignorePatterns: [".omc/"],
  autoAllowTools: [],
  loadUserSettings: true,
  systemPromptAppend: "You are running inside ReviewGate's test driver. Answer in one short line. Never use tools.",
  claudePath: CLAUDE,
  model: MODEL,
  ghHost: "github.com",
};

async function hello(settings, project) {
  const ready = await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  assert(ready.type === "ready", "hello → ready");
  await request({ type: "open_project", path: project });
}

/** The CLI's folder under ~/.claude/projects for a cwd (cliRecords.ts: every non-alphanumeric char → "-"; short paths only). */
const projectKey = (cwd) => realpathSync(cwd).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
const projectsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");

const observed = {};

// ---------------------------------------------------------------- scenario
async function main() {
  // ============ sidecar #1: defaults (user + local settings)
  startSidecar();
  const mark1 = events.length;
  await hello(baseSettings, REPO);
  {
    // a. §36.5 — no message has been sent: the commands come from initialize.
    const s = await waitState((x) => x.session.capabilities?.state === "ready" && (x.session.capabilities.commands?.length ?? 0) > 0, "capabilities.commands before any message");
    assert(s.hud.turnCount === 0 && since(mark1, "text_delta").length === 0, "no turn ran before the commands arrived");
    const cmds = s.session.capabilities.commands;
    const mine = cmds.find((c) => c.name === "rg-driver-cmd");
    assert(mine && mine.source === "project" && mine.description === "A project command of the driver" && mine.argumentHint === "<ticket>", `the project command with description / hint / source: ${JSON.stringify(mine)}`);
    const mcp = cmds.find((c) => c.name === "mcp");
    assert(mcp && mcp.source === "builtin" && mcp.description.length > 0 && mcp.argumentHint.length > 0, `a built-in command with description / hint: ${JSON.stringify(mcp)}`);
    assert(states.some((x) => x.session.capabilities?.state === "starting"), "capabilities.state was 'starting' while the session started");
    assert(cmds.every((c) => c.description.length <= 200 && !c.description.includes("\n")), "descriptions are one line ≤ 200 chars");
    const bySource = {};
    for (const c of cmds) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
    const waited = [...new Set(states.map((x) => x.session.extensionsWaitingOn).filter(Boolean).map((w) => `${w.kind}:${w.name ?? ""}`))];
    observed.commands = { count: cmds.length, bySource, project: mine, builtin: { name: mcp.name, argumentHint: mcp.argumentHint }, waitingOnSeen: waited };
    log(`a commands OK: ${cmds.length} (${JSON.stringify(bySource)}), waited on ${JSON.stringify(waited)}`);

    // b. §36.6 — local settings applied.
    assert(JSON.stringify(s.session.extensions.settingSources) === '["user","project","local"]', `settingSources: ${JSON.stringify(s.session.extensions.settingSources)}`);
    assert((s.session.extensions.notApplied ?? null) === null, "notApplied is null while local settings apply");
    assert(existsSync(MARKER) && readFileSync(MARKER, "utf8") === "driver-local-ok", `the local SessionStart hook ran with the local env: ${existsSync(MARKER) ? readFileSync(MARKER, "utf8") : "(no marker)"}`);
    const localHooks = s.session.extensions.hooks.filter((h) => h.path.endsWith("settings.local.json"));
    assert(localHooks.length === 1 && localHooks[0].source === "project", `the local hooks are listed: ${JSON.stringify(localHooks)}`);
    observed.localSettings = { settingSources: s.session.extensions.settingSources, hookRanWithLocalEnv: true, listedHooks: localHooks.map((h) => h.events) };
    log("b local settings OK");

    // c. §36.8 — version, notice, cli_versions.
    assert(s.session.cli?.version === cliVersion, `session.cli.version ${s.session.cli?.version} = claude --version ${cliVersion}`);
    const notices = since(mark1, "error").filter((e) => e.code === "cli_version_changed");
    assert(notices.length === 1 && notices[0].cli.from === "2.1.308" && notices[0].cli.to === cliVersion, `one cli_version_changed notice: ${JSON.stringify(notices)}`);
    assert(s.session.cli.previous?.version === "2.1.308", `previous: ${JSON.stringify(s.session.cli.previous)}`);
    const versions = await request({ type: "cli_versions" });
    assert(versions.type === "cli_versions" && versions.current === cliVersion, `cli_versions current: ${versions.current}`);
    assert(versions.versions.some((v) => v.version === cliVersion), "the running version is among the installed ones");
    observed.cli = { version: cliVersion, verified: s.session.cli.verified, range: s.session.cli.verifiedRange, previous: s.session.cli.previous, notice: notices[0].message, installed: versions.versions.length };
    log(`c cli version OK: ${notices[0].message}`);

    // d. §36.9 — other sessions (counts only), then a scratch conversation imported and resumed.
    const listed = await request({ type: "cli_sessions" });
    observed.cliSessionsBefore = { running: listed.running.length, resumable: listed.resumable.length };
    const made = JSON.parse(execFileSync(CLAUDE, ["-p", "Remember the word PELICAN. Reply with just OK.", "--model", MODEL, "--output-format", "json"], { cwd: REPO, encoding: "utf8", timeout: 150_000 }));
    const sid = made.session_id;
    assert(typeof sid === "string" && sid.length > 0, "the print-mode conversation has a session id");
    const file = join(projectsDir, projectKey(REPO), `${sid}.jsonl`);
    assert(existsSync(file), `the CLI wrote ${file}`);
    // `-p` conversations are programmatic (entrypoint sdk-cli) — hidden from /resume and from the app's list like ReviewGate's
    // own. Relabel this scratch one as a terminal conversation (the driver's own file, removed at the end).
    writeFileSync(file, readFileSync(file, "utf8").split('"entrypoint":"sdk-cli"').join('"entrypoint":"cli"'));
    const after = await request({ type: "cli_sessions" });
    const found = after.resumable.find((r) => r.sessionId === sid);
    assert(found, "the scratch conversation is resumable");
    assert(!after.resumable.some((r) => r.sessionId === state.sessions.currentId), "the app's own chat is not listed");
    observed.cliSessionsAfter = { running: after.running.length, resumable: after.resumable.length, scratchListed: true };
    await request({ type: "cli_session_import", sessionId: sid });
    const imported = await waitState((x) => x.sessions.currentId === sid && x.session.open && !x.session.starting && x.session.ready === true, "the imported chat runs");
    const meta = imported.sessions.list.find((m) => m.id === sid);
    assert(meta?.imported && meta.cliKnown === true, `imported meta: ${JSON.stringify(meta)}`);
    const answer = await turn("Which word did I ask you to remember? Reply with just that word.");
    assert(/pelican/i.test(answer), `the imported conversation was resumed: ${JSON.stringify(answer.slice(0, 80))}`);
    assert(state.session.sessionId === sid, `the CLI resumed the same conversation (${state.session.sessionId})`);
    observed.import = { title: meta.title, answer: answer.trim().slice(0, 40) };
    log(`d import OK: ${answer.trim()}`);
  }
  await stopSidecar();

  // ============ sidecar #2: local settings off
  rmSync(MARKER, { force: true });
  startSidecar();
  await hello({ ...baseSettings, loadLocalSettings: false }, REPO);
  {
    const s = await waitState((x) => x.session.ready === true && x.session.extensions != null, "session ready (local off)");
    assert(JSON.stringify(s.session.extensions.settingSources) === '["user","project"]', `no local: ${JSON.stringify(s.session.extensions.settingSources)}`);
    const na = s.session.extensions.notApplied;
    assert(na && na.envKeys.includes("RG_DRIVER_LOCAL") && na.hooks.some((h) => h.event === "SessionStart"), `notApplied: ${JSON.stringify(na)}`);
    assert(!JSON.stringify(na).includes("driver-local-ok"), "no env value in notApplied");
    assert(!existsSync(MARKER), "the local hook did not run");
    observed.localOff = { settingSources: s.session.extensions.settingSources, notApplied: na };
    log("e local off OK");
  }
  await stopSidecar();

  // ============ sidecar #3: a start that stalls (a silent local SessionStart hook)
  startSidecar();
  const mark3 = events.length;
  const startedAt = Date.now();
  await hello({ ...baseSettings, extensionsInitTimeoutMs: 20_000 }, STALL);
  {
    const waiting = await waitState((x) => x.session.extensionsWaitingOn?.kind === "hook", "extensionsWaitingOn names the hook", 60_000);
    const s = await waitState((x) => x.session.extensions?.fallback != null && x.session.open && !x.session.starting, "the stall fallback", 120_000);
    const tookMs = Date.now() - startedAt;
    const fb = since(mark3, "extensions_fallback");
    assert(fb.length === 1 && fb[0].timeoutMs >= 45_000, `one fallback after the ≥ 45 s stall limit: ${JSON.stringify(fb)}`);
    assert(tookMs >= 44_000, `not cut at the 20 s the client sent (${tookMs} ms)`);
    assert(/waiting for SessionStart/.test(fb[0].message), `the message says what it waited for: ${fb[0].message}`);
    assert(JSON.stringify(s.session.extensions.settingSources) === '["project"]', `the fallback drops user and local: ${JSON.stringify(s.session.extensions.settingSources)}`);
    observed.stall = { waitingOn: waiting.session.extensionsWaitingOn, timeoutMs: fb[0].timeoutMs, tookMs, message: fb[0].message };
    log(`f stall OK after ${(tookMs / 1000).toFixed(1)} s: ${fb[0].message}`);
  }
  // Before the automatic retry (5 s idle) would start the stalled hook again.
  await stopSidecar();
}

function cleanup() {
  // The stalled hook outlives the CLI that was replaced: end it by its unique token.
  try {
    const out = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" });
    for (const l of out.split("\n")) if (l.includes(STALL_TOKEN) && !l.includes("driver-session")) {
      const pid = Number(/^\s*(\d+)/.exec(l)?.[1]);
      if (pid) try { process.kill(pid); } catch {}
    }
  } catch {}
  // The scratch conversations (the driver's and the app sessions it ran) under ~/.claude/projects.
  let removed = 0;
  for (const dir of [REPO, STALL]) {
    const key = projectKey(dir);
    if (!key.includes("driver-session") && !key.includes("engine-session")) continue; // only the scratch folders' own
    const p = join(projectsDir, key);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      removed += 1;
    }
  }
  // No registered claude process of the scratch dir is left alive (the registry is only read).
  const reg = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "sessions");
  let alive = 0;
  for (const n of existsSync(reg) ? readdirSync(reg).filter((f) => /^\d+\.json$/.test(f)) : []) {
    try {
      const o = JSON.parse(readFileSync(join(reg, n), "utf8"));
      if (typeof o.cwd === "string" && o.cwd.startsWith(SCRATCH)) {
        try {
          process.kill(o.pid, 0);
          alive += 1;
        } catch {}
      }
    } catch {}
  }
  return { removedProjectDirs: removed, liveScratchClaudes: alive };
}

main()
  .then(async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const c = cleanup();
    assert(c.liveScratchClaudes === 0, `claude processes of the scratch dir still alive: ${c.liveScratchClaudes}`);
    log("PASS");
    console.log(JSON.stringify({ ok: true, totalMs: Date.now() - t0, model: MODEL, cliVersion, cleanup: c, observed }, null, 2));
  })
  .catch(async (e) => {
    log(`FAIL: ${e.message}`);
    try {
      child?.kill();
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
    const c = cleanup();
    console.log(JSON.stringify({ ok: false, error: e.message, cleanup: c, observed }, null, 2));
    process.exitCode = 1;
  });
