// MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3: the user's Claude Code mods (dev-mods, CLAUDE_CODE_PLUGIN_DIRS), read only.
import { utimesSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listUserMods, pluginDirsOf, readManifest, settingsPluginDirs } from "../src/board/mods.js";
import { makeTempDir, removeDir, write } from "./helpers/repo.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});
function temp(): string {
  const d = makeTempDir("rg-mods");
  dirs.push(d);
  return d;
}

function mod(dir: string, manifest: Record<string, unknown> | string, hooks = true): void {
  write(dir, ".claude-plugin/plugin.json", typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  if (hooks) write(dir, "hooks/hooks.json", JSON.stringify({ modules: ["./register.tsx"] }));
}

describe("mods", () => {
  it("splits CLAUDE_CODE_PLUGIN_DIRS like the CLI: the delimiter, ~ expanded, absolute folders only", () => {
    expect(pluginDirsOf(" /a/x :~/mods: rel/skip ::/a/x", { home: "/home/u", delimiter: ":" })).toEqual([resolve("/a/x"), resolve(join("/home/u", "mods"))]);
    expect(pluginDirsOf(undefined)).toEqual([]);
    expect(pluginDirsOf("  ")).toEqual([]);
  });

  it("reads a manifest: its name (else the folder's), a description, a version; not a plugin → null", () => {
    const root = temp();
    mod(join(root, "board"), { name: "agent-board", description: "관제판", version: "0.1.0" });
    mod(join(root, "nameless"), { description: 42 }, false);
    write(root, "broken/.claude-plugin/plugin.json", "{ not json");
    expect(readManifest(join(root, "board"))).toEqual({ name: "agent-board", description: "관제판", version: "0.1.0" });
    expect(readManifest(join(root, "nameless"))).toEqual({ name: "nameless", description: "" });
    expect(readManifest(join(root, "broken"))).toBeNull();
    expect(readManifest(join(root, "missing"))).toBeNull();
  });

  it("lists PLUGIN_DIRS folders (a folder of plugins by its children) before dev-mods, newest session first, once per folder", () => {
    const config = temp();
    const fixed = temp();
    mod(join(fixed, "agent-board"), { name: "agent-board", description: "board" });
    mod(join(fixed, "radar"), { name: "agent-radar", description: "radar" }, false);
    mod(join(config, "dev-mods", "s-old", "agent-radar"), { name: "agent-radar", description: "old radar" });
    mod(join(config, "dev-mods", "s-new", "agent-dashboard"), { name: "agent-dashboard", description: "dash" });
    write(config, "dev-mods/s-new/not-a-mod/readme.txt", "x");
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(config, "dev-mods", "s-old"), old, old);
    const mods = listUserMods({
      configDir: config,
      pluginDirs: `${fixed}${delimiter}${join(config, "dev-mods", "s-old", "agent-radar")}`,
      loadedPaths: [join(fixed, "agent-board")],
    });
    expect(mods.map((m) => [m.name, m.source, m.sessionId ?? null, m.loaded, m.hasHooks])).toEqual([
      ["agent-board", "plugin_dirs", null, true, true],
      ["agent-radar", "plugin_dirs", null, false, false],
      ["agent-radar", "plugin_dirs", null, false, true],
      ["agent-dashboard", "dev", "s-new", false, true],
    ]);
    expect(mods[0]!.path).toBe(join(fixed, "agent-board"));
  });

  it("nothing to list without dev-mods or PLUGIN_DIRS; settings.json's env is read, never written", () => {
    const config = temp();
    expect(listUserMods({ configDir: config, pluginDirs: undefined, loadedPaths: [] })).toEqual([]);
    expect(settingsPluginDirs(config)).toBeUndefined();
    write(config, "settings.json", JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: "/x/mods" } }));
    expect(settingsPluginDirs(config)).toBe("/x/mods");
    write(config, "settings.json", "{ broken");
    expect(settingsPluginDirs(config)).toBeUndefined();
  });
});
