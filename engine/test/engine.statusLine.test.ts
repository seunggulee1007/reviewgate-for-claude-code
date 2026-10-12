// MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the engine runs the user's status line for an open chat and
// sends what it printed. The user's settings are a temp CLAUDE_CONFIG_DIR (never the developer's own ~/.claude); the
// command is a fake statusline script that echoes what it read. Also writes the wire golden the Swift tests decode.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPlatform } from "../src/platform/index.js";
import type { StatusLineEvent } from "../src/protocol.js";
import { cliProjectDirName } from "../src/session/cliRecords.js";
import { NO_MANAGED_POLICY, type ManagedPolicy } from "../src/statusline/managed.js";
import { commandSha256 } from "../src/statusline/settings.js";
import { fakePlatform, makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, write } from "./helpers/repo.js";

const isWindows = process.platform === "win32";
const real = createPlatform(process.platform);
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "wire", "wave6.statusline.json");

/** Prints a bold model name, a 256-color version, the context percent and an OSC 8 link; logs its stdin. */
const SCRIPT = `
import { appendFileSync, existsSync } from "node:fs";
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const j = JSON.parse(s);
  appendFileSync(process.env.SL_LOG, JSON.stringify({ columns: process.env.COLUMNS, input: j }) + "\\n");
  if (existsSync(process.env.SL_LOG + ".fail")) { process.stderr.write("statusline: jq not found\\n"); process.exit(127); }
  const pct = j.context_window.used_percentage;
  process.stdout.write("\\x1b[1m" + j.model.display_name + "\\x1b[0m \\x1b[38;5;214mv" + (j.version || "?") + "\\x1b[0m ctx:" + (pct === null ? "-" : pct) + "%\\n");
  process.stdout.write("\\x1b]8;;https://example.com/pr/1\\x1b\\\\PR #1\\x1b]8;;\\x1b\\\\ cols=" + process.env.COLUMNS + (j.rate_limits ? " 5h:" + j.rate_limits.five_hour.used_percentage + "%" : "") + "\\n");
});
`;

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function tmp(prefix: string): string {
  const d = makeTempDir(prefix);
  dirs.push(d);
  return d;
}

function makeRepo(): string {
  const dir = join(tmp("rg-sl-engine"), "repo");
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write(dir, "README.md", "hello\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

type Setup = { h: Harness; dir: string; config: string; log: string; command: string };

async function setup(opts: { settings?: Record<string, unknown>; project?: Record<string, unknown>; script?: string; managed?: ManagedPolicy; dataDir?: string } = {}): Promise<Setup> {
  const dir = makeRepo();
  const config = tmp("rg-sl-config");
  const scripts = tmp("rg-sl-script");
  const script = join(scripts, "line.mjs");
  writeFileSync(script, opts.script ?? SCRIPT);
  const fwd = (p: string) => p.replace(/\\/g, "/");
  const command = isWindows ? `node "${fwd(script)}"` : `"${process.execPath}" "${script}"`;
  writeFileSync(join(config, "settings.json"), JSON.stringify({ statusLine: { type: "command", command, padding: 1 }, ...(opts.settings ?? {}) }));
  if (opts.project) write(dir, ".claude/settings.json", JSON.stringify(opts.project));
  const log = join(scripts, "runs.ndjson");
  const h = makeHarness({
    env: { CLAUDE_CONFIG_DIR: config, SL_LOG: log },
    // The real shell choice (Windows: Git Bash, found through the real `which`), the real tree kill; the rest is the fake's.
    platform: { ...fakePlatform, isWindows, killTree: (pid) => real.killTree(pid), which: (name, env) => real.which(name, env) },
    // Never this machine's own managed settings.
    managedPolicy: () => opts.managed ?? NO_MANAGED_POLICY,
    dataDir: opts.dataDir ?? tmp("rg-sl-data"),
    cliVersionsDir: tmp("rg-sl-versions"),
    statusLineTiming: { debounceMs: 20, maxWaitMs: 60, recheckMs: 60_000, timeoutMs: 8000, minIntervalMs: 0 }, // wave7: interval tested in the runner
  });
  harnesses.push(h);
  await h.hello({ model: "claude-opus-5-5" });
  await h.open(dir);
  return { h, dir, config, log, command };
}

const runs = (log: string): { columns: string; input: Record<string, any> }[] =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

async function until<T>(get: () => T | undefined | null | false, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const pushed = (h: Harness) => h.ofType("status_line").filter((e) => !e.id);

describe("engine status line (§44.2)", () => {
  it("replies with what is configured, then runs it for the open chat with the CLI's stdin and sends the lines", async () => {
    const { h, dir, config, log, command } = await setup();
    h.session().emitSessionInfo({ model: "claude-opus-5-5", cliVersion: "2.1.310" });
    const reply = await h.engine.request({ type: "status_line", columns: 90, visible: true });
    expect(reply).toMatchObject({ type: "status_line", lines: [], updatedAt: null, enabled: true, configured: true, source: "user", path: join(config, "settings.json"), command, padding: 1 });
    const ev = await until(() => pushed(h).find((e) => e.lines.length > 0), "the first lines");
    expect(ev.lines).toEqual(["\x1b[1mOpus 5.5\x1b[0m \x1b[38;5;214mv2.1.310\x1b[0m ctx:-%", "\x1b]8;;https://example.com/pr/1\x1b\\PR #1\x1b]8;;\x1b\\ cols=90"]);
    expect(ev.updatedAt).toBe(new Date(1_700_000_000_000).toISOString());

    const [run] = runs(log);
    const sessionId = h.engine.state.sessions.currentId!;
    expect(run!.columns).toBe("90");
    expect(run!.input).toMatchObject({
      session_id: sessionId,
      cwd: dir,
      model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
      workspace: { current_dir: dir, project_dir: dir, added_dirs: [] },
      version: "2.1.310",
      output_style: { name: "default" },
      cost: { total_cost_usd: 0, total_lines_added: 0, total_lines_removed: 0 },
      context_window: { context_window_size: 200_000, current_usage: null, used_percentage: null },
      exceeds_200k_tokens: false,
      fast_mode: false,
      effort: { level: "high" },
      thinking: { enabled: true },
    });
    expect(run!.input.session_name).toMatch(/^ReviewGate · repo/);
    expect(run!.input).not.toHaveProperty("rate_limits");
    // The CLI's own record of this chat: <config>/projects/<key of the real cwd>/<id>.jsonl.
    const transcript = run!.input.transcript_path as string;
    expect(basename(transcript)).toBe(`${sessionId}.jsonl`);
    expect(basename(dirname(transcript))).toBe(cliProjectDirName(realpathSync(dir), { CLAUDE_CONFIG_DIR: config }));
    expect(basename(dirname(dirname(transcript)))).toBe("projects");
  });

  it("runs again after a main answer, a turn's end and a usage window — with the new context, cost and limits", async () => {
    const { h, log } = await setup();
    await h.engine.request({ type: "status_line", columns: 120 });
    await until(() => runs(log).length === 1, "the first run");
    const session = h.session() as unknown as { statusUsage?: unknown };
    session.statusUsage = { usage: { input_tokens: 10, output_tokens: 900, cache_creation_input_tokens: 4000, cache_read_input_tokens: 10_000 }, model: "claude-opus-5-5", apiDurationMs: 4200 };
    await h.engine.handle({ type: "send", text: "hi" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    h.session().emitTurnEnd({ usage: { costUsd: 0.25, contextTokens: 14_010 } });
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn collected");
    const after = await until(() => runs(log).find((r) => r.input.context_window.used_percentage === 7 && r.input.cost.total_cost_usd === 0.25), "a run with the turn's numbers");
    expect(after.input.cost.total_api_duration_ms).toBe(4200);
    expect(after.input.context_window.current_usage).toEqual({ input_tokens: 10, output_tokens: 900, cache_creation_input_tokens: 4000, cache_read_input_tokens: 10_000 });

    h.session().emit({ type: "rate_limit_info", window: { kind: "five_hour", status: "allowed", percent: 22, resetsAt: "2026-12-01T05:00:00.000Z", at: "2026-12-01T01:00:00.000Z" } });
    const limited = await until(() => runs(log).find((r) => r.input.rate_limits), "a run with the usage window");
    expect(limited.input.rate_limits).toEqual({ five_hour: { used_percentage: 22, resets_at: Date.parse("2026-12-01T05:00:00Z") / 1000 } });
    expect(await until(() => pushed(h).at(-1)?.lines[1]?.endsWith("5h:22%"), "the line with it")).toBe(true);
  });

  it("a resumed chat's context comes from the CLI's transcript until the session answers itself", async () => {
    const { h, dir, config, log } = await setup();
    const sessionId = h.engine.state.sessions.currentId!;
    const file = join(config, "projects", cliProjectDirName(realpathSync(dir), { CLAUDE_CONFIG_DIR: config }), `${sessionId}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 2, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 99_998 } } }) + "\n");
    await h.engine.request({ type: "status_line", columns: 120 });
    const run = await until(() => runs(log)[0], "a run");
    expect(run.input.transcript_path).toBe(file);
    expect(run.input.context_window).toMatchObject({ total_input_tokens: 100_000, used_percentage: 50, remaining_percentage: 50 });
  });

  it("before this session's first result, the window is the one the model ran with last (not 200k for a 1M model); a turn's end remembers it", async () => {
    const data = tmp("rg-sl-data");
    writeFileSync(join(data, "context-windows.json"), JSON.stringify({ "claude-opus-5-5": 1_000_000 }));
    const { h, log } = await setup({ dataDir: data });
    await h.engine.request({ type: "status_line", columns: 120 });
    const run = await until(() => runs(log)[0], "a run");
    expect(run.input.context_window.context_window_size).toBe(1_000_000);

    await h.engine.handle({ type: "send", text: "hi" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    h.session().emitTurnEnd({ usage: { contextTokens: 10, contextWindow: 400_000 } });
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn collected");
    expect(JSON.parse(readFileSync(join(data, "context-windows.json"), "utf8"))["claude-opus-5-5"]).toBe(400_000);
  });

  it("follows its settings: off sends empty lines and runs nothing; my hooks off says why", async () => {
    const { h, log } = await setup();
    await h.engine.request({ type: "status_line", columns: 120 });
    await until(() => pushed(h).find((e) => e.lines.length > 0), "lines");
    await h.engine.handle({ type: "set_settings", settings: { showStatusLine: false } });
    expect(pushed(h).at(-1)).toMatchObject({ enabled: false, lines: [], configured: true });
    const n = runs(log).length;
    await h.engine.handle({ type: "send", text: "hi" });
    await new Promise((r) => setTimeout(r, 300));
    expect(runs(log).length).toBe(n);
    await h.engine.handle({ type: "set_settings", settings: { showStatusLine: true, disableUserHooks: true } });
    expect(pushed(h).at(-1)).toMatchObject({ enabled: true, configured: false, disabled: "disable_all_hooks", lines: [] });
  });

  it("a project's own statusLine runs only once its very command is allowed; a changed command stops it and asks again", async () => {
    const projectScript = `process.stdin.resume(); process.stdin.on("end", () => console.log("from the project"));`;
    const { h, dir } = await setup({ settings: { statusLine: undefined } });
    const scripts = tmp("rg-sl-proj");
    const file = join(scripts, "p.mjs");
    writeFileSync(file, projectScript);
    const command = isWindows ? `node "${file.replace(/\\/g, "/")}"` : `"${process.execPath}" "${file}"`;
    write(dir, ".claude/settings.json", JSON.stringify({ statusLine: { type: "command", command } }));
    const blocked = await h.engine.request({ type: "status_line", columns: 120 });
    const sha256 = commandSha256(command);
    expect(blocked).toMatchObject({ configured: false, lines: [], project: { path: join(dir, ".claude", "settings.json"), command, sha256, allowed: false } });
    await h.engine.handle({ type: "set_settings", settings: { allowedProjectStatusLine: commandSha256("something else") } });
    expect(pushed(h).filter((e) => e.lines.length > 0)).toHaveLength(0);
    await h.engine.handle({ type: "set_settings", settings: { allowedProjectStatusLine: sha256 } });
    const ev = await until(() => pushed(h).find((e) => e.lines.length > 0), "the project's line");
    expect(ev).toMatchObject({ configured: true, source: "project", lines: ["from the project"], project: { sha256, allowed: true } });
    // A pull changes the command: it no longer runs, its lines go, and the clients are told the new one to ask about.
    const changed = `${command} --upload`;
    write(dir, ".claude/settings.json", JSON.stringify({ statusLine: { type: "command", command: changed } }));
    await h.engine.handle({ type: "send", text: "hi" });
    const asked = await until(() => pushed(h).find((e) => e.project?.command === changed), "the changed command");
    expect(asked).toMatchObject({ configured: false, lines: [], project: { sha256: commandSha256(changed), allowed: false } });
  });

  it("a managed source that cannot be read: nothing runs, and the clients are told why", async () => {
    const { h, log } = await setup({ managed: { settings: null, sources: [], failed: { kind: "file", path: "/etc/claude-code/managed-settings.json", reason: "not JSON" } } });
    const reply = await h.engine.request({ type: "status_line", columns: 120 });
    expect(reply).toMatchObject({ configured: false, disabled: "managed_policy", lines: [] });
    await new Promise((r) => setTimeout(r, 300));
    expect(runs(log)).toHaveLength(0);
  });

  it("closing the project takes the line away at once", async () => {
    const { h } = await setup();
    await h.engine.request({ type: "status_line", columns: 120 });
    await until(() => pushed(h).find((e) => e.lines.length > 0), "lines");
    await h.engine.handle({ type: "close_project" });
    expect(pushed(h).at(-1)).toMatchObject({ lines: [], updatedAt: null });
    expect(await h.engine.request({ type: "status_line", columns: 120 })).toMatchObject({ lines: [] });
  });

  it("a client sending its whole settings again (unchanged) runs nothing", async () => {
    const { h, log } = await setup();
    await h.engine.request({ type: "status_line", columns: 120 });
    await until(() => runs(log).length === 1, "the first run");
    await h.engine.handle({ type: "set_settings", settings: { showStatusLine: true, allowedProjectStatusLine: "", disableUserHooks: false } });
    await new Promise((r) => setTimeout(r, 300));
    expect(runs(log)).toHaveLength(1);
  });

  it("wire golden: the reply, an update, a failure that keeps the lines, and off", async () => {
    const { h, dir, config, log, command } = await setup();
    h.session().emitSessionInfo({ model: "claude-opus-5-5", cliVersion: "2.1.310" });
    const reply = await h.engine.request({ type: "status_line", columns: 100, visible: true });
    const update = await until(() => pushed(h).find((e) => e.lines.length > 0), "lines");
    // The failing run: the same command, its stderr says why (the lines stay the last good ones).
    writeFileSync(`${log}.fail`, "");
    await h.engine.handle({ type: "send", text: "go" });
    const failed = await until(() => pushed(h).find((e) => e.error), "the failure");
    await h.engine.handle({ type: "set_settings", settings: { showStatusLine: false } });
    const off = pushed(h).at(-1)!;
    const pin = (ev: StatusLineEvent) => {
      expect(ev.command ?? command).toBe(command);
      expect(ev.path ?? join(config, "settings.json")).toBe(join(config, "settings.json"));
      return JSON.parse(JSON.stringify({ ...ev, ...(ev.command ? { command: "~/.claude/statusline.sh" } : {}), ...(ev.path ? { path: "/home/me/.claude/settings.json" } : {}) }).split(dir).join("/repo"));
    };
    const golden = { reply: pin({ ...reply, id: "sl-1" }), update: pin(update), failed: pin(failed), off: pin(off) };
    expect(golden.failed.error).toEqual({ code: "exit", message: "statusline: jq not found", at: new Date(1_700_000_000_000).toISOString(), exitCode: 127 });
    expect(golden.failed.lines).toEqual(golden.update.lines);
    const text = JSON.stringify(golden, null, 2) + "\n";
    if (process.env.UPDATE_WIRE_FIXTURES || !existsSync(GOLDEN)) writeFileSync(GOLDEN, text);
    expect(JSON.parse(readFileSync(GOLDEN, "utf8"))).toEqual(JSON.parse(text));
  });
});
