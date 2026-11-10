import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bashClaudeConfigTarget, bashScopeReason, bashWorkDirs, inputClaudeConfigTarget } from "../src/session/reviewScope.js";
import { makeRepo, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §35.6: two cheap holes in the §33.4 / §33.9 detection, closed without making the Bash check any less
 * textual. A writing MCP call that names a settings file by an absolute path with a space in it (a project folder such as
 * "My Project") was not seen — path values with whitespace were all taken for free text. A command that `cd`s inside a
 * subshell or a brace group (`(cd .claude && … > settings.json)`, `{ cd vendor/lib; …; }`) kept the shell's directory where
 * it was, so neither the settings file nor the nested repository / other worktree it works in was found.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("a writing MCP call names a settings file by a path with a space (§35.6)", () => {
  it("path-like keys hold one path, spaces included; free text still never counts", () => {
    const root = resolve("/tmp/My Project");
    const local = join(root, ".claude", "settings.local.json");
    expect(inputClaudeConfigTarget({ path: local, content: "{}" }, root)).toBe(local);
    expect(inputClaudeConfigTarget({ file_path: join(root, "modules", "api", ".claude", "settings.json") }, root)).toBe(join(root, "modules", "api", ".claude", "settings.json"));
    expect(inputClaudeConfigTarget({ source: "/tmp/x.json", destination: join(root, ".mcp.json") }, root)).toBe(join(root, ".mcp.json"));
    expect(inputClaudeConfigTarget({ uri: "file:///tmp/My%20Project/.claude/settings.local.json" }, root)).toBe(resolve("/tmp/My Project/.claude/settings.local.json"));
    expect(inputClaudeConfigTarget({ pathInProject: "docs/My Notes.md", text: "Copy .mcp.json and .claude/settings.local.json first." }, root)).toBeNull();
    expect(inputClaudeConfigTarget({ path: join(root, "docs", "setup guide.md"), content: "see .claude/settings.json" }, root)).toBeNull();
  });
});

describe("a cd inside a subshell or a brace group still moves the shell's directory for detection (§35.6)", () => {
  it("settings files (§33.9)", () => {
    const root = resolve("/repo");
    expect(bashClaudeConfigTarget(`(cd .claude && echo '{"hooks":{}}' > settings.json)`, root, root)).toBe(resolve("/repo/.claude/settings.json"));
    expect(bashClaudeConfigTarget("{ cd .claude; jq '.x=1' settings.json > t && mv t settings.json; }", root, root)).toBe(resolve("/repo/.claude/settings.json"));
    expect(bashClaudeConfigTarget("(cd modules/api/.claude && cp /tmp/x settings.json)", root, root)).toBe(resolve("/repo/modules/api/.claude/settings.json"));
    expect(bashClaudeConfigTarget("(cd docs && echo x > settings.json)", root, root)).toBeNull();
  });

  it("nested repositories and other worktrees (§33.4)", () => {
    const root = realpathSync(makeRepo());
    dirs.push(root);
    const lib = join(root, "vendor", "lib");
    mkdirSync(lib, { recursive: true });
    sh(lib, "init", "-q");
    write(lib, "lib.txt", "lib\n");
    expect(bashScopeReason("(cd vendor/lib && sed -i '' s/a/b/ lib.txt)", root, root, [])).toMatchObject({ code: "nested_repository", path: lib });
    expect(bashScopeReason("{ cd vendor/lib; echo x >> lib.txt; }", root, root, [])).toMatchObject({ code: "nested_repository", path: lib });
    const sibling = resolve(root, "..", "sibling-wt");
    expect(bashScopeReason(`(cd "${sibling}" && make)`, root, root, [sibling])).toMatchObject({ code: "other_worktree", path: sibling });
    expect(bashWorkDirs("(cd vendor/lib && make)", root)).toEqual([root, lib]);
    expect(bashScopeReason("(cd src && make)", root, root, [])).toBeNull();
    // git -C by git's name (§20 programName): Git Bash's git.exe, any case
    expect(bashWorkDirs("git.exe -C vendor/lib status", root)).toEqual([root, lib]);
    expect(bashScopeReason("GIT.EXE -C vendor/lib commit -am x", root, root, [])).toMatchObject({ code: "nested_repository", path: lib });
  });
});
