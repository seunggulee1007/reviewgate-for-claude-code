import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hookEntriesOf, listHooks, sortHooks } from "../src/session/hooksList.js";
import { NO_MANAGED_POLICY } from "../src/statusline/managed.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §72.1: `/hooks` — the hooks in effect, as the terminal's read-only browser lists them. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});
const temp = (name: string): string => {
  const d = realpathSync(makeTempDir(name));
  dirs.push(d);
  return d;
};

const files = (map: Record<string, unknown>) => (p: string): string | null => (p in map ? JSON.stringify(map[p]) : null);

describe("§72.1 the entries (pure)", () => {
  it("reads every handler with its event, matcher, what it runs and where it is defined", () => {
    const hooks = {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "/work/acme/.claude/hooks/block-rm.sh", if: "Bash(rm *)", timeout: 30 }] },
        { matcher: "*", hooks: [{ type: "http", url: "https://hooks.example.com/pre" }, { type: "command", command: "node", args: ["check.js", "a b"] }] },
      ],
      Stop: [{ hooks: [{ type: "prompt", prompt: "Did it finish? $ARGUMENTS" }, { type: "mcp_tool", server: "acme", tool: "notify" }, { command: "say done", async: true }] }],
      Bogus: "not a list",
    };
    expect(hookEntriesOf(hooks, { source: "user", path: "/Users/dev/.claude/settings.json" })).toEqual([
      { event: "PreToolUse", matcher: "Bash", type: "command", text: "/work/acme/.claude/hooks/block-rm.sh", if: "Bash(rm *)", timeout: 30, source: "user", path: "/Users/dev/.claude/settings.json" },
      { event: "PreToolUse", matcher: "", type: "http", text: "https://hooks.example.com/pre", source: "user", path: "/Users/dev/.claude/settings.json" },
      { event: "PreToolUse", matcher: "", type: "command", text: "node check.js 'a b'", source: "user", path: "/Users/dev/.claude/settings.json" },
      { event: "Stop", matcher: "", type: "prompt", text: "Did it finish? $ARGUMENTS", source: "user", path: "/Users/dev/.claude/settings.json" },
      { event: "Stop", matcher: "", type: "mcp_tool", text: "acme › notify", source: "user", path: "/Users/dev/.claude/settings.json" },
      { event: "Stop", matcher: "", type: "command", text: "say done", async: true, source: "user", path: "/Users/dev/.claude/settings.json" },
    ]);
    expect(hookEntriesOf(null, { source: "user", path: "x" })).toEqual([]);
  });

  it("sorts by the lifecycle, then user, project, local, plugin, managed", () => {
    const mk = (event: string, source: "user" | "project" | "local" | "plugin" | "managed") => ({ event, matcher: "", type: "command", text: event + source, source, path: "p" });
    const sorted = sortHooks([mk("Stop", "user"), mk("Zeta", "user"), mk("PreToolUse", "local"), mk("PreToolUse", "user"), mk("SessionStart", "plugin")]);
    expect(sorted.map((h) => h.text)).toEqual(["SessionStartplugin", "PreToolUseuser", "PreToolUselocal", "Stopuser", "Zetauser"]);
  });

  it("lists the files the session loads, and why the hooks do not run", () => {
    const cfg = "/Users/dev/.claude";
    const root = "/work/acme";
    const read = files({
      [`${cfg}/settings.json`]: { hooks: { Stop: [{ hooks: [{ type: "command", command: "say u" }] }] } },
      [`${root}/.claude/settings.json`]: { hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "lint" }] }] } },
      [`${root}/.claude/settings.local.json`]: { disableAllHooks: true },
      [`/plugins/fmt/hooks/hooks.json`]: { description: "x", hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/fmt.sh" }] }] } },
    });
    const base = { configDir: cfg, cwd: root, loadUser: true, loadLocal: true, plugins: [{ name: "fmt", path: "/plugins/fmt" }, { name: "none", path: "/plugins/none" }], appHooksOff: false, managed: { settings: null, path: null }, read };
    const r = listHooks(base);
    expect(r.hooks.map((h) => [h.event, h.source, h.text, h.active])).toEqual([
      ["PreToolUse", "project", "lint", false],
      ["PostToolUse", "plugin", "${CLAUDE_PLUGIN_ROOT}/fmt.sh", false],
      ["Stop", "user", "say u", false],
    ]);
    expect(r.off).toBe("settings"); // the local file's disableAllHooks
    expect(r.files).toEqual([
      { source: "user", path: `${cfg}/settings.json`, exists: true, count: 1 },
      { source: "project", path: `${root}/.claude/settings.json`, exists: true, count: 1 },
      { source: "local", path: `${root}/.claude/settings.local.json`, exists: true, count: 0 },
      { source: "plugin", plugin: "fmt", path: "/plugins/fmt/hooks/hooks.json", exists: true, count: 1 },
    ]);
    expect(r.hooks.find((h) => h.source === "plugin")?.plugin).toBe("fmt");

    // Without user or local settings, their files are not read; the app's switch says so.
    const r2 = listHooks({ ...base, loadUser: false, loadLocal: false, plugins: [], appHooksOff: true });
    expect(r2.files.map((f) => f.source)).toEqual(["project"]);
    expect(r2.off).toBe("app");
    expect(r2.hooks.every((h) => h.active === false)).toBe(true);

    // The managed tier: its hooks are listed and run; allowManagedHooksOnly leaves only them.
    const managed = { settings: { allowManagedHooksOnly: true, hooks: { SessionStart: [{ hooks: [{ command: "audit" }] }] } }, path: "/Library/Application Support/ClaudeCode/managed-settings.json" };
    const r3 = listHooks({ ...base, loadLocal: false, managed });
    expect(r3.off).toBe("managed_only");
    expect(r3.hooks.map((h) => [h.source, h.active])).toEqual([["managed", true], ["project", false], ["plugin", false], ["user", false]]);
    expect(listHooks({ ...base, managed: { ...managed, settings: { ...managed.settings, disableAllHooks: true } } }).hooks.every((h) => h.active === false)).toBe(true);

    // A later file's disableAllHooks: false wins over an earlier true (the CLI's precedence).
    const read4 = files({ [`${cfg}/settings.json`]: { disableAllHooks: true, hooks: { Stop: [{ hooks: [{ command: "u" }] }] } }, [`${root}/.claude/settings.json`]: { disableAllHooks: false } });
    const r4 = listHooks({ ...base, read: read4, plugins: [] });
    expect(r4.off).toBeNull();
    expect(r4.hooks[0]?.active).toBe(true);
    expect(r4.files.find((f) => f.source === "local")).toEqual({ source: "local", path: `${root}/.claude/settings.local.json`, exists: false, count: 0 });
  });
});

describe("§72.1 hooks_list", () => {
  it("answers from the session's settings files, without a session too", async () => {
    const base = temp("rg-hooks");
    const cfg = join(base, "claude-config");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: "command", command: "notify-send hi" }] }] } }));
    const repo = temp("rg-hooks-repo");
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.email", "test@example.com");
    sh(repo, "config", "user.name", "Test");
    write(repo, ".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] } }));
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "init");
    const h = makeHarness({ env: { CLAUDE_CONFIG_DIR: cfg }, managedPolicy: () => NO_MANAGED_POLICY });
    harnesses.push(h);
    await h.hello({ loadUserSettings: true });
    await h.open(repo);
    const r = await h.engine.request({ type: "hooks_list" });
    expect(r.type).toBe("hooks_list");
    expect(r.hooks.map((x) => [x.event, x.matcher, x.text, x.source, x.active])).toEqual([
      ["PreToolUse", "Bash", "guard.sh", "project", true],
      ["Notification", "", "notify-send hi", "user", true],
    ]);
    expect(r.files.map((f) => [f.source, f.exists])).toEqual([["user", true], ["project", true], ["local", false]]);
    expect(r.off).toBeNull();

    await h.hello({ loadUserSettings: false, disableUserHooks: true });
    const r2 = await h.engine.request({ type: "hooks_list" });
    expect(r2.off).toBe("app");
  });
});
