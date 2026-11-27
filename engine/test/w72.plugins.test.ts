import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lastJsonLine, parseMarketplaces, parsePluginList, pluginRunArgs, pluginRunOutcome, reloadCounts } from "../src/session/pluginCli.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §72.3: `/plugin` through the CLI's own `claude plugin … --json`, and `/reload-plugins`. */

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

const LIST = JSON.stringify({
  installed: [
    { id: "fmt@acme-market", version: "1.2.0", scope: "user", enabled: true, installPath: "/Users/dev/.claude/plugins/cache/acme-market/fmt/1.2.0" },
    { id: "lint@acme-market", version: "abc123def456", scope: "project", enabled: false, installPath: "/x", projectPath: "/work/acme", errors: ["Plugin \"lint\" not cached"] },
    { id: "notes@synced", version: "unknown", scope: "synced", enabled: true, installPath: "/y", notes: ["not used recently"] },
  ],
  available: [{ pluginId: "deploy@acme-market", name: "deploy", marketplaceName: "acme-market", source: "./plugins/deploy", description: "Deploy helpers", version: "0.1.0", installCount: 12 }],
}, null, 2);
const MARKETS = JSON.stringify([{ name: "acme-market", source: "github", repo: "acme/plugins", installLocation: "/Users/dev/.claude/plugins/marketplaces/acme-market" }, { name: "local-dev", source: "directory", path: "/work/acme/market" }]);

describe("§72.3 the CLI's commands (pure)", () => {
  it("builds each action's argv, never through a shell, refusing what is not a target", () => {
    expect(pluginRunArgs("install", "fmt@acme-market", "project")).toEqual(["plugin", "install", "fmt@acme-market", "-s", "project", "--json"]);
    expect(pluginRunArgs("disable", " fmt ", undefined)).toEqual(["plugin", "disable", "fmt", "--json"]);
    expect(pluginRunArgs("marketplace_add", "acme/plugins", "user")).toEqual(["plugin", "marketplace", "add", "acme/plugins", "--scope", "user", "--json"]);
    expect(pluginRunArgs("marketplace_update", "acme-market", "user")).toEqual(["plugin", "marketplace", "update", "acme-market", "--json"]);
    expect(() => pluginRunArgs("prune", "x", undefined)).toThrow("invalid_plugin_action");
    expect(() => pluginRunArgs("install", "--yes", undefined)).toThrow("invalid_plugin_target");
    expect(() => pluginRunArgs("install", "a\nb", undefined)).toThrow("invalid_plugin_target");
    expect(() => pluginRunArgs("install", "", undefined)).toThrow("invalid_plugin_target");
    expect(() => pluginRunArgs("install", "x", "managed")).toThrow("invalid_plugin_scope");
  });

  it("reads plugin list --json --available and marketplace list --json", () => {
    const r = parsePluginList(LIST, ["fmt@acme-market"])!;
    expect(r.installed).toEqual([
      { id: "fmt@acme-market", name: "fmt", marketplace: "acme-market", version: "1.2.0", scope: "user", enabled: true, installPath: "/Users/dev/.claude/plugins/cache/acme-market/fmt/1.2.0", appOff: true },
      { id: "lint@acme-market", name: "lint", marketplace: "acme-market", version: "abc123def456", scope: "project", enabled: false, installPath: "/x", projectPath: "/work/acme", errors: ["Plugin \"lint\" not cached"] },
      { id: "notes@synced", name: "notes", marketplace: "synced", version: "unknown", scope: "synced", enabled: true, installPath: "/y", notes: ["not used recently"] },
    ]);
    expect(r.available).toEqual([{ id: "deploy@acme-market", name: "deploy", marketplace: "acme-market", description: "Deploy helpers", version: "0.1.0", installCount: 12 }]);
    // An older CLI without --available prints the array.
    expect(parsePluginList(JSON.stringify([{ id: "fmt@acme-market", version: "1", scope: "user", enabled: true }]), [])!.installed).toHaveLength(1);
    expect(parsePluginList("No plugins installed.", [])).toBeNull();
    expect(parseMarketplaces(MARKETS)).toEqual([
      { name: "acme-market", source: "github", repo: "acme/plugins", installLocation: "/Users/dev/.claude/plugins/marketplaces/acme-market" },
      { name: "local-dev", source: "directory", path: "/work/acme/market" },
    ]);
  });

  it("takes the result line's words; an enable that is already so is done", () => {
    expect(lastJsonLine('$ some command\n{"command":"install","outcome":"ok","message":"Installed plugin: fmt@acme-market (scope: user)"}\n')).toMatchObject({ outcome: "ok" });
    expect(pluginRunOutcome({ status: 0, stdout: '{"command":"install","outcome":"ok","message":"Installed plugin: fmt"}', stderr: "" })).toMatchObject({ ok: true, message: "Installed plugin: fmt" });
    expect(pluginRunOutcome({ status: 1, stdout: '{"command":"enable","outcome":"failed","failureCode":"already_in_goal_state","alreadyInGoalState":true,"message":"Plugin \\"fmt\\" is already enabled"}', stderr: "" }).ok).toBe(true);
    expect(pluginRunOutcome({ status: 1, stdout: "", stderr: "error: unknown command 'plugin'\n" })).toMatchObject({ ok: false, message: "error: unknown command 'plugin'", output: "error: unknown command 'plugin'" });
  });

  it("counts the reload as the terminal's summary", () => {
    const r = { commands: [{ name: "fmt:format" }, { name: "fmt:check" }, { name: "compact" }, { name: "other:x" }], plugins: [{ name: "fmt" }], agents: 3, mcpServers: ["plugin:fmt:server", "acme-docs"], errorCount: 1 };
    expect(reloadCounts(r, 2)).toEqual({ plugins: 1, skills: 2, agents: 3, hooks: 2, mcpServers: 1, errors: 1 });
  });
});

function makeRepo(): string {
  const repo = temp("rg-plugins-repo");
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "user.name", "Test");
  write(repo, "a.txt", "a\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "init");
  return repo;
}

describe("§72.3 plugins_list / plugin_run / plugins_reload", () => {
  it("lists through the CLI, runs one action and answers its words, never a refusal for the CLI's own failure", async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    let installOut = { status: 0, stdout: '{"command":"install","outcome":"ok","message":"Installed plugin: deploy@acme-market (scope: user)"}', stderr: "" };
    const runClaude = async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      if (args[1] === "list") return { status: 0, stdout: LIST, stderr: "" };
      if (args[1] === "marketplace" && args[2] === "list") return { status: 0, stdout: MARKETS, stderr: "" };
      return installOut;
    };
    const repo = makeRepo();
    const h = makeHarness({ runClaude });
    harnesses.push(h);
    await h.hello({ disabledPlugins: ["lint@acme-market"] });
    await h.open(repo);
    const list = await h.engine.request({ type: "plugins_list" });
    expect(list.installed.map((p) => [p.id, p.enabled, p.appOff === true])).toEqual([["fmt@acme-market", true, false], ["lint@acme-market", false, true], ["notes@synced", true, false]]);
    expect(list.available.map((p) => p.id)).toEqual(["deploy@acme-market"]);
    expect(list.marketplaces.map((m) => m.name)).toEqual(["acme-market", "local-dev"]);
    expect(calls.map((c) => c.args.join(" "))).toEqual(["plugin list --json --available", "plugin marketplace list --json"]);
    expect(calls[0]!.cwd).toBe(repo);

    const ok = await h.engine.request({ type: "plugin_run", action: "install", target: "deploy@acme-market", scope: "user" });
    expect(ok).toMatchObject({ type: "plugin_result", action: "install", target: "deploy@acme-market", ok: true, message: "Installed plugin: deploy@acme-market (scope: user)" });
    expect(calls.at(-1)!.args).toEqual(["plugin", "install", "deploy@acme-market", "-s", "user", "--json"]);

    installOut = { status: 1, stdout: "Run this command now? [y/N]\nThe command was only displayed", stderr: "" };
    const failed = await h.engine.request({ type: "plugin_run", action: "install", target: "cmd@acme-market" });
    expect(failed.ok).toBe(false);
    expect(failed.output).toContain("only displayed");
    await expect(h.engine.request({ type: "plugin_run", action: "install", target: "-y" })).rejects.toThrow("invalid_plugin_target");
  });

  it("a CLI that cannot list answers the error with empty lists", async () => {
    const h = makeHarness({ runClaude: async () => ({ status: 1, stdout: "", stderr: "error: unknown option '--available'" }) });
    harnesses.push(h);
    await h.hello();
    await h.open(makeRepo());
    const list = await h.engine.request({ type: "plugins_list" });
    expect(list).toMatchObject({ installed: [], available: [], marketplaces: [], error: "error: unknown option '--available'" });
  });

  it("/reload-plugins: applied (the palette follows), held with what it would change, refused during a turn", async () => {
    const base = temp("rg-reload");
    const pluginDir = join(base, "plugins", "cache", "acme-market", "fmt", "1.0.0");
    mkdirSync(join(pluginDir, "hooks"), { recursive: true });
    writeFileSync(join(pluginDir, "hooks", "hooks.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ command: "fmt" }, { command: "lint" }] }] } }));
    const h = makeHarness({ pluginSyncMs: 0 });
    harnesses.push(h);
    await h.hello();
    await h.open(makeRepo());
    const s = h.session();
    s.reloadNowResult = { commands: [{ name: "fmt:format", description: "Format" }], plugins: [{ name: "fmt", path: pluginDir, version: "1.0.0" }], held: false, agents: 2, mcpServers: [], errorCount: 0 };
    const r = await h.engine.request({ type: "plugins_reload" });
    expect(r).toMatchObject({ type: "plugins_reloaded", applied: true, held: false, plugins: 1, skills: 1, agents: 2, hooks: 2, mcpServers: 0, errors: 0 });
    expect(s.reloadsNow).toEqual([false]);
    expect(h.engine.state.session.capabilities?.plugins).toEqual(["fmt"]);
    expect(h.engine.state.session.capabilities?.commands?.some((c) => c.name === "fmt:format")).toBe(true);

    s.reloadNowResult = { ...s.reloadNowResult, held: true, cacheImpact: { mcpServersAdded: ["plugin:fmt:srv"], mcpServersRemoved: [], lspToolChange: null } };
    const held = await h.engine.request({ type: "plugins_reload" });
    expect(held).toMatchObject({ applied: false, held: true, cacheImpact: { mcpServersAdded: ["plugin:fmt:srv"] } });
    await h.engine.request({ type: "plugins_reload", force: true });
    expect(s.reloadsNow).toEqual([false, false, true]);

    await h.engine.handle({ type: "send", text: "hi" });
    await expect(h.engine.request({ type: "plugins_reload" })).rejects.toThrow("plugins_turn_running");
  });
});
