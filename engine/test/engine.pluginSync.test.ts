import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginReload } from "../src/session/claude.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §36.5 (composer): a plugin installed in the terminal after the session started (`/plugin`) used to stay
 * out of the palette until the next session — the CLI notices new skills and commands by itself, never plugins. While no
 * turn runs, a change of the plugin files has the CLI reload its plugins and the palette gets the new list.
 */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-plugin-sync"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "r\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const DEMO: PluginReload = {
  commands: [{ name: "demo-plugin:demo-skill", description: "A demo skill", aliases: ["demo-skill"] }, { name: "compact", description: "Compact", builtin: true }],
  plugins: [{ name: "demo-plugin", path: "/Users/dev/.claude/plugins/cache/demo-market/demo-plugin/1.0.0", version: "1.0.0" }],
};

async function setup(loadUserSettings: boolean) {
  const repo = realpathSync(makeTempDir("rg-plugin-sync"));
  dirs.push(repo);
  const project = makeRepo();
  dirs.push(project);
  const cfg = join(repo, "claude-config");
  mkdirSync(join(cfg, "plugins"), { recursive: true });
  writeFileSync(join(cfg, "plugins", "installed_plugins.json"), '{"version":2,"plugins":{}}');
  const h = makeHarness({ pluginSyncMs: 20, env: { CLAUDE_CONFIG_DIR: cfg } });
  harnesses.push(h);
  await h.hello({ loadUserSettings });
  await h.open(project);
  const session = h.session();
  session.reloadResult = DEMO;
  h.session().emit({ type: "commands_info", commands: [{ name: "compact", description: "Compact", builtin: true }] });
  await h.waitFor((x) => (x.session.capabilities?.commands ?? []).length === 1, "first commands");
  return { h, session, cfg };
}

const installDemo = (cfg: string) =>
  writeFileSync(join(cfg, "plugins", "installed_plugins.json"), '{"version":2,"plugins":{"demo-plugin@demo-market":[{"scope":"user"}]}}');

describe("plugins installed while the session runs (§36.5)", () => {
  it("a new installed_plugins.json has the CLI reload its plugins; the palette lists the plugin's commands", async () => {
    const { h, session, cfg } = await setup(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(session.reloads).toBe(0); // nothing changed on disk
    installDemo(cfg);
    const s = await h.waitFor((x) => (x.session.capabilities?.commands ?? []).some((c) => c.name === "demo-plugin:demo-skill"), "the plugin's skill");
    expect(session.reloads).toBe(1);
    expect(s.session.capabilities?.commands?.find((c) => c.name === "demo-plugin:demo-skill")).toMatchObject({ source: "plugin", plugin: "demo-plugin", aliases: ["demo-skill"] });
    expect(s.session.capabilities?.plugins).toEqual(["demo-plugin"]);
  });

  it("waits while a turn runs, then reloads once it is over", async () => {
    const { h, session, cfg } = await setup(true);
    await h.engine.handle({ type: "send", text: "hi" });
    installDemo(cfg);
    await new Promise((r) => setTimeout(r, 120));
    expect(session.reloads).toBe(0);
    h.session().emitTurnEnd();
    await h.waitFor((x) => (x.session.capabilities?.commands ?? []).some((c) => c.name === "demo-plugin:demo-skill"), "reload after the turn");
    expect(session.reloads).toBe(1);
  });

  it("a held reload (it would change the tools mid-conversation) keeps the list as it was", async () => {
    const { h, session, cfg } = await setup(true);
    session.reloadResult = null;
    installDemo(cfg);
    await h.waitFor(() => session.reloads === 1, "the reload asked");
    await new Promise((r) => setTimeout(r, 60));
    expect(session.reloads).toBe(1); // asked once per change
    expect((h.engine.state.session.capabilities?.commands ?? []).map((c) => c.name)).toEqual(["compact"]);
  });

  it("never without the user's settings loaded", async () => {
    const { session, cfg } = await setup(false);
    installDemo(cfg);
    await new Promise((r) => setTimeout(r, 120));
    expect(session.reloads).toBe(0);
  });
});
