#!/usr/bin/env node
// Real-CLI check for docs/PROTOCOL.md §42.3 (the `.mcp.json` files above a project): servers defined in a folder above the
// project connect in a ReviewGate session as in the terminal there — in the main checkout and in a workbench of it that lives
// outside the project's folders (as ReviewGate's managed ones do, `~/.reviewgate/worktrees/…`), where the CLI by itself
// only reads the `.mcp.json` files above the workbench.
//   <scratch>/h/.mcp.json             rgp-outer          (a folder above both, like the home folder)
//   <scratch>/h/work/acme/.mcp.json   rgp-db, rgp-docs   (the project's parent)
//   <scratch>/h/work/acme/app         the project (git), `.claude/settings.local.json` approving all three
//   <scratch>/h/wt/app-1234/feat      a workbench of it
// What `claude mcp list` says in each folder is printed as the terminal's view; then the bundled sidecar opens each folder
// with the app's default settings sources (user + project + local) and reports the scratch servers it lists, and Claude
// calls rgp-db's tool once in the workbench. Model calls on RG_MODEL (default haiku).
//
//   node sidecar/test/driver-parent-mcp.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-parent-mcp, RE-CREATED)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
// Prints what was observed as JSON (only the scratch servers); exits 1 when a scratch server is missing or not connected.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-parent-mcp");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 120_000;
const MINE = /^rgp-/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => process.stderr.write(`[parent-mcp +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };

// A minimal stdio MCP server: initialize, one tool (`ping`), its call.
const server = join(ROOT, "srv.mjs");
writeFileSync(server, `import { createInterface } from "node:readline";
const name = process.argv[2];
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } } });
  else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ping", description: "Answers with a fixed word", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.method === "tools/call") out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "PONG-" + name.toUpperCase() } ] } });
  else out({ jsonrpc: "2.0", id: m.id, result: {} });
});
`);
const entry = (name) => ({ type: "stdio", command: process.execPath, args: [server, name] });
const H = join(ROOT, "h");
const acme = join(H, "work", "acme");
const app = join(acme, "app");
mkdirSync(join(app, ".claude"), { recursive: true });
writeFileSync(join(H, ".mcp.json"), JSON.stringify({ mcpServers: { "rgp-outer": entry("rgp-outer") } }));
writeFileSync(join(acme, ".mcp.json"), JSON.stringify({ mcpServers: { "rgp-db": entry("rgp-db"), "rgp-docs": entry("rgp-docs") } }));
writeFileSync(join(app, ".claude", "settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ["rgp-outer", "rgp-db", "rgp-docs"] }));
git(app, "init", "-q", "-b", "main");
git(app, "config", "user.email", "parent-mcp@example.com");
git(app, "config", "user.name", "parent-mcp");
writeFileSync(join(app, "README.md"), "parent mcp check\n");
writeFileSync(join(app, ".gitignore"), ".claude/settings.local.json\n");
git(app, "add", "-A");
git(app, "commit", "-q", "-m", "init");
const wt = join(H, "wt", "app-1234", "feat");
mkdirSync(dirname(wt), { recursive: true });
git(app, "worktree", "add", "-q", "-b", "feat", wt);
const EXPECTED = ["rgp-db", "rgp-docs", "rgp-outer"];

/** The terminal's view: `claude mcp list` in `cwd`, the scratch servers only. */
function terminalView(cwd) {
  let text = "";
  try {
    text = execFileSync(CLAUDE, ["mcp", "list"], { cwd, encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    text = String(e.stdout ?? "");
  }
  return text.split("\n").map((l) => /^(rgp-[a-z]+):/.exec(l)?.[1]).filter(Boolean).sort();
}

/** One sidecar: `open_project` on `path`, the scratch servers of `mcp_status` once they settled; `ask` sends one message. */
async function appView(path, ask) {
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
      await sleep(200);
    }
  };
  const out = {};
  try {
    const settings = {
      budget: { maxFiles: 0, maxLines: 0 }, ignorePatterns: [], autoAllowTools: [],
      // The app's defaults: user + project + local settings sources.
      loadUserSettings: true,
      systemPromptAppend: "You are running inside a ReviewGate test. Do exactly what each message asks, nothing more.",
      claudePath: CLAUDE, model: MODEL, ghHost: "github.com",
    };
    await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
    await request({ type: "open_project", path });
    await waitFor(() => state?.session.open && !state.session.starting, "session open");
    out.settingSources = state.session.extensions?.settingSources ?? null;
    let mine = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const st = await request({ type: "mcp_status" });
      mine = (st.servers ?? []).filter((s) => MINE.test(s.name));
      if (mine.length >= EXPECTED.length && mine.every((s) => s.status !== "pending")) break;
      await sleep(1000);
    }
    out.servers = mine
      .map((s) => ({ name: s.name, status: s.status, source: s.source, file: s.origin?.file ? s.origin.file.replace(ROOT, "<scratch>") : null, place: s.origin?.place ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (ask) {
      const from = events.length;
      await request({ type: "send", text: "Call the MCP tool `ping` of the server rgp-db once (mcp__rgp-db__ping). Then reply with exactly the text it returned." });
      await waitFor(() => events.slice(from).some((e) => e.type === "turn_end"), "turn end");
      const text = events.slice(from).filter((e) => e.type === "text_delta").map((e) => e.text ?? "").join("");
      out.toolCalls = events.slice(from).filter((e) => e.type === "tool_use").map((e) => e.name);
      out.reply = text.trim().slice(-80);
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  } finally {
    send({ type: "shutdown", id: "bye" });
    await Promise.race([exited, sleep(10_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  return out;
}

const observed = { cli: null };
let failed = false;
try {
  observed.cli = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
  observed.terminal = { app: terminalView(app), workbench: terminalView(wt) };
  log(`terminal: ${JSON.stringify(observed.terminal)}`);
  observed.app = await appView(app, false);
  log(`app (main checkout): ${JSON.stringify(observed.app)}`);
  observed.workbench = await appView(wt, true);
  log(`app (workbench): ${JSON.stringify(observed.workbench)}`);
  const allConnected = (v) => !v.error && EXPECTED.every((n) => v.servers?.some((s) => s.name === n && s.status === "connected"));
  const labelled = (v) => ["rgp-db", "rgp-docs"].every((n) => v.servers?.find((s) => s.name === n)?.file === "<scratch>/h/work/acme/.mcp.json" && v.servers.find((s) => s.name === n).place === "parent" && v.servers.find((s) => s.name === n).source === "project");
  failed = JSON.stringify(observed.terminal.app) !== JSON.stringify(EXPECTED)
    || !allConnected(observed.app) || !labelled(observed.app)
    || !allConnected(observed.workbench) || !labelled(observed.workbench)
    || !(observed.workbench.toolCalls ?? []).some((n) => /rgp-db/.test(n)) || !String(observed.workbench.reply ?? "").includes("PONG-RGP-DB");
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
