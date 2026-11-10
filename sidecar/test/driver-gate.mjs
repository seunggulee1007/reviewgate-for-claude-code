#!/usr/bin/env node
// Real-CLI contract driver for docs/PROTOCOL.md §31–32 — review provenance, mods paths and nested repositories — through
// the bundled sidecar on a fresh scratch repo. Model: haiku (RG_MODEL), a few cents per run.
//
//   node sidecar/test/driver-gate.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-gate, RE-CREATED; sidecar/dist/sidecar.mjs)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
//
// 1. Another Claude (an SDK session of this driver in the same repo) is running → concurrent_claude on open_project.
// 2. One turn: Edit a.txt, Bash `echo built > out.txt`, Edit the gitignored .claude/hooks/sweep.sh, Edit a file in a nested
//    clone (vendor/lib) and one in a linked worktree under the project (tools/feature-wt) — both made by this driver with
//    git beforehand, at plain paths, so the model has no reason to skip them (the engine's "work only in this folder"
//    instruction is about worktrees it would create or cd into, §33.4); their cards (nested_repository) are approved —
//    while the "IDE" writes ide.txt and settings.local.json changes.
//    → origins tool / bash / external, mods group + risks, nested_changes (repo + worktree), changedOutside,
//      local_settings_changed.
// 3. reject_all leaves ide.txt (and the nested edits, outside the review); finish_review empties the list without touching disk.
// Cleans up ~/.claude/projects/<scratch key> afterwards, checks no CLI child is left, prints what was observed as JSON.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-gate");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 240_000;

const t0 = Date.now();
const log = (m) => process.stderr.write(`[gate +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const observed = { cli: null, model: MODEL, failures: [] };
const check = (cond, msg) => {
  log(`${cond ? "OK  " : "FAIL"} ${msg}`);
  if (!cond) observed.failures.push(msg);
};
/** The CLI's ~/.claude/projects key of a cwd (§30; < 200 chars here). */
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");

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
git("config", "user.email", "gate@example.com");
git("config", "user.name", "gate");
writeFileSync(join(REPO, ".gitignore"), ".claude/\nvendor/\ntools/\n");
writeFileSync(join(REPO, "a.txt"), "one\n");
git("add", "-A");
git("commit", "-q", "-m", "init");
mkdirSync(join(REPO, ".claude/hooks"), { recursive: true });
writeFileSync(join(REPO, ".claude/hooks/sweep.sh"), "#!/bin/sh\necho sweep\n");
chmodSync(join(REPO, ".claude/hooks/sweep.sh"), 0o755);
writeFileSync(join(REPO, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: [] } }) + "\n");
// Nested repositories the turn edits: a clone (kind repo) and a linked worktree of this repository (kind worktree).
const LIB = join(REPO, "vendor", "lib");
mkdirSync(LIB, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", LIB]);
writeFileSync(join(LIB, "lib.txt"), "lib\n");
execFileSync("git", ["-C", LIB, "-c", "user.email=x@example.com", "-c", "user.name=x", "add", "-A"]);
execFileSync("git", ["-C", LIB, "-c", "user.email=x@example.com", "-c", "user.name=x", "commit", "-q", "-m", "lib"]);
const WT = join(REPO, "tools", "feature-wt");
git("worktree", "add", "-q", "-b", "feature-wt", WT);

// ---------------------------------------------------------------- another Claude in the same worktree
let release;
const hold = new Promise((r) => (release = r));
let otherChild;
async function* otherInbox() {
  yield { type: "user", message: { role: "user", content: "Reply with the single word OK." }, parent_tool_use_id: null, session_id: "" };
  await hold;
}
const other = query({
  prompt: otherInbox(),
  options: {
    cwd: REPO, model: MODEL, maxTurns: 1, settingSources: [], pathToClaudeCodeExecutable: CLAUDE,
    env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
    spawnClaudeCodeProcess: (o) => (otherChild = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], signal: o.signal })),
  },
});
const otherDone = (async () => {
  for await (const m of other) if (m.type === "result") log("the other Claude answered");
})().catch(() => undefined);
// Its own registry entry only (`~/.claude/sessions/<pid>.json` of the child this driver spawned) — never another file there.
const registered = () => !!otherChild && existsSync(join(homedir(), ".claude", "sessions", `${otherChild.pid}.json`));
for (let i = 0; i < 100 && !registered(); i++) await sleep(200);
log(`other Claude pid ${otherChild?.pid}, registered: ${registered()}`);

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
      log(`permission_request ${ev.toolName}${ev.reason ? ` reason=${ev.reason.code}` : ""} → allow`);
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
const request = (cmd) => {
  const id = `g${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type}`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      if (ev.type === "result" && !ev.ok) reject(new Error(`${cmd.type} failed: ${ev.error}`));
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

try {
  observed.cli = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
  await request({
    type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" },
    settings: {
      ignorePatterns: [".omc/", ".claude/settings.local.json"], autoAllowTools: [], loadUserSettings: false,
      systemPromptAppend: "You are running inside ReviewGate. Do exactly the requested steps, in order, then stop. Never run git commands.",
      claudePath: CLAUDE, model: MODEL, ghHost: "github.com",
    },
  });
  await request({ type: "open_project", path: REPO });
  await waitState((s) => s.session.open && !s.session.starting, "session open");
  await sleep(500);
  const conc = events.filter((e) => e.type === "concurrent_claude");
  observed.concurrentOnOpen = conc.map((e) => ({ at: e.at, pids: e.sessions.map((s) => s.pid), names: e.sessions.map((s) => s.name), entrypoints: e.sessions.map((s) => s.entrypoint) }));
  check(conc.some((e) => e.at === "open" && e.sessions.some((s) => s.pid === otherChild?.pid)), "concurrent_claude on open lists the other Claude");
  check(!conc.some((e) => e.sessions.some((s) => s.entrypoint === "sdk-cli" && s.pid !== otherChild?.pid)), "the engine's own CLI is never listed");

  const before = state.hud.turnCount;
  await request({
    type: "send",
    text:
      "Do these steps exactly, in order, nothing else (Read a file first when the Edit tool needs it):\n" +
      "1. Use the Edit tool on a.txt to replace the word one with two.\n" +
      "2. Use the Bash tool to run exactly: echo built > out.txt\n" +
      "3. Use the Edit tool on .claude/hooks/sweep.sh to replace `echo sweep` with `echo changed`.\n" +
      "4. Use the Edit tool on vendor/lib/lib.txt to replace the word lib with nested.\n" +
      "5. Use the Edit tool on tools/feature-wt/a.txt to replace the word one with nested.\n" +
      "Then reply DONE.",
  });
  // Meanwhile, outside Claude: an IDE save and a local-settings change.
  writeFileSync(join(REPO, "ide.txt"), "saved by IntelliJ\n");
  writeFileSync(join(REPO, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(rm:*)"] } }) + "\n");
  observed.concurrentOnSend = events.filter((e) => e.type === "concurrent_claude" && e.at === "send").length;
  await waitState((x) => x.hud.turnCount > before && x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn collected");
  await sleep(1500); // head_moved / local settings / nested come right after turn_end
  const st = state;
  observed.toolUses = events.filter((e) => e.type === "tool_use").map((e) => e.name + (e.input.file_path ? ` ${e.input.file_path.replace(REPO + "/", "")}` : e.input.command ? ` ${e.input.command}` : ""));
  observed.cards = events.filter((e) => e.type === "permission_request").map((e) => ({ toolName: e.toolName, reason: e.reason?.code ?? null, path: e.reason?.path ?? null }));
  observed.changedFiles = st.changedFiles.map((f) => ({ path: f.path, origin: f.origin, tools: f.tools, group: f.group, risk: f.risk, ignored: f.ignored }));
  observed.turnEnd = events.filter((e) => e.type === "turn_end").map((e) => ({ files: e.files, external: e.external, changedOutside: e.changedOutside }));
  observed.gate = { externalPendingCount: st.gate.externalPendingCount, nestedChanges: st.gate.nestedChanges, localSettingsChanged: st.gate.localSettingsChanged, headMoved: st.gate.headMoved, changedOutside: st.gate.changedOutside };
  const byPath = Object.fromEntries(st.changedFiles.map((f) => [f.path, f]));
  check(byPath["a.txt"]?.origin === "tool", "a.txt (Edit) is origin tool");
  check(byPath["out.txt"]?.origin === "bash", "out.txt (Bash) is origin bash");
  check(byPath["ide.txt"]?.origin === "external", "ide.txt (IDE) is origin external");
  check(byPath[".claude/hooks/sweep.sh"]?.group === "mods" && (byPath[".claude/hooks/sweep.sh"]?.risk ?? []).includes("hook"), "the gitignored hook is in the review (mods, risk hook)");
  check(!byPath[".claude/settings.local.json"], "settings.local.json is not in the review");
  check(st.gate.localSettingsChanged?.permissions === true, "settings.local.json permissions change reported by hash");
  check(st.gate.externalPendingCount === 1, "one external pending file");
  // The nested repositories: each edit was a card (nested_repository) the driver approved, outside the review.
  const nested = st.gate.nestedChanges ?? [];
  for (const [rel, kind, file] of [["vendor/lib", "repo", "lib.txt"], ["tools/feature-wt", "worktree", "a.txt"]]) {
    const card = observed.cards.find((c) => c.reason === "nested_repository" && c.path === join(REPO, rel));
    check(!!card, `${rel}: the edit got a card with reason nested_repository`);
    const n = nested.find((x) => x.path === rel);
    check(n?.kind === kind && n.touchedFiles.includes(`${rel}/${file}`) && n.via.includes("edit"), `${rel}: nested_changes reports the ${kind} edit (got ${JSON.stringify(n ?? null)})`);
    check(st.gate.changedOutside.some((p) => p.endsWith(`/${rel}/${file}`)), `${rel}: the approved edit is in changedOutside`);
    check(!byPath[`${rel}/${file}`], `${rel}: the nested file is not in the review list`);
  }
  check(nested.find((x) => x.path === "tools/feature-wt")?.branch === "feature-wt", "tools/feature-wt: nested_changes names its branch");

  await request({ type: "reject_all" });
  const after = state;
  observed.afterRejectAll = after.changedFiles.map((f) => [f.path, f.origin, f.state]);
  check(readFileSync(join(REPO, "a.txt"), "utf8") === "one\n", "reject_all reverted a.txt");
  check(!existsSync(join(REPO, "out.txt")), "reject_all removed out.txt");
  check(readFileSync(join(REPO, ".claude/hooks/sweep.sh"), "utf8") === "#!/bin/sh\necho sweep\n", "reject_all restored the hook");
  check(readFileSync(join(REPO, "ide.txt"), "utf8") === "saved by IntelliJ\n", "reject_all left the IDE's file alone");
  check(readFileSync(join(LIB, "lib.txt"), "utf8") === "nested\n" && readFileSync(join(WT, "a.txt"), "utf8") === "nested\n", "reject_all left the nested edits alone (outside the review)");
  await request({ type: "finish_review" });
  // The reply can come before the snapshot that follows it (state is coalesced): wait for it.
  const fin = await waitState((x) => x.changedFiles.length === 0, "finish_review snapshot").catch(() => state);
  check(fin.changedFiles.length === 0 && existsSync(join(REPO, "ide.txt")), "finish_review emptied the list, ide.txt still on disk");
  await request({ type: "shutdown" });
  const { code } = await Promise.race([exited, sleep(10_000).then(() => ({ code: "timeout" }))]);
  check(code === 0, `sidecar exited 0 (got ${code})`);
} catch (e) {
  observed.failures.push(String(e));
  log(String(e));
  child.kill("SIGKILL");
} finally {
  release();
  await Promise.race([otherDone, sleep(3000)]);
  try {
    otherChild?.kill("SIGTERM");
  } catch {}
  const left = claudeChildren();
  observed.leftoverChildren = left.length;
  if (left.length > 0) observed.failures.push(`leftover CLI children: ${left.join(", ")}`);
  // The CLI project folder of the scratch repo (this driver's sidecar session and its other Claude) is scratch too.
  const key = projectKey(REPO);
  if (key.includes("rg-gate") || key.includes("scratchpad")) rmSync(join(homedir(), ".claude", "projects", key), { recursive: true, force: true });
  process.stdout.write(JSON.stringify(observed, null, 2) + "\n");
  log(observed.failures.length > 0 ? "FAILED" : "OK");
  process.exit(observed.failures.length > 0 ? 1 : 0);
}
