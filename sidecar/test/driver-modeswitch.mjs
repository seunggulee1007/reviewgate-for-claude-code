#!/usr/bin/env node
// Real-CLI check for docs/PROTOCOL.md §39.5 (a mode picked while Claude works): a chat in the default mode is asked for
// three commands that change files; the first one's card is allowed and `set_permission_mode auto` goes out while that
// command still runs — the remaining two must run without a card (the CLI applies `Query.setPermissionMode` from its next
// tool call), and all three files must reach the review at the turn's end. Through the bundled sidecar on a fresh scratch
// repository (loadUserSettings off). One turn on RG_MODEL (default sonnet: haiku has no auto mode).
//
//   node sidecar/test/driver-modeswitch.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-modeswitch, RE-CREATED)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
// Prints what was observed as JSON; exits 1 when a command after the switch still asked, or a file is missing.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-modeswitch");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "sonnet";
const STEP_TIMEOUT_MS = 180_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => process.stderr.write(`[modeswitch +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
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
git(repo, "config", "user.email", "modeswitch@example.com");
git(repo, "config", "user.name", "modeswitch");
writeFileSync(join(repo, "README.md"), "mode switch check\n");
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
const request = (cmd) =>
  new Promise((resolve, reject) => {
    const id = `m${next++}`;
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type}`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      resolve(ev);
    });
    send({ ...cmd, id });
  });

/** Every card is allowed (the turn must finish either way); the first one also switches the chat to auto mode. */
const cards = [];
let switched = null;
createInterface({ input: child.stdout }).on("line", (line) => {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.type === "state") state = ev.state;
  else events.push(ev);
  if (ev.type === "permission_request") {
    const command = typeof ev.input?.command === "string" ? ev.input.command : "";
    cards.push({ tool: ev.toolName, command, afterSwitch: switched !== null, mode: state?.session.permissionMode ?? null });
    log(`card ${cards.length}: ${ev.toolName} ${command}`);
    send({ type: "permission_response", requestId: ev.requestId, allow: true });
    if (switched === null) {
      switched = request({ type: "set_permission_mode", mode: "auto" }).then(
        (r) => (r.ok === false ? r.error : "ok"),
        (e) => (e instanceof Error ? e.message : String(e)),
      );
    }
  }
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
});
const waitFor = async (pred, what) => {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};

const observed = { cli: null, model: MODEL };
let failed = false;
try {
  observed.cli = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
  const settings = {
    budget: { maxFiles: 0, maxLines: 0 },
    ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, autoAllowReadOnlyBash: true,
    systemPromptAppend: "You are running inside a ReviewGate test. Do exactly what each message asks, nothing more.",
    claudePath: CLAUDE, model: MODEL, ghHost: "github.com", permissionMode: "default",
  };
  await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  await request({ type: "open_project", path: repo });
  await waitFor(() => state?.session.open && !state.session.starting, "session open");
  observed.startMode = state.session.permissionMode;
  await request({
    type: "send",
    text: "Run these three Bash commands, each in its own Bash call, one after the other, exactly as written: " +
      "`sleep 4 && echo one > one.txt`, then `echo two > two.txt`, then `echo three > three.txt`. " +
      "Then reply with exactly one line: SWITCH-DONE",
  });
  await waitFor(() => events.some((e) => e.type === "turn_end"), "turn end");
  await waitFor(() => state?.gate.phase !== "running" && state?.gate.phase !== "collecting", "review collected");
  await sleep(1500);
  observed.switchReply = switched ? await switched : "never sent (no card came)";
  observed.modeAfter = state?.session.permissionMode ?? null;
  observed.cards = cards;
  observed.cardsAfterSwitch = cards.filter((c) => c.afterSwitch).length;
  observed.bashCalls = events.filter((e) => e.type === "tool_use" && e.name === "Bash").map((e) => String(e.input?.command ?? "").slice(0, 60));
  observed.autoModeNotices = events.filter((e) => e.type === "error" && typeof e.code === "string" && e.code.startsWith("auto_mode")).map((e) => `${e.code}: ${e.detail ?? e.message}`);
  observed.turnEnds = events.filter((e) => e.type === "turn_end").map((e) => e.stopReason);
  observed.files = (state?.changedFiles ?? []).map((f) => f.path).sort();
  log(JSON.stringify(observed));
  failed = observed.switchReply !== "ok" || cards.length < 1 || observed.cardsAfterSwitch !== 0 || observed.modeAfter !== "auto"
    || !["one.txt", "two.txt", "three.txt"].every((f) => observed.files.includes(f));
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
