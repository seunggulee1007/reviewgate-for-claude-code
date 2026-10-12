import { chmodSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCheckpoint } from "../src/git/checkpoint.js";
import { isModsGroup, isModsPath, isStubContent, MODS_MAX_BYTES, modsRisks } from "../src/git/mods.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

/** Like acme: `.claude/` and `.mcp.json` are gitignored. */
function makeRepo(): string {
  const dir = track(realpathSync(makeTempDir("rg-mods")));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, ".gitignore", ".claude/\n.mcp.json\nCLAUDE.local.md\n");
  write(dir, "README.md", "readme\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

/** `<mode> <type> <sha>\t<path>` of every entry of `tree`. */
function lsTree(dir: string, tree: string): Map<string, { mode: string; sha: string }> {
  const out = new Map<string, { mode: string; sha: string }>();
  for (const line of sh(dir, "ls-tree", "-r", tree).split("\n").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    const [mode, , sha] = meta!.split(" ");
    out.set(path!, { mode: mode!, sha: sha! });
  }
  return out;
}

describe("mods paths are in every snapshot, gitignored or not (§32)", () => {
  it("force-adds .claude/** (not worktrees/, node_modules/, nested repos, settings.local.json), .mcp.json and CLAUDE*.md; big / binary content is a stub", async () => {
    const dir = makeRepo();
    write(dir, ".claude/hooks/commit-sweep.sh", "#!/bin/sh\necho sweep\n");
    chmodSync(join(dir, ".claude/hooks/commit-sweep.sh"), 0o755);
    write(dir, ".claude/settings.json", '{"hooks":{}}\n');
    write(dir, ".claude/settings.local.json", '{"env":{"TOKEN":"secret"}}\n');
    write(dir, ".claude/skills/s/SKILL.md", "skill\n");
    write(dir, ".claude/skills/s/node_modules/dep/index.js", "dep\n");
    write(dir, ".claude/worktrees/wf_1/app.txt", "worktree\n");
    write(dir, ".claude/skills/cloned/.git/HEAD", "ref: refs/heads/main\n");
    write(dir, ".claude/skills/cloned/x.md", "in a nested repo\n");
    write(dir, ".claude/big.log", "x".repeat(MODS_MAX_BYTES + 1));
    write(dir, ".claude/icon.png", "png bytes\n");
    write(dir, ".claude/data.dat", Buffer.from([1, 0, 2, 3]));
    symlinkSync("settings.json", join(dir, ".claude/link.json"));
    write(dir, ".mcp.json", '{"mcpServers":{}}\n');
    write(dir, "CLAUDE.local.md", "local instructions\n");
    const cp = await openCheckpoint(dir);
    const tree = await cp.snapshot([".claude/"]); // the app's ignore patterns do not hide them either
    const entries = lsTree(dir, tree);
    const paths = [...entries.keys()].filter((p) => p.startsWith(".claude/") || p.startsWith(".mcp") || p.startsWith("CLAUDE"));
    expect(paths).toEqual([
      ".claude/big.log",
      ".claude/data.dat",
      ".claude/hooks/commit-sweep.sh",
      ".claude/icon.png",
      ".claude/link.json",
      ".claude/settings.json",
      ".claude/skills/s/SKILL.md",
      ".mcp.json",
      "CLAUDE.local.md",
    ]);
    // Windows has no executable bit (chmod is a no-op, git init sets core.fileMode false): like `git add` there, a new
    // file is recorded 100644 — the script risk then comes from its extension (modsRisks).
    expect(entries.get(".claude/hooks/commit-sweep.sh")!.mode).toBe(process.platform === "win32" ? "100644" : "100755");
    expect(entries.get(".claude/link.json")!.mode).toBe("120000");
    const blob = (p: string) => cp.fileContent(p, tree);
    expect((await blob(".claude/settings.json")).toString()).toBe('{"hooks":{}}\n');
    for (const p of [".claude/big.log", ".claude/icon.png", ".claude/data.dat"]) expect(isStubContent(await blob(p)), p).toBe(true);
    expect((await blob(".claude/big.log")).toString()).toMatch(/not captured \(too large\): 262145 bytes/);
    // The user's own index is never touched.
    expect(sh(dir, "status", "--porcelain")).toBe("");
    // An unchanged worktree gives the same tree again (stubs are stable).
    expect(await cp.snapshot([".claude/"])).toBe(tree);
  });

  it("a stub is never written back: reverting an uncaptured file is refused, a captured one is restored", async () => {
    const dir = makeRepo();
    write(dir, ".claude/big.log", "x".repeat(MODS_MAX_BYTES + 1));
    write(dir, ".claude/hooks/a.sh", "echo a\n");
    const cp = await openCheckpoint(dir);
    const a = await cp.snapshot();
    write(dir, ".claude/big.log", "y".repeat(MODS_MAX_BYTES + 5));
    write(dir, ".claude/hooks/a.sh", "echo pwned\n");
    const b = await cp.snapshot();
    const changes = await cp.changes(a, b);
    expect(changes.map((c) => [c.path, c.status])).toEqual([[".claude/big.log", "M"], [".claude/hooks/a.sh", "M"]]);
    await expect(cp.revert(changes[0]!, a)).rejects.toThrow(/not captured/);
    await cp.revert(changes[1]!, a);
    expect(sh(dir, "show", `${a}:.claude/hooks/a.sh`)).toBe("echo a\n");
    expect((await cp.fileContent(".claude/hooks/a.sh")).toString()).toBe("echo a\n");
  });

  it("path rules and risks", () => {
    expect([".claude/hooks/x.sh", ".mcp.json", "CLAUDE.md", ".claude/agents/a.md"].every(isModsPath)).toBe(true);
    expect([".claude/settings.local.json", ".claude/worktrees/w/x", ".claude/s/node_modules/a.js", "docs/CLAUDE.md", "src/a.ts"].some(isModsPath)).toBe(false);
    expect(isModsGroup("docs/CLAUDE.md")).toBe(true);
    expect(isModsGroup(".claude/settings.local.json")).toBe(true);
    expect(isModsGroup("src/a.ts")).toBe(false);
    const j = (o: unknown) => Buffer.from(JSON.stringify(o));
    expect(modsRisks(".claude/hooks/sweep.sh", true, Buffer.from("a"), Buffer.from("b"))).toEqual(["hook", "script"]);
    expect(modsRisks(".claude/settings.json", false, j({ hooks: {} }), j({ hooks: { Stop: [] } }))).toEqual(["hook"]);
    expect(modsRisks(".claude/settings.json", false, j({ permissions: { allow: [] } }), j({ permissions: { allow: ["Bash(*)"] }, env: { A: "1" } }))).toEqual(["env", "permissions"]);
    expect(modsRisks(".claude/settings.json", false, j({ model: "a" }), j({ model: "b" }))).toEqual([]);
    expect(modsRisks(".mcp.json", false, null, j({ mcpServers: {} }))).toEqual(["mcp"]);
    expect(modsRisks(".claude/agents/a.md", false, Buffer.from("a"), Buffer.from("b"))).toEqual([]);
  });
});
