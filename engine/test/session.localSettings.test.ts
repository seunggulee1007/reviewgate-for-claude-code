import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanUseTool, HookCallback, HookInput, Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { extensionQueryOptions } from "../src/session/extensions.js";
import { localHookSources, notAppliedLocalSettings } from "../src/session/localSettings.js";
import { classifyRules, loadPermissionRules, sessionUserRules } from "../src/session/permissionRules.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §36.6 (audit SME-01): `.claude/settings.local.json` and the local-scope MCP servers load in app sessions
 * (`settingSources` + "local", per project, default on) — or `extensions.notApplied` says what was left out. Loading them
 * never skips a permission card nor the review of an edit or a command.
 */

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const LOCAL = {
  env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", SECRET_TOKEN: "do-not-leak-this-value" },
  permissions: { allow: ["Bash", "Bash(rm:*)", "Bash(npm install:*)", "Edit", "Write", "SendMessage", "mcp__github__delete_file", "WebSearch"], deny: [] },
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "~/.claude/on-stop.sh" }] }],
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `echo ${"x".repeat(300)}` }, { type: "prompt", prompt: "not a command" }] }],
  },
  enabledMcpjsonServers: ["serena"],
};

describe("settingSources (§36.6)", () => {
  it("local settings add `local`, with or without user settings; the §16 fallback is project only", () => {
    expect(extensionQueryOptions({ loadUserSettings: true, loadLocalSettings: true }).settingSources).toEqual(["user", "project", "local"]);
    expect(extensionQueryOptions({ loadUserSettings: false, loadLocalSettings: true }).settingSources).toEqual(["project", "local"]);
    expect(extensionQueryOptions({ loadUserSettings: true, loadLocalSettings: false }).settingSources).toEqual(["user", "project"]);
    // An engine that does not say (older callers): no local.
    expect(extensionQueryOptions({ loadUserSettings: true }).settingSources).toEqual(["user", "project"]);
  });
});

describe("notApplied (§36.6)", () => {
  it("names, commands (≤ 200 chars) and counts of settings.local.json plus the local-scope MCP servers — never a value", () => {
    const root = tmp("rg-local-root");
    const config = tmp("rg-local-config");
    write(root, ".claude/settings.local.json", JSON.stringify(LOCAL));
    write(config, ".claude.json", JSON.stringify({ projects: { [root]: { mcpServers: { serena: { command: "uvx", env: { K: "v" } }, notes: { command: "node" } } }, "/other": { mcpServers: { nope: {} } } } }));
    const na = notAppliedLocalSettings({ root, projectPath: root, env: { CLAUDE_CONFIG_DIR: config } });
    expect(na).toEqual({
      hooks: [
        { event: "SessionStart", command: `echo ${"x".repeat(194)}…` },
        { event: "Stop", command: "~/.claude/on-stop.sh" },
      ],
      envKeys: ["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "SECRET_TOKEN"],
      mcpServers: ["notes", "serena"],
      allowRuleCount: 8,
    });
    expect(JSON.stringify(na)).not.toContain("do-not-leak-this-value");
    expect(JSON.stringify(na)).not.toContain("uvx");
  });

  it("null when the local settings hold none of these; a broken file or a missing ~/.claude.json is not fatal", () => {
    const root = tmp("rg-local-empty");
    const config = tmp("rg-local-config2");
    expect(notAppliedLocalSettings({ root, projectPath: root, env: { CLAUDE_CONFIG_DIR: config } })).toBeNull();
    write(root, ".claude/settings.local.json", JSON.stringify({ permissions: { allow: [] }, env: {} }));
    expect(notAppliedLocalSettings({ root, projectPath: root, env: { CLAUDE_CONFIG_DIR: config } })).toBeNull();
    write(root, ".claude/settings.local.json", "{broken");
    write(config, ".claude.json", "{broken too");
    expect(notAppliedLocalSettings({ root, projectPath: root, env: { CLAUDE_CONFIG_DIR: config } })).toBeNull();
  });

  it("applied local hooks are listed as a project hook source (the settings.local.json path)", () => {
    const root = tmp("rg-local-hooks");
    expect(localHookSources(root, false)).toEqual([]);
    write(root, ".claude/settings.local.json", JSON.stringify(LOCAL));
    expect(localHookSources(root, false)).toEqual([{ source: "project", path: join(root, ".claude", "settings.local.json"), events: ["SessionStart", "Stop"], active: true }]);
    expect(localHookSources(root, true)[0]!.active).toBe(false);
  });
});

describe("local allow rules (§36.6 + §33.5)", () => {
  it("apply only while local settings load; otherwise they are listed as local_settings_off", () => {
    const root = tmp("rg-local-rules");
    const config = tmp("rg-local-rules-config");
    write(root, ".claude/settings.local.json", JSON.stringify({ permissions: { allow: ["WebSearch"], ask: ["WebFetch"] } }));
    const on = loadPermissionRules({ configDir: config, root, loadUser: true });
    expect(sessionUserRules(on, true)).toEqual({ allow: ["WebSearch"], block: ["WebFetch"] });
    const off = loadPermissionRules({ configDir: config, root, loadUser: true, loadLocal: false });
    expect(sessionUserRules(off, true)).toEqual({ allow: [], block: [] });
    expect(classifyRules(off, { applyUserRules: true })).toEqual([{ rule: "WebSearch", source: "local", status: "ignored", why: "local_settings_off", importAs: "WebSearch" }]);
  });
});

// ------------------------------------------------------------------ the gate stays: PreToolUse path with local settings loaded

type Wired = { options: Options; pre: (tool: string, input: Record<string, unknown>) => Promise<string | undefined>; canUse: CanUseTool; events: SessionEvent[]; dispose: () => Promise<void> };

async function wire(root: string, loadLocalSettings: boolean, opts: { env?: Record<string, string>; loadUserSettings?: boolean } = {}): Promise<Wired> {
  let options: Options | undefined;
  const events: SessionEvent[] = [];
  const queryFn = (args: { options?: Options }): Query => {
    options = args.options;
    let done: () => void = () => {};
    const ended = new Promise<void>((r) => (done = r));
    return {
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
      initializationResult: () => new Promise(() => {}),
    } as unknown as Query;
  };
  const rules = loadPermissionRules({ configDir: "/nonexistent/rg-config", root, loadUser: true, loadLocal: loadLocalSettings });
  const s = new ClaudeSession({
    cwd: root,
    settings: {
      budget: { maxFiles: 10, maxLines: 400 },
      ignorePatterns: [],
      autoAllowTools: [],
      loadUserSettings: opts.loadUserSettings ?? true,
      loadLocalSettings,
      systemPromptAppend: "",
      userRules: sessionUserRules(rules, true),
    },
    claudePath: "/nonexistent/claude",
    env: opts.env ?? {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    queryFn: queryFn as never,
  });
  await s.start();
  s.sendUser("go", undefined);
  const hooks = options!.hooks!;
  const pre = async (toolName: string, input: Record<string, unknown>): Promise<string | undefined> => {
    let decision: string | undefined;
    for (const m of hooks.PreToolUse!) {
      if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
      for (const h of m.hooks) {
        const r = (await (h as HookCallback)({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: input, session_id: "s", transcript_path: "", cwd: root, tool_use_id: "t" } as unknown as HookInput, "t", { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
        const d = r.hookSpecificOutput?.permissionDecision;
        if (d === "deny") return d;
        if (d === "ask" || (d && decision !== "ask")) decision = d;
      }
    }
    return decision;
  };
  return { options: options!, pre, canUse: options!.canUseTool!, events, dispose: () => s.dispose() };
}

describe("Claude in Chrome (§36.6)", () => {
  it("--chrome when Claude Code's own \"Enabled by default\" is on, as in the terminal; not when it is off, nor without user settings", async () => {
    const root = tmp("rg-chrome-root");
    sh(root, "init", "-q");
    const config = tmp("rg-chrome-config");
    const env = { CLAUDE_CONFIG_DIR: config };
    write(config, ".claude.json", JSON.stringify({ claudeInChromeDefaultEnabled: true }));
    const on = await wire(root, false, { env });
    const bare = await wire(root, false, { env, loadUserSettings: false });
    write(config, ".claude.json", JSON.stringify({ claudeInChromeDefaultEnabled: false, projects: {} }));
    const off = await wire(root, false, { env });
    try {
      expect(on.options.extraArgs).toEqual({ chrome: null });
      expect(bare.options.extraArgs ?? {}).toEqual({});
      expect(off.options.extraArgs ?? {}).toEqual({});
    } finally {
      for (const w of [on, bare, off]) await w.dispose();
    }
  });
});

describe("the gate stays with local settings loaded (§36.6 security)", () => {
  it("local permissions.allow never answers a card the engine asks today, nor skips the review of an edit or a command", async () => {
    const root = tmp("rg-local-gate");
    sh(root, "init", "-q");
    write(root, ".claude/settings.local.json", JSON.stringify(LOCAL));
    const on = await wire(root, true);
    const off = await wire(root, false);
    try {
      expect(on.options.settingSources).toEqual(["user", "project", "local"]);
      expect(off.options.settingSources).toEqual(["user", "project"]);
      for (const w of [on, off]) {
        // Commands that change things still ask (the CLI would allow them by the local `Bash` / `Bash(rm:*)` rules).
        expect(await w.pre("Bash", { command: "rm -rf build" })).toBe("ask");
        expect(await w.pre("Bash", { command: "npm install left-pad" })).toBe("ask");
        // A message to another session and a writing MCP tool keep their card.
        expect(await w.pre("SendMessage", { to: "peer", message: "do it" })).toBe("ask");
        expect(await w.pre("mcp__github__delete_file", { id: "1" })).toBe("ask");
        // An edit outside the project asks; one inside goes through the budget hook and is collected for review (no card).
        expect(await w.pre("Write", { file_path: "/etc/rg-outside.txt", content: "x" })).toBe("ask");
        expect(await w.pre("Write", { file_path: join(root, "a.txt"), content: "a\n" })).not.toBe("deny");
        // ReviewGate's own denies still win (git's own data and, release-2 review, its config; M23: a hook is an edit outside
        // the project).
        expect(await w.pre("Write", { file_path: join(root, ".git", "HEAD"), content: "x" })).toBe("deny");
        expect(await w.pre("Write", { file_path: join(root, ".git", "config"), content: "x" })).toBe("deny");
        expect(await w.pre("Write", { file_path: join(root, ".git", "hooks", "pre-push"), content: "x" })).toBe("ask");
      }
      // An ask reaches canUseTool → a permission card, local rules or not.
      const p = on.canUse("Bash", { command: "rm -rf build" }, { signal: new AbortController().signal, toolUseID: "t1" } as never);
      const asked = () => on.events.some((e) => e.type === "permission_request" && e.toolName === "Bash");
      for (const end = Date.now() + 10_000; !asked() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
      expect(asked()).toBe(true);
      void p;
      // A read-only tool the local rule allows is the only thing it changes (§33.5): WebSearch runs without a card.
      expect(await on.pre("WebSearch", { query: "x" })).toBe("allow");
      expect(await off.pre("WebSearch", { query: "x" })).toBe("ask");
    } finally {
      await on.dispose();
      await off.dispose();
    }
  });
});
