import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §36.6 (audit SME-01) at the engine: `settings.loadLocalSettings` (default true) → `settingSources` with
 * "local" and the session's flag; off (or the §16 fallback) → `extensions.notApplied`; local allow rules follow the toggle;
 * MCP scope `local`.
 */
const dirs: string[] = [];
const harnesses: Harness[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
function harness(...args: Parameters<typeof makeHarness>): Harness {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = tmp("rg-local-engine");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@e.com");
  sh(dir, "config", "user.name", "T");
  write(dir, "README.md", "r\n");
  write(dir, ".gitignore", ".claude/settings.local.json\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  write(dir, ".claude/settings.local.json", JSON.stringify({
    env: { RG_LOCAL: "secret-value" },
    permissions: { allow: ["WebSearch", "Bash(npm test:*)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "./report.sh" }] }] },
  }));
  return dir;
}

describe("local settings at the engine (§36.6)", () => {
  it("default on: the session loads `local`, its hooks are listed with the project's, nothing is reported as left out", async () => {
    const dir = makeRepo();
    const h = harness();
    await h.hello();
    const s = await h.open(dir);
    expect(h.session().opts.settings.loadLocalSettings).toBe(true);
    expect(s.session.extensions?.settingSources).toEqual(["project", "local"]);
    expect(s.session.extensions?.notApplied).toBeNull();
    expect(s.session.extensions?.hooks).toEqual([{ source: "project", path: join(dir, ".claude", "settings.local.json"), events: ["Stop"], active: true }]);
    // §33.5: the local allow rules apply (to tools that cannot change files).
    expect(h.session().opts.settings.userRules?.allow).toEqual(["WebSearch", "Bash(npm test:*)"]);
  });

  it("off: no `local`; notApplied names the hooks, env keys, local MCP servers and counts the allow rules; the rules do not apply", async () => {
    const dir = makeRepo();
    const config = tmp("rg-local-engine-config");
    write(config, ".claude.json", JSON.stringify({ projects: { [dir]: { mcpServers: { serena: { command: "uvx" } } } } }));
    const h = harness({ env: { CLAUDE_CONFIG_DIR: config } });
    await h.hello({ loadLocalSettings: false });
    const s = await h.open(dir);
    expect(h.session().opts.settings.loadLocalSettings).toBe(false);
    expect(s.session.extensions?.settingSources).toEqual(["project"]);
    expect(s.session.extensions?.notApplied).toEqual({ hooks: [{ event: "Stop", command: "./report.sh" }], envKeys: ["RG_LOCAL"], mcpServers: ["serena"], allowRuleCount: 2 });
    expect(JSON.stringify(s)).not.toContain("secret-value");
    expect(h.session().opts.settings.userRules?.allow).toEqual([]);
    const rules = await h.engine.request({ type: "permission_rules" });
    expect(rules.rules.map((r) => [r.rule, r.source, r.status, r.why])).toEqual([
      ["WebSearch", "local", "ignored", "local_settings_off"],
      ["Bash(npm test:*)", "local", "ignored", "local_settings_off"],
    ]);
    // Turned back on: the next session start loads them again.
    await h.engine.handle({ type: "set_settings", settings: { loadLocalSettings: true } });
    await h.engine.request({ type: "restart_session" });
    const after = await h.waitFor((x) => x.session.extensions?.settingSources.includes("local") === true, "local again");
    expect(after.session.extensions?.notApplied).toBeNull();
  });

  it("the §16 fallback drops local with user settings and says what it left out", async () => {
    const dir = makeRepo();
    const h = harness();
    await h.hello({ loadUserSettings: true });
    let s = await h.open(dir);
    expect(s.session.extensions?.settingSources).toEqual(["user", "project", "local"]);
    h.session().emit({ type: "init_timeout", afterMs: 5000 });
    s = await h.waitFor((x) => h.sessions.length === 2 && !x.session.starting && x.session.open, "fallback restart");
    expect(h.session().opts.settings.loadUserSettings).toBe(false);
    expect(h.session().opts.settings.loadLocalSettings).toBe(false);
    expect(s.session.extensions?.settingSources).toEqual(["project"]);
    expect(s.session.extensions?.notApplied?.envKeys).toEqual(["RG_LOCAL"]);
  });

  it("mcp_add / mcp_remove scope local go through `claude mcp … --scope local` in the project", async () => {
    const dir = makeRepo();
    const runs: { args: string[]; cwd: string }[] = [];
    const h = harness({ runClaude: async (args, cwd) => {
      runs.push({ args, cwd });
      return { status: 0, stdout: "Added", stderr: "" };
    } });
    await h.hello();
    await h.open(dir);
    const added = await h.engine.request({ type: "mcp_add", name: "serena", scope: "local", config: { command: "uvx", args: ["serena"] } });
    expect(runs[0]).toEqual({ args: ["mcp", "add", "--scope", "local", "--transport", "stdio", "serena", "--", "uvx", "serena"], cwd: dir });
    expect(added.restartRequired).toBe(true);
    await h.engine.request({ type: "mcp_remove", name: "serena", scope: "local" });
    expect(runs[1]).toEqual({ args: ["mcp", "remove", "--scope", "local", "serena"], cwd: dir });
    await h.engine.handle({ type: "close_project" });
    await expect(h.engine.request({ type: "mcp_add", name: "x", scope: "local", config: { command: "x" } })).rejects.toThrow(/no_project/);
  });
});
