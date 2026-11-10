import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookCallback, HookInput, Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { GIT_INTERNAL_REASON, READ_ONLY_BASH_REASON } from "../src/session/hooks.js";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import {
  claudeMdStatus,
  discoverHooks,
  extensionQueryOptions,
  pluginIdFromPath,
  pluginList,
  resolveDisabledPlugins,
} from "../src/session/extensions.js";
import { FakeClaudeSession, makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("extension query options (§16)", () => {
  it("settingSources / skills follow loadUserSettings; disables ride on the flag settings", () => {
    expect(extensionQueryOptions({ loadUserSettings: true })).toEqual({ settingSources: ["user", "project"], skills: "all" });
    expect(extensionQueryOptions({ loadUserSettings: false })).toEqual({ settingSources: ["project"] });
    expect(extensionQueryOptions({ loadUserSettings: true, disabledPlugins: ["omc@omc", "bare"], disableUserHooks: true })).toEqual({
      settingSources: ["user", "project"],
      skills: "all",
      settings: { enabledPlugins: { "omc@omc": false }, disableAllHooks: true },
    });
  });

  it("plugin ids from install paths; bare names resolve through known plugins", () => {
    expect(pluginIdFromPath("writer-kit", "/Users/u/.claude/plugins/cache/writer-kit-marketplace/writer-kit/1.0.0")).toBe("writer-kit@writer-kit-marketplace");
    expect(pluginIdFromPath("x", "C:\\Users\\u\\.claude\\plugins\\cache\\mk\\x\\1.0")).toBe("x@mk");
    expect(pluginIdFromPath("agents-md", "builtin")).toBe("agents-md@builtin");
    expect(pluginIdFromPath("dev", "/work/my-plugin")).toBeNull();
    expect(pluginIdFromPath("dev", null)).toBeNull();
    expect(resolveDisabledPlugins(["a@m", " b ", "zzz", "", "a@m"], [{ name: "b", id: "b@mk" }, { name: "zzz", id: null }])).toEqual({ ids: ["a@m", "b@mk"], unresolved: ["zzz"] });
  });

  it("pluginList keeps the loaded ones and lists configured-disabled ones as enabled:false", () => {
    const list = pluginList(
      [{ name: "a", path: "/h/.claude/plugins/cache/m/a/1", version: "1" }],
      ["b@m", "a@m"],
      [{ name: "b", id: "b@m", path: "/h/.claude/plugins/cache/m/b/2", enabled: true }],
    );
    expect(list).toEqual([
      { name: "a", id: "a@m", path: "/h/.claude/plugins/cache/m/a/1", version: "1", enabled: true },
      { name: "b", id: "b@m", path: "/h/.claude/plugins/cache/m/b/2", enabled: false },
    ]);
  });

  it("hook sources from user / project settings and plugin hooks.json; CLAUDE.md status", () => {
    const config = tmp("rg-ext-config");
    const cwd = tmp("rg-ext-cwd");
    const plugin = tmp("rg-ext-plugin");
    writeFileSync(join(config, "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [], PreToolUse: [] } }));
    write(cwd, ".claude/settings.json", JSON.stringify({ permissions: {} }));
    write(plugin, "hooks/hooks.json", JSON.stringify({ hooks: { SessionStart: [] } }));
    const hooks = discoverHooks({ configDir: config, cwd, loadUser: true, plugins: [{ name: "p", path: plugin }, { name: "builtin-x", path: "builtin" }], disabled: false });
    expect(hooks).toEqual([
      { source: "user", path: join(config, "settings.json"), events: ["PreToolUse", "UserPromptSubmit"], active: true },
      { source: "plugin", plugin: "p", path: join(plugin, "hooks", "hooks.json"), events: ["SessionStart"], active: true },
    ]);
    expect(discoverHooks({ configDir: config, cwd, loadUser: false, plugins: [], disabled: true })).toEqual([]);
    expect(discoverHooks({ configDir: config, cwd, loadUser: true, plugins: [], disabled: true })[0]!.active).toBe(false);

    expect(claudeMdStatus({ configDir: config, cwd, memoryFiles: null })).toEqual({ user: false, project: false, source: "files" });
    writeFileSync(join(config, "CLAUDE.md"), "x");
    write(cwd, "CLAUDE.md", "y");
    expect(claudeMdStatus({ configDir: config, cwd, memoryFiles: null })).toEqual({ user: true, project: true, source: "files" });
    expect(claudeMdStatus({ configDir: config, cwd, memoryFiles: [{ path: join(config, "CLAUDE.md"), type: "User" }] })).toEqual({ user: true, project: false, source: "cli" });
    expect(claudeMdStatus({ configDir: config, cwd, memoryFiles: [{ path: join(cwd, "sub", "CLAUDE.md"), type: "Project" }] })).toEqual({ user: false, project: true, source: "cli" });
  });
});

// ------------------------------------------------------------------ ClaudeSession with a faked SDK

type FakeQueryControl = { options: Options | undefined; resolveInit: () => void; rejectInit: (e: Error) => void };

function fakeSdk(probe: { memoryFiles?: { path: string; type: string; tokens: number }[]; mcp?: { name: string; status: string }[] } = {}): { queryFn: (args: { options?: Options }) => Query; control: FakeQueryControl } {
  const control: FakeQueryControl = { options: undefined, resolveInit: () => {}, rejectInit: () => {} };
  const queryFn = (args: { options?: Options }): Query => {
    control.options = args.options;
    let done: () => void = () => {};
    const ended = new Promise<void>((r) => (done = r));
    const init = new Promise<unknown>((resolve, reject) => {
      control.resolveInit = () => resolve({});
      control.rejectInit = reject;
    });
    init.catch(() => undefined);
    const q = {
      async next() {
        await ended;
        return { done: true, value: undefined };
      },
      async return() {
        done();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      initializationResult: () => init,
      getContextUsage: async () => ({ memoryFiles: probe.memoryFiles ?? [] }),
      mcpServerStatus: async () => probe.mcp ?? [],
    };
    return q as unknown as Query;
  };
  return { queryFn, control };
}

function session(settings: Partial<ConstructorParameters<typeof ClaudeSession>[0]["settings"]>, sdk: ReturnType<typeof fakeSdk>, events: SessionEvent[]): ClaudeSession {
  return new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: true, systemPromptAppend: "", ...settings },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    queryFn: sdk.queryFn as never,
  });
}

const until = async (pred: () => boolean, what: string, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("ClaudeSession extension options + init watchdog (faked SDK)", () => {
  it("passes settingSources / skills / flag settings to query()", async () => {
    const sdk = fakeSdk();
    const s = session({ disabledPlugins: ["omc@omc"], disableUserHooks: true }, sdk, []);
    await s.start();
    expect(sdk.control.options).toMatchObject({
      settingSources: ["user", "project"],
      skills: "all",
      settings: { enabledPlugins: { "omc@omc": false }, disableAllHooks: true },
    });
    await s.dispose();
    const plain = fakeSdk();
    const p = session({ loadUserSettings: false }, plain, []);
    await p.start();
    expect(plain.control.options?.settingSources).toEqual(["project"]);
    expect(plain.control.options).not.toHaveProperty("settings");
    expect(plain.control.options).not.toHaveProperty("skills");
    await p.dispose();
  });

  it("disableUserHooks only adds the flag disableAllHooks: ReviewGate's own SDK hooks are wired and decide exactly as without it", async () => {
    const root = tmp("rg-ext-hooks");
    sh(root, "init", "-q");
    const wired = async (disableUserHooks: boolean) => {
      const sdk = fakeSdk();
      const s = new ClaudeSession({
        cwd: root,
        settings: { budget: { maxFiles: 1, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: true, systemPromptAppend: "", disableUserHooks },
        claudePath: "/nonexistent/claude",
        env: {},
        platform: { killTree: async () => undefined, isWindows: false },
        emit: () => {},
        log: () => {},
        queryFn: sdk.queryFn as never,
      });
      await s.start();
      s.sendUser("go", undefined);
      const hooks = sdk.control.options!.hooks!;
      const shape = Object.fromEntries(Object.entries(hooks).map(([ev, ms]) => [ev, ms!.map((m) => [m.matcher ?? "*", m.hooks.length])]));
      const pre = async (toolName: string, input: Record<string, unknown>) => {
        let out: { decision?: string; reason?: string } = {};
        for (const m of hooks.PreToolUse!) {
          if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
          for (const h of m.hooks) {
            const r = (await (h as HookCallback)({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: input, session_id: "s", transcript_path: "", cwd: root, tool_use_id: "t" } as unknown as HookInput, "t", { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
            const d = { decision: r.hookSpecificOutput?.permissionDecision, reason: r.hookSpecificOutput?.permissionDecisionReason };
            if (d.decision === "deny") return d;
            if (d.decision) out = d;
          }
        }
        return out;
      };
      const decisions = {
        gitStatus: await pre("Bash", { command: "git status" }),
        gitHead: await pre("Write", { file_path: join(root, ".git", "HEAD"), content: "x" }),
        first: await pre("Write", { file_path: join(root, "a.txt"), content: "a\n" }),
        overBudget: await pre("Write", { file_path: join(root, "b.txt"), content: "b\n" }),
      };
      await s.dispose();
      return { settings: sdk.control.options!.settings, shape, decisions };
    };
    const on = await wired(true);
    const off = await wired(false);
    expect(on.settings).toEqual({ disableAllHooks: true });
    expect(off.settings).toBeUndefined();
    expect(on.shape).toEqual(off.shape);
    expect(Object.keys(on.shape)).toEqual(expect.arrayContaining(["PreToolUse", "PostToolUse"]));
    expect(on.decisions).toEqual(off.decisions);
    expect(on.decisions.gitStatus).toEqual({ decision: "allow", reason: READ_ONLY_BASH_REASON });
    expect(on.decisions.gitHead).toEqual({ decision: "deny", reason: GIT_INTERNAL_REASON });
    expect(on.decisions.first.decision).not.toBe("deny");
    expect(on.decisions.overBudget.decision).toBe("deny");
  });

  it("§52: background tasks on by default (Agent calls are kept in the turn by the hook); backgroundWork false turns them off; the environment wins", async () => {
    const prev = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
    delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
    try {
      const sdk = fakeSdk();
      const s = session({}, sdk, []);
      await s.start();
      expect(sdk.control.options?.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeUndefined();
      expect(s.backgroundWorkOn).toBe(true);
      await s.dispose();
      // Off (the setting): as before §52 — CLI 2.1.303 backgrounds every Agent call otherwise.
      const off = fakeSdk();
      const o0 = session({ backgroundWork: false }, off, []);
      await o0.start();
      expect(off.control.options?.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
      expect(o0.backgroundWorkOn).toBe(false);
      await o0.dispose();
      // An explicit value in the environment wins (developer override).
      process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "0";
      const other = fakeSdk();
      const o = session({ backgroundWork: false }, other, []);
      await o.start();
      expect(other.control.options?.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("0");
      expect(o.backgroundWorkOn).toBe(true);
      await o.dispose();
      process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
      const forced = fakeSdk();
      const f = session({}, forced, []);
      await f.start();
      expect(f.backgroundWorkOn).toBe(false);
      await f.dispose();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
      else process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = prev;
    }
  });

  it("init_timeout when the CLI does not initialize in time (user settings loaded only)", async () => {
    const events: SessionEvent[] = [];
    const sdk = fakeSdk();
    const s = session({ initTimeoutMs: 30 }, sdk, events);
    await s.start();
    await until(() => events.some((e) => e.type === "init_timeout"), "init_timeout");
    expect(events.find((e) => e.type === "init_timeout")).toEqual({ type: "init_timeout", afterMs: 30 });
    await s.dispose();

    const quiet: SessionEvent[] = [];
    const p = session({ initTimeoutMs: 30, loadUserSettings: false }, fakeSdk(), quiet);
    await p.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(quiet.filter((e) => e.type === "init_timeout")).toEqual([]);
    await p.dispose();
  });

  it("no init_timeout once initialized; extensions_info carries memory files and MCP status", async () => {
    const events: SessionEvent[] = [];
    const sdk = fakeSdk({ memoryFiles: [{ path: "/h/.claude/CLAUDE.md", type: "User", tokens: 12 }], mcp: [{ name: "fs", status: "connected" }] });
    const s = session({ initTimeoutMs: 60 }, sdk, events);
    await s.start();
    sdk.control.resolveInit();
    await until(() => events.some((e) => e.type === "extensions_info"), "extensions_info");
    expect(events.find((e) => e.type === "extensions_info")).toEqual({
      type: "extensions_info",
      memoryFiles: [{ path: "/h/.claude/CLAUDE.md", type: "User", tokens: 12 }],
      mcpServers: [{ name: "fs", status: "connected" }],
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(events.filter((e) => e.type === "init_timeout")).toEqual([]);
    await s.dispose();
  });
});

// ------------------------------------------------------------------ engine: fallback + state.session.extensions

function makeRepo(): string {
  const dir = tmp("rg-ext-repo");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "r\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

describe("engine: extensions (§16)", () => {
  it("init_timeout → banner + extensions_fallback, the session restarts without user settings and resumes", async () => {
    const config = tmp("rg-ext-home");
    mkdirSync(config, { recursive: true });
    const dir = makeRepo();
    const h = makeHarness({ env: { CLAUDE_CONFIG_DIR: config } });
    harnesses.push(h);
    await h.hello({ loadUserSettings: true, extensionsInitTimeoutMs: 5000 });
    await h.open(dir);
    const first = h.session();
    // §36.7: the setting is the floor of a stall limit; without start history the adaptive limit is 45 s.
    expect(first.opts.settings).toMatchObject({ loadUserSettings: true, initTimeoutMs: 45_000, disabledPlugins: [], disableUserHooks: false });
    // §36.6: local settings load by default too.
    expect(h.engine.state.session.extensions).toMatchObject({ settingSources: ["user", "project", "local"], fallback: null, userHooksDisabled: false });
    // A conversation exists: the fallback restart must resume it.
    await h.engine.handle({ type: "send", text: "hi" });
    first.emitSessionInfo();
    first.emitTurnEnd();
    await h.waitFor((s) => s.gate.phase === "idle" && s.session.sessionId === "sess-1", "turn done");

    first.emit({ type: "init_timeout", afterMs: 5000 });
    await h.waitFor((s) => h.sessions.length === 2 && s.session.open && !s.session.starting, "restarted");
    const second = h.session();
    expect(first.disposed).toBe(true);
    expect(second.opts.settings.loadUserSettings).toBe(false);
    expect(second.opts.settings.resumeSessionId).toBe("sess-1");
    const errs = h.ofType("error");
    expect(errs.at(-1)).toMatchObject({ fatal: false, scope: "session" });
    expect(errs.at(-1)!.message).toContain("did not start within 5 s");
    expect(h.ofType("extensions_fallback")).toEqual([{ type: "extensions_fallback", reason: "init_timeout", timeoutMs: 5000, message: errs.at(-1)!.message }]);
    const ext = h.engine.state.session.extensions!;
    expect(ext.settingSources).toEqual(["project"]);
    expect(ext.fallback).toMatchObject({ reason: "init_timeout", timeoutMs: 5000 });
    // A second timeout of the fallback session does nothing more; restart_session keeps the fallback.
    second.emit({ type: "init_timeout", afterMs: 5000 });
    await h.settle();
    expect(h.ofType("extensions_fallback")).toHaveLength(1);
    await h.engine.request({ type: "restart_session" });
    expect(h.session().opts.settings.loadUserSettings).toBe(false);
    // Reopening the project tries the user settings again.
    await h.open(dir);
    expect(h.session().opts.settings.loadUserSettings).toBe(true);
    expect(h.engine.state.session.extensions!.fallback).toBeNull();
  });

  it("an init timeout while open_project starts the session never shows the hung session as usable: the fallback restart begins before the next snapshot", async () => {
    // driver-m21 e1 (extensionsInitTimeoutMs: 1): the restart is queued behind open_project; nothing open_project awaits
    // after the session start (§31's other-Claude check runs before it) may let a snapshot "fallback + open + user settings" out.
    const config = tmp("rg-ext-home-race");
    mkdirSync(config, { recursive: true });
    const dir = makeRepo();
    let created = 0;
    const h: Harness = makeHarness({
      env: { CLAUDE_CONFIG_DIR: config },
      sessionFactory: (o) => {
        const s = new FakeClaudeSession(o);
        if (created++ === 0) {
          const start = s.start.bind(s);
          s.start = async () => {
            await start();
            s.emit({ type: "init_timeout", afterMs: 1 });
          };
        }
        h.sessions.push(s);
        return s;
      },
    });
    harnesses.push(h);
    await h.hello({ loadUserSettings: true, extensionsInitTimeoutMs: 1 });
    await h.engine.handle({ type: "open_project", path: dir });
    // Read no state before the restart queued behind open_project had its turn (`engine.state` flushes a pending snapshot).
    await h.settle();
    const s = await h.waitFor((x) => h.sessions.length === 2 && x.session.open && !x.session.starting && x.session.extensions?.fallback != null, "fallback session up");
    expect(s.session.extensions!.settingSources).toEqual(["project"]);
    expect(h.sessions[1]!.opts.settings.loadUserSettings).toBe(false);
    const usableWithUserSettings = h.states.filter((x) => x.session.extensions?.fallback != null && x.session.open && !x.session.starting && x.session.extensions.settingSources.includes("user"));
    expect(usableWithUserSettings).toEqual([]);
  });

  it("a message sent before init is re-sent once to the fallback session (same turn, same snapshot A); not when the CLI already answered", async () => {
    const config = tmp("rg-ext-home-resend");
    mkdirSync(config, { recursive: true });
    const dir = makeRepo();
    const h = makeHarness({ env: { CLAUDE_CONFIG_DIR: config } });
    harnesses.push(h);
    await h.hello({ loadUserSettings: true, extensionsInitTimeoutMs: 5000 });
    await h.open(dir);
    const first = h.session();
    await h.engine.handle({ type: "send", text: "edit the readme" });
    expect(first.sends).toHaveLength(1);
    const sent = first.sends[0]!;
    // The CLI hangs in its initialize handshake: nothing came back for the message.
    first.emit({ type: "init_timeout", afterMs: 5000 });
    await h.waitFor((s) => h.sessions.length === 2 && s.session.open && !s.session.starting, "restarted");
    const second = h.session();
    expect(second.opts.settings.loadUserSettings).toBe(false);
    expect(second.sends).toEqual([sent]);
    expect(h.engine.state.gate.phase).toBe("running");
    expect(h.ofType("user_message")).toHaveLength(1);
    expect(h.ofType("turn_end")).toEqual([]);
    const fb = h.ofType("extensions_fallback");
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ resent: true });
    expect(fb[0]!.message).toContain("Your message was sent again.");
    // The resent turn runs and is collected as usual.
    write(dir, "README.md", "changed\n");
    second.emitSessionInfo();
    second.emitTurnEnd();
    await h.waitFor((s) => s.gate.phase === "reviewing" && s.changedFiles.length === 1, "collected");
    expect(h.engine.state.hud.turnCount).toBe(1);
    expect(h.sessions).toHaveLength(2);

    // A CLI that already produced output for the turn took the message: the turn is closed, nothing is resent.
    const h2 = makeHarness({ env: { CLAUDE_CONFIG_DIR: config } });
    harnesses.push(h2);
    await h2.hello({ loadUserSettings: true, extensionsInitTimeoutMs: 5000 });
    const dir2 = makeRepo();
    await h2.open(dir2);
    const a = h2.session();
    await h2.engine.handle({ type: "send", text: "hello" });
    a.emit({ type: "text_delta", text: "Working…" });
    a.emit({ type: "init_timeout", afterMs: 5000 });
    await h2.waitFor((s) => h2.sessions.length === 2 && s.session.open && !s.session.starting && s.gate.phase !== "running" && s.gate.phase !== "collecting", "restarted, turn closed");
    expect(h2.session().sends).toEqual([]);
    expect(h2.ofType("extensions_fallback")[0]).not.toHaveProperty("resent");
  });

  it("disabledPlugins (ids and bare names via the capabilities cache), disableUserHooks and the reported extensions", async () => {
    const config = tmp("rg-ext-home2");
    writeFileSync(join(config, "settings.json"), JSON.stringify({ hooks: { Stop: [] } }));
    writeFileSync(join(config, "CLAUDE.md"), "me");
    const dir = makeRepo();
    const h = makeHarness({ env: { CLAUDE_CONFIG_DIR: config } });
    harnesses.push(h);
    await h.hello({ loadUserSettings: true });
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "hi" });
    h.session().emitSessionInfo({
      plugins: [
        { name: "omc", path: join(config, "plugins", "cache", "omc", "omc", "5.0"), version: "5.0" },
        { name: "writer", path: join(config, "plugins", "cache", "writer-plugins", "writer", "1.0") },
      ],
    });
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase === "idle" && s.session.capabilities?.pluginDetails !== undefined, "session info");
    expect(h.engine.state.session.capabilities!.plugins).toEqual(["omc", "writer"]);
    expect(h.engine.state.session.capabilities!.pluginDetails!.map((p) => p.id)).toEqual(["omc@omc", "writer@writer-plugins"]);
    let ext = h.engine.state.session.extensions!;
    expect(ext.plugins.map((p) => [p.id, p.enabled])).toEqual([["omc@omc", true], ["writer@writer-plugins", true]]);
    expect(ext.hooks).toEqual([{ source: "user", path: join(config, "settings.json"), events: ["Stop"], active: true }]);
    expect(ext.claudeMd).toEqual({ user: true, project: false, source: "files" });
    h.session().emit({ type: "extensions_info", memoryFiles: [{ path: join(dir, "CLAUDE.md"), type: "Project" }], mcpServers: [{ name: "fs", status: "failed" }] });
    await h.settle();
    ext = h.engine.state.session.extensions!;
    // MARK: wave4d w4d-config — §42.3: each memory file says what it is (and the project's own one can be saved in the app).
    expect(ext.memoryFiles).toEqual([{ path: join(dir, "CLAUDE.md"), type: "Project", kind: "project", editable: true }]);
    expect(ext.claudeMd).toEqual({ user: false, project: true, source: "cli" });
    expect(ext.mcpServers).toEqual([{ name: "fs", status: "failed" }]);

    await h.engine.handle({ type: "set_settings", settings: { disabledPlugins: ["writer", "x@y", "unknown"], disableUserHooks: true } });
    await h.engine.request({ type: "restart_session" });
    const opts = h.session().opts.settings;
    expect(opts.disabledPlugins).toEqual(["writer@writer-plugins", "x@y"]);
    expect(opts.disableUserHooks).toBe(true);
    ext = h.engine.state.session.extensions!;
    expect(ext.disabledPlugins).toEqual(["writer@writer-plugins", "x@y"]);
    expect(ext.unresolvedDisabledPlugins).toEqual(["unknown"]);
    expect(ext.userHooksDisabled).toBe(true);
    expect(ext.hooks.every((x) => !x.active)).toBe(true);
    expect(ext.plugins.find((p) => p.id === "writer@writer-plugins")).toMatchObject({ enabled: false });
    expect(ext.plugins.find((p) => p.id === "x@y")).toMatchObject({ name: "x", enabled: false, path: null });
  });
});
