// MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the status line runs like Claude Code's — a real shell and a fake
// statusline script that echoes what it got (never the developer's own ~/.claude).
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlatform } from "../src/platform/index.js";
import type { RateLimitWindow, StatusLineEvent } from "../src/protocol.js";
import { cutText, StatusLine, statusEnv, statusLinesOf, statusShell, STATUS_MAX_LINE_CHARS, STATUS_MAX_LINES, type StatusLineDeps } from "../src/statusline/runner.js";
import type { StatusLineSnapshot } from "../src/statusline/input.js";
import type { StatusLineResolution } from "../src/statusline/settings.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

const isWindows = process.platform === "win32";
const platform = createPlatform(process.platform);

/** The fake status line: logs what it got, then answers as `SL_MODE` says. */
const SCRIPT = `
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename } from "node:path";
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const j = JSON.parse(s);
  appendFileSync(process.env.SL_LOG, JSON.stringify({ cwd: process.cwd(), columns: process.env.COLUMNS, projectDir: process.env.CLAUDE_PROJECT_DIR, input: j }) + "\\n");
  const mode = process.env.SL_MODE;
  const echo = () => {
    process.stdout.write("\\x1b[1;35m" + j.model.display_name + "\\x1b[0m | ctx:" + j.context_window.used_percentage + "%\\r\\n");
    process.stdout.write(basename(j.cwd) + " cols=" + process.env.COLUMNS + (process.argv[2] ? " " + process.argv[2] : "") + "\\n\\n");
  };
  if (mode === "fail") { process.stderr.write("boom\\nmore\\n"); process.exit(3); }
  if (mode === "warn") { process.stderr.write((process.env.SL_WARN || "careful") + "\\n"); echo(); return; }
  if (mode === "hang") {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    writeFileSync(process.env.SL_PIDS, String(child.pid));
    setTimeout(() => {}, 60000);
    return;
  }
  if (mode === "slow") { setTimeout(echo, 400); return; }
  if (mode === "straggler") {
    // Left behind in the shell's own process group, holding stdout open.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "ignore"] });
    writeFileSync(process.env.SL_PIDS, String(child.pid));
    child.unref();
    echo();
    return;
  }
  if (mode === "orphan") {
    // A process it leaves behind keeps stdout open: no "close" ever comes for the shell.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "ignore"], detached: true });
    writeFileSync(process.env.SL_PIDS, String(child.pid));
    child.unref();
    echo();
    return;
  }
  echo();
});
`;

type Rig = {
  line: StatusLine;
  events: StatusLineEvent[];
  logs: { level: string; msg: string }[];
  env: Record<string, string>;
  dir: string;
  runs: () => { cwd: string; columns: string; projectDir: string; input: Record<string, unknown> }[];
  set: (o: { enabled?: boolean; snapshot?: boolean; config?: boolean; scope?: string | null; variant?: string | null; rateLimits?: RateLimitWindow[] }) => void;
};

const dirs: string[] = [];
const lines: StatusLine[] = [];
const strays: number[] = [];
afterEach(() => {
  for (const l of lines.splice(0)) l.dispose();
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  for (const d of dirs.splice(0)) removeDir(d);
});

function snapshotFor(dir: string, rateLimits: RateLimitWindow[] = []): Omit<StatusLineSnapshot, "outputStyle"> {
  return {
    sessionId: "sess-1",
    sessionName: null,
    transcriptPath: join(dir, "sess-1.jsonl"),
    cwd: dir,
    projectDir: dir,
    model: { id: "claude-opus-5-5", displayName: "Opus 5.5" },
    version: "2.1.310",
    costUsd: 0,
    durationMs: 0,
    apiDurationMs: 0,
    linesAdded: 0,
    linesRemoved: 0,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 13_990 },
    contextWindowSize: 200_000,
    effort: "high",
    thinkingEnabled: true,
    fastMode: false,
    rateLimits,
    nowMs: Date.now(),
  };
}

type Timing = Partial<Pick<StatusLineDeps, "debounceMs" | "maxWaitMs" | "recheckMs" | "timeoutMs" | "minIntervalMs">> & { refreshIntervalMs?: number };

function rig(timing: Timing = {}): Rig {
  const { refreshIntervalMs = null, ...deps } = timing;
  const dir = makeTempDir("rg-statusline");
  dirs.push(dir);
  const script = join(dir, "line.mjs");
  writeFileSync(script, SCRIPT);
  const fwd = (p: string) => p.replace(/\\/g, "/");
  // Git Bash and PowerShell both take `node "<C:/…>"`; elsewhere /bin/sh runs this very node.
  const command = isWindows ? `node "${fwd(script)}"` : `"${process.execPath}" "${script}"`;
  let enabled = true;
  let hasSnapshot = true;
  let hasConfig = true;
  let scope: string | null = dir;
  let variant: string | null = null;
  let rateLimits: RateLimitWindow[] = [];
  const env: Record<string, string> = { ...(process.env as Record<string, string>), SL_LOG: join(dir, "runs.ndjson"), SL_MODE: "echo", SL_PIDS: join(dir, "pids") };
  const resolution = (): StatusLineResolution => ({
    config: hasConfig ? { command: variant ? `${command} ${variant}` : command, padding: 1, refreshIntervalMs, timeoutMs: null, shell: null, source: "user", path: join(dir, "settings.json") } : null,
    project: null,
    disabled: null,
    outputStyle: "default",
  });
  const events: StatusLineEvent[] = [];
  const logs: { level: string; msg: string }[] = [];
  const line = new StatusLine({
    resolve: resolution,
    snapshot: () => (hasSnapshot ? snapshotFor(dir, rateLimits) : null),
    enabled: () => enabled,
    env: () => env,
    platform,
    scope: () => scope,
    emit: (ev) => events.push(ev),
    log: (level, msg) => logs.push({ level, msg }),
    debounceMs: 20,
    maxWaitMs: 60,
    recheckMs: 60_000,
    timeoutMs: 8000,
    minIntervalMs: 0, // MARK: wave7 w7-state (§45.2): the interval has tests of its own
    ...deps,
  });
  lines.push(line);
  return {
    line,
    events,
    logs,
    env,
    dir,
    runs: () => {
      const f = join(dir, "runs.ndjson");
      return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    set: (o) => {
      if (o.enabled !== undefined) enabled = o.enabled;
      if (o.snapshot !== undefined) hasSnapshot = o.snapshot;
      if (o.config !== undefined) hasConfig = o.config;
      if (o.scope !== undefined) scope = o.scope;
      if (o.variant !== undefined) variant = o.variant;
      if (o.rateLimits !== undefined) rateLimits = o.rateLimits;
    },
  };
}

async function until<T>(get: () => T | undefined | null | false, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("status line runner (§44.2)", () => {
  it("runs the command through the shell with the CLI's stdin, the client's COLUMNS, in the session's folder", async () => {
    const r = rig();
    const reply = r.line.request(80, true);
    expect(reply).toMatchObject({ type: "status_line", lines: [], updatedAt: null, enabled: true, configured: true, source: "user", padding: 1 });
    const ev = await until(() => r.events.find((e) => e.lines.length > 0), "the first lines");
    expect(ev.lines).toEqual(["\x1b[1;35mOpus 5.5\x1b[0m | ctx:7%", `${basename(r.dir)} cols=80`]);
    expect(ev.updatedAt).not.toBeNull();
    expect(ev.error).toBeUndefined();
    const [run] = r.runs();
    expect(basename(run!.cwd)).toBe(basename(r.dir));
    expect(run!.columns).toBe("80");
    expect(run!.projectDir).toBe(r.dir);
    expect(run!.input).toMatchObject({ session_id: "sess-1", cwd: r.dir, model: { id: "claude-opus-5-5", display_name: "Opus 5.5" }, version: "2.1.310", output_style: { name: "default" }, context_window: { used_percentage: 7 } });
  });

  it("many changes in a row run it once; a change during a run runs it once more afterwards", async () => {
    const r = rig();
    r.env.SL_MODE = "slow";
    r.line.request(100, true);
    for (let i = 0; i < 5; i++) r.line.poke();
    await until(() => r.runs().length === 1, "the first run");
    r.line.poke(); // while the slow run is in flight
    r.line.poke();
    await until(() => r.runs().length === 2, "one more run");
    await sleep(700);
    expect(r.runs()).toHaveLength(2);
  });

  it("a failing run keeps the last lines, says why in the event and once in the log", async () => {
    const r = rig();
    r.line.request(100, true);
    const good = await until(() => r.events.find((e) => e.lines.length > 0), "good lines");
    r.env.SL_MODE = "fail";
    r.line.poke();
    const bad = await until(() => r.events.find((e) => e.error), "the failure");
    expect(bad.lines).toEqual(good.lines);
    expect(bad.error).toMatchObject({ code: "exit", exitCode: 3, message: "boom" });
    r.line.poke();
    await until(() => r.runs().length === 3, "the second failure");
    await sleep(100);
    expect(r.logs.filter((l) => l.level === "warn")).toHaveLength(1);
    expect(r.events.filter((e) => e.error)).toHaveLength(1); // the same failure again sends nothing
    r.env.SL_MODE = "echo";
    r.line.poke();
    await until(() => r.events.at(-1)?.error === undefined && r.events.length >= 3, "back to good");
    expect(r.logs.some((l) => l.level === "info" && /runs again/.test(l.msg))).toBe(true);
  });

  it("a run that takes too long is stopped with its whole process tree; the lines stay", async () => {
    const r = rig({ timeoutMs: 5000 }); // also bounds the first (echo) run: shell + node start take ~1 s on a slow Windows runner; hang lasts 60 s
    r.line.request(100, true);
    await until(() => r.events.find((e) => e.lines.length > 0), "good lines");
    r.env.SL_MODE = "hang";
    r.line.poke();
    const timedOut = await until(() => r.events.find((e) => e.error?.code === "timeout"), "the timeout");
    expect(timedOut.lines.length).toBe(2);
    const pid = Number(readFileSync(join(r.dir, "pids"), "utf8"));
    await until(() => !alive(pid), "the grandchild gone", 15_000);
  });

  it("nothing runs while hidden, turned off, without a session or without a command — and the lines go", async () => {
    const r = rig();
    r.line.request(100, false);
    r.line.poke();
    await sleep(300);
    expect(r.runs()).toHaveLength(0);

    r.line.request(100, true);
    await until(() => r.events.find((e) => e.lines.length > 0), "lines once visible");
    r.set({ enabled: false });
    r.line.settingsChanged();
    expect(r.events.at(-1)).toMatchObject({ enabled: false, lines: [], configured: true });
    r.line.poke();
    await sleep(200);
    expect(r.runs()).toHaveLength(1);

    r.set({ enabled: true });
    r.line.settingsChanged();
    await until(() => r.runs().length === 2 && r.events.at(-1)!.lines.length > 0, "running again");
    r.set({ snapshot: false });
    r.line.poke();
    await until(() => r.events.at(-1)!.lines.length === 0, "the lines gone without a session");
    r.set({ snapshot: true, config: false });
    r.line.poke();
    await sleep(200);
    expect(r.events.at(-1)).toMatchObject({ configured: false, lines: [] });
    expect(r.runs()).toHaveLength(2);
  });

  it("with statusLine.refreshInterval it refreshes by itself while visible, never while hidden", async () => {
    const r = rig({ refreshIntervalMs: 150 });
    r.line.request(100, true);
    await until(() => r.runs().length >= 3, "two refreshes", 10_000);
    r.line.request(100, false);
    // A run already started when it was hidden still finishes (a slow runner takes seconds): count once runs() stood still for 2 s.
    let n = -1;
    for (const end = Date.now() + 15_000; n !== r.runs().length && Date.now() < end; ) {
      n = r.runs().length;
      await sleep(2000);
    }
    await sleep(800);
    expect(r.runs().length).toBe(n);
  });

  it("a process the command left behind keeps its pipes open: the run still ends with what it printed", async () => {
    const r = rig();
    r.env.SL_MODE = "orphan";
    r.line.request(100, true);
    const ev = await until(() => r.events.find((e) => e.lines.length > 0), "the lines despite the open pipe", 15_000);
    strays.push(Number(readFileSync(join(r.dir, "pids"), "utf8")));
    expect(ev.lines[0]).toContain("Opus 5.5");
    expect(ev.error).toBeUndefined();
    r.env.SL_MODE = "echo";
    r.line.poke(); // not stuck "running": the next change runs it again
    await until(() => r.runs().length === 2, "another run");
  });

  it("another project: the last one's lines go at once, a run of it is stopped, and one printed for it never lands", async () => {
    const r = rig();
    r.line.request(100, true);
    await until(() => r.events.find((e) => e.lines.length > 0), "lines");
    r.env.SL_MODE = "slow";
    r.line.poke();
    await until(() => r.runs().length === 2, "a slow run in flight");
    r.set({ scope: "/elsewhere" });
    r.line.projectChanged();
    expect(r.events.at(-1)).toMatchObject({ lines: [], updatedAt: null });
    // The snapshot still names the old folder (a chat not yet switched): its output is dropped.
    r.env.SL_MODE = "echo";
    r.line.poke();
    await until(() => r.runs().length === 3, "a run of the old folder");
    await sleep(400);
    expect(r.events.filter((e) => e.lines.length > 0)).toHaveLength(1); // only the first run's, before the switch
    expect(r.events.at(-1)!.lines).toEqual([]);
  });

  it("without statusLine.refreshInterval it runs on changes only (the CLI's)", async () => {
    const r = rig();
    r.line.request(100, true);
    await until(() => r.runs().length === 1, "the first run");
    await sleep(700);
    expect(r.runs()).toHaveLength(1);
    r.line.poke();
    await until(() => r.runs().length === 2, "a run on a change");
  });

  it("once more a second after the earliest usage window resets, then not again for it", async () => {
    const r = rig();
    const resetsAt = new Date(Math.ceil((Date.now() + 400) / 1000) * 1000).toISOString();
    r.set({ rateLimits: [{ kind: "five_hour", status: "allowed", percent: 40, utilization: 0.4, resetsAt, at: new Date().toISOString() }] });
    r.line.request(100, true);
    const [first] = await until(() => (r.runs().length === 1 ? r.runs() : null), "the first run");
    expect(first!.input.rate_limits).toEqual({ five_hour: { used_percentage: 40, resets_at: Date.parse(resetsAt) / 1000 } });
    const [, second] = await until(() => (r.runs().length === 2 ? r.runs() : null), "the run after the reset", 15_000);
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(resetsAt) + 900);
    expect(second!.input).not.toHaveProperty("rate_limits"); // the window reset: no longer in the stdin
    await sleep(1500);
    expect(r.runs()).toHaveLength(2);
  });

  it("another command: what the last one printed goes at once, and a run of it still going never lands", async () => {
    const r = rig();
    r.line.request(100, true);
    await until(() => r.events.find((e) => e.lines.length > 0), "lines");
    r.set({ variant: "b" }); // e.g. a project's own command allowed, or the allowance revoked
    r.line.settingsChanged();
    expect(r.events.at(-1)).toMatchObject({ lines: [], updatedAt: null });
    await until(() => r.events.at(-1)?.lines[1]?.endsWith(" b"), "the new command's lines");
    // A run of "b" in flight when the settings file changes to "c": its output is dropped, "c" runs after it.
    r.env.SL_MODE = "slow";
    r.line.poke();
    await until(() => r.runs().length === 3, "a slow run in flight");
    r.set({ variant: "c" });
    r.line.request(100, true);
    await until(() => r.events.at(-1)?.lines[1]?.endsWith(" c"), "the newest command's lines");
    expect(r.events.filter((e) => e.lines[1]?.endsWith(" b"))).toHaveLength(1);
  });

  it.skipIf(isWindows)("a process left in the shell's group that keeps the pipes open is killed after the grace", async () => {
    const r = rig();
    r.env.SL_MODE = "straggler";
    r.line.request(100, true);
    const ev = await until(() => r.events.find((e) => e.lines.length > 0), "the lines despite the open pipe", 15_000);
    const pid = Number(readFileSync(join(r.dir, "pids"), "utf8"));
    strays.push(pid);
    expect(ev.lines[0]).toContain("Opus 5.5");
    await until(() => !alive(pid), "the straggler gone", 15_000);
  });

  it("nothing configured: a statusLine added to the settings later shows within one re-read", async () => {
    const r = rig({ recheckMs: 200 });
    r.set({ config: false });
    r.line.request(100, true);
    await sleep(350);
    expect(r.runs()).toHaveLength(0);
    r.set({ config: true });
    await until(() => r.events.find((e) => e.lines.length > 0), "the new command's lines", 10_000);
  });

  it("the environment: the terminal's TERM / COLORTERM when the app has none, COLUMNS, the project, one PATH on Windows", () => {
    expect(statusEnv({ PATH: "/usr/bin", X: undefined }, { columns: 90, projectDir: "/p", isWindows: false })).toEqual({
      PATH: "/usr/bin", TERM: "xterm-256color", COLORTERM: "truecolor", COLUMNS: "90", CLAUDE_PROJECT_DIR: "/p",
    });
    expect(statusEnv({ TERM: "screen-256color", COLORTERM: "24bit" }, { columns: 80, projectDir: "/p", isWindows: false })).toMatchObject({ TERM: "screen-256color", COLORTERM: "24bit" });
    expect(statusEnv({ TERM: "dumb" }, { columns: 80, projectDir: "/p", isWindows: false }).TERM).toBe("xterm-256color");
    const win = statusEnv({ Path: "C:\\old", PATH: "C:\\login" }, { columns: 80, projectDir: "C:\\p", pathPrefix: "C:\\Git\\bin", isWindows: true });
    expect(Object.keys(win).filter((k) => k.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(win.PATH).toBe("C:\\Git\\bin;C:\\login");
    expect(statusEnv({ Path: "C:\\only" }, { columns: 80, projectDir: "C:\\p", isWindows: true }).PATH).toBe("C:\\only");
  });

  it("cuts never split a surrogate pair (a lone half breaks the Mac's JSON decoding)", () => {
    expect(cutText("ab😀", 3)).toBe("ab");
    expect(cutText("ab😀", 4)).toBe("ab😀");
    expect(cutText("abc", 5)).toBe("abc");
    expect(statusLinesOf("x".repeat(STATUS_MAX_LINE_CHARS - 1) + "😀")[0]).toHaveLength(STATUS_MAX_LINE_CHARS - 1);
  });

  it("takes stdout as the CLI does: CRLF, trimmed, at most 20 lines of 2000 characters", () => {
    expect(statusLinesOf("  a\r\nb  \r\n\r\n")).toEqual(["a", "b"]);
    expect(statusLinesOf("\n\n")).toEqual([]);
    expect(statusLinesOf(Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n"))).toHaveLength(STATUS_MAX_LINES);
    expect(statusLinesOf("x".repeat(5000))[0]).toHaveLength(STATUS_MAX_LINE_CHARS);
  });

  // MARK: wave7 w7-state — §45.2: a status line that keeps up without a process per change.
  it("changes run it at most once per interval: none sooner, and the last change still runs once afterwards", async () => {
    const r = rig({ minIntervalMs: 5000 }); // wide: the "not yet" check below must stay inside it on a slow runner
    r.line.request(100, true); // the first show runs after the debounce alone
    await until(() => r.runs().length === 1, "the first run");
    for (let i = 0; i < 5; i++) {
      r.line.poke();
      await sleep(40);
    }
    await sleep(300);
    expect(r.runs()).toHaveLength(1); // still inside the interval
    await until(() => r.runs().length === 2, "the trailing run", 15_000);
    await sleep(2000);
    expect(r.runs()).toHaveLength(2); // five changes, one run for them
  });

  it("a new width runs soon; the window shown again waits for the interval", async () => {
    const r = rig({ minIntervalMs: 60_000 }); // runs at once vs waits for the interval: only the 60 s one is a wait
    r.line.request(100, true);
    await until(() => r.runs().length === 1, "the first run");
    r.line.request(120, true);
    await until(() => r.runs().length === 2, "the run for the new width", 15_000);
    expect(r.runs()[1]!.columns).toBe("120");
    r.line.request(120, false);
    r.line.request(120, true); // un-occluded: the lines are at most one interval old
    await sleep(600);
    expect(r.runs()).toHaveLength(2);
    r.set({ variant: "b" });
    r.line.settingsChanged(); // a switch the user changed runs soon
    await until(() => r.runs().length === 3, "the run after the switch", 15_000);
  });

  it("a new width still runs soon when a turn's changes follow it inside the debounce, and they run with it", async () => {
    const r = rig({ minIntervalMs: 60_000, debounceMs: 150, maxWaitMs: 2000 });
    r.line.request(100, true);
    await until(() => r.runs().length === 1, "the first run");
    r.line.request(140, true);
    for (let i = 0; i < 3; i++) {
      await sleep(30);
      r.line.poke(); // tool calls of the running turn
    }
    await until(() => r.runs().length === 2, "the run for the new width", 15_000);
    expect(r.runs()[1]!.columns).toBe("140");
    await sleep(500);
    expect(r.runs()).toHaveLength(2);
  });

  it("a new width during a run runs right after it, not after the interval", async () => {
    const r = rig({ minIntervalMs: 60_000 });
    r.env.SL_MODE = "slow";
    r.line.request(100, true);
    await until(() => r.runs().length === 1, "the first run in flight"); // logged before its 400 ms wait
    r.line.request(140, true);
    await until(() => r.runs().length === 2, "the run for the new width", 15_000);
    expect(r.runs()[1]!.columns).toBe("140");
    await sleep(300);
    expect(r.runs()).toHaveLength(2);
  });

  it("the same stderr is logged once, not after every run; another text is logged again", async () => {
    const r = rig();
    r.env.SL_MODE = "warn";
    r.line.request(100, true);
    await until(() => r.runs().length === 1, "the first run");
    for (let n = 2; n <= 3; n++) {
      r.line.poke();
      await until(() => r.runs().length === n, `run ${n}`);
    }
    await sleep(100);
    const said = () => r.logs.filter((l) => l.msg.startsWith("status line stderr:")).map((l) => l.msg);
    expect(said()).toEqual(["status line stderr: careful"]);
    r.env.SL_WARN = "something else";
    r.line.poke();
    await until(() => said().length === 2, "the new text logged");
    expect(said()[1]).toBe("status line stderr: something else");
    expect(r.events.at(-1)!.lines.length).toBe(2); // the lines still show
  });

  it("the shell: /bin/sh -c; PowerShell when the setting says so or Windows has no Git Bash", async () => {
    const which = async (name: string) => (name === "pwsh" ? "/usr/local/bin/pwsh" : null);
    expect(await statusShell({ command: "echo hi", shell: null }, {}, { isWindows: false, which })).toEqual({ file: "/bin/sh", args: ["-c", "echo hi"] });
    expect(await statusShell({ command: "Write-Host hi", shell: "powershell" }, {}, { isWindows: false, which })).toEqual({ file: "/usr/local/bin/pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", "Write-Host hi"] });
    expect(await statusShell({ command: "x", shell: "powershell" }, {}, { isWindows: false, which: async () => null })).toBeNull();
  });
});
