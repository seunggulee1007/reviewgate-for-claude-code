import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { filtersOffArgs } from "../src/git/filtersOff.js";
import { nestedStatus } from "../src/review/nested.js";
import { BudgetState } from "../src/session/budget.js";
import { gitProbe } from "../src/session/gitDestructive.js";
import { buildHooks, type HookContext } from "../src/session/hooks.js";
import { changedPaths, dirState } from "../src/session/outsideWatch.js";
import { bashPath, makeRepo, removeDir, sh, write } from "./helpers/repo.js";

/**
 * Release 1 review (docs/PROTOCOL.md §33.4, §46): the engine reads `git status` in a nested repository (or another
 * worktree, a folder outside the project) in the Bash PreToolUse hook — before any card. That repository's configuration is
 * not the user's to run then: fsmonitor and hooks were off already (runGit), its filter drivers are off now too.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

/**
 * The project with a nested clone `vendor/lib` whose own configuration runs commands: a clean filter on every `.txt` and
 * an fsmonitor hook, each leaving a marker file. `lib.txt` is committed there, then touched (its stat data changed), so a
 * plain `git status` hands it to the clean filter.
 */
function trappedNestedRepo(): { root: string; nested: string; filterMark: string; monitorMark: string } {
  const root = realpathSync(makeRepo());
  dirs.push(root);
  const nested = join(root, "vendor", "lib");
  mkdirSync(nested, { recursive: true });
  sh(nested, "init", "-q");
  sh(nested, "config", "user.email", "test@example.com");
  sh(nested, "config", "user.name", "Test");
  const filterMark = join(root, "..", `${join(root).split(/[\\/]/).pop()}-filter-ran`);
  const monitorMark = join(root, "..", `${join(root).split(/[\\/]/).pop()}-fsmonitor-ran`);
  dirs.push(filterMark, monitorMark);
  write(nested, ".gitattributes", "*.txt filter=trap\n");
  write(nested, "lib.txt", "acme\n");
  sh(nested, "add", "-A");
  sh(nested, "commit", "-qm", "init");
  const monitor = join(nested, ".git", "fsmon.sh");
  writeFileSync(monitor, `#!/bin/sh\ntouch '${monitorMark}'\nexit 1\n`);
  chmodSync(monitor, 0o755);
  sh(nested, "config", "core.fsmonitor", monitor);
  sh(nested, "config", "filter.trap.clean", `touch '${bashPath(filterMark)}'; cat`);
  sh(nested, "config", "filter.trap.required", "true");
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(nested, "lib.txt"), later, later);
  return { root, nested, filterMark, monitorMark };
}

function ctx(root: string): HookContext {
  return {
    budget: new BudgetState({ maxFiles: 0, maxLines: 0 }),
    cwd: root,
    root,
    ignorePatterns: [],
    autoAllowTools: new Set(),
    emit: () => {},
    log: () => {},
    onScopeNotice: () => {},
  };
}

const opts = { signal: new AbortController().signal };

async function preBash(c: HookContext, command: string, cwd: string, id: string): Promise<string | undefined> {
  const hook = buildHooks(c).PreToolUse!.find((m) => m.matcher === "Bash")!.hooks[0] as HookCallback;
  const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: "s", transcript_path: "", cwd, tool_use_id: id } as unknown as HookInput;
  const out = (await hook(input, id, opts)) as { hookSpecificOutput?: { permissionDecision?: string } };
  return out.hookSpecificOutput?.permissionDecision;
}

describe.skipIf(process.platform === "win32")("git status in another repository runs nothing of its configuration (§33.4, §46)", () => {
  it("filtersOffArgs turns off every filter driver the folder's configuration defines; none defined, none turned off", async () => {
    const { nested, root } = trappedNestedRepo();
    // (A driver of the machine's own global configuration — `filter.lfs` — is listed too.)
    const args = (await filtersOffArgs(nested))!;
    const at = args.indexOf("filter.trap.clean=");
    expect(at).toBeGreaterThan(0);
    expect(args.slice(at - 1, at + 7)).toEqual(["-c", "filter.trap.clean=", "-c", "filter.trap.smudge=", "-c", "filter.trap.process=", "-c", "filter.trap.required=false"]);
    expect(args.length % 8).toBe(0);
    // The project around it defines no such driver.
    const own = await filtersOffArgs(root);
    expect(own).not.toBeNull();
    expect(own!.filter((a) => a.startsWith("filter.trap."))).toEqual([]);
  });

  it("the after-notice's status of a nested repository runs neither its clean filter nor its fsmonitor", async () => {
    const { nested, filterMark, monitorMark } = trappedNestedRepo();
    rmSync(filterMark, { force: true });
    const state = await dirState(nested);
    expect(state).not.toBeNull();
    expect(existsSync(filterMark)).toBe(false);
    expect(existsSync(monitorMark)).toBe(false);
    // The trap is real: git's own status hands the touched file to the filter.
    sh(nested, "-c", "core.fsmonitor=", "status", "--porcelain");
    expect(existsSync(filterMark)).toBe(true);
  });

  it("the turn's nested-repository report (§32.2) reads its status with the filters off too, and still counts a changed file", async () => {
    const { nested, filterMark, monitorMark } = trappedNestedRepo();
    rmSync(filterMark, { force: true });
    // Only touched (a pass-through filter): clean without the filter as well.
    expect((await nestedStatus(nested)).dirtyFiles).toBe(0);
    write(nested, "lib.txt", "acme changed\n");
    write(nested, "notes.txt", "new\n");
    const now = await nestedStatus(nested);
    expect(now.dirtyFiles).toBe(2);
    expect(now.head).toMatch(/^[0-9a-f]{40,64}$/);
    expect(existsSync(filterMark)).toBe(false);
    expect(existsSync(monitorMark)).toBe(false);
  });

  it("release-2 review: a submodule of the nested repository is read on its own — its changed file listed and counted, its filters off", async () => {
    const { root, nested, filterMark } = trappedNestedRepo();
    const inner = realpathSync(makeRepo());
    dirs.push(inner);
    write(inner, "x.txt", "acme\n");
    sh(inner, "add", "-A");
    sh(inner, "commit", "-qm", "x");
    sh(nested, "-c", "protocol.file.allow=always", "-c", "core.fsmonitor=", "-c", "filter.trap.clean=cat", "submodule", "add", "-q", inner, "inner");
    sh(nested, "-c", "core.fsmonitor=", "-c", "filter.trap.clean=cat", "commit", "-qm", "inner");
    const innerMark = join(root, "..", `${root.split(/[\\/]/).pop()}-inner-filter-ran`);
    dirs.push(innerMark);
    const sub = join(nested, "inner");
    write(sub, ".gitattributes", "*.txt filter=itrap\n");
    sh(sub, "config", "filter.itrap.clean", `touch '${bashPath(innerMark)}'; cat`);
    rmSync(filterMark, { force: true });
    const before = (await dirState(nested))!;
    expect((await nestedStatus(nested)).dirtyFiles).toBe(1); // inner/.gitattributes, untracked there
    write(sub, "x.txt", "acme changed in the submodule\n");
    const after = (await dirState(nested))!;
    expect([...after.files.keys()].sort()).toEqual(["inner/.gitattributes", "inner/x.txt"]);
    expect(await changedPaths(nested, before, after)).toEqual(["inner/x.txt"]);
    expect((await nestedStatus(nested)).dirtyFiles).toBe(2);
    expect(existsSync(innerMark)).toBe(false);
    expect(existsSync(filterMark)).toBe(false);
  });

  it("the §46 probe in a nested repository leaves its filters off; in this window's repository it is git's status as before", async () => {
    const { root, nested, filterMark, monitorMark } = trappedNestedRepo();
    rmSync(filterMark, { force: true });
    // A pass-through filter: the touched file is clean without it too.
    expect(await gitProbe.isDirty(nested, ["lib.txt"], false, true)).toBe(false);
    write(nested, "lib.txt", "acme changed\n");
    expect(await gitProbe.isDirty(nested, ["lib.txt"], false, true)).toBe(true);
    expect(existsSync(filterMark)).toBe(false);
    expect(existsSync(monitorMark)).toBe(false);
    write(root, "README.md", "changed\n");
    expect(await gitProbe.isDirty(root, ["README.md"], false, false)).toBe(true);
  });

  it("through the Bash hook: a command run in the nested repository, and a checkout there, reach their cards without running its configuration", async () => {
    const { root, nested, filterMark, monitorMark } = trappedNestedRepo();
    rmSync(filterMark, { force: true });
    const c = ctx(root);
    // §33.4: the hook reads the folder's state before the card (for the row after the call).
    expect(await preBash(c, "cd vendor/lib && sed -i.bak s/acme/acme2/ lib.txt", root, "b1")).toBe("ask");
    expect(c.scopeWatches?.get("b1")?.targets.map((t) => t.path)).toEqual([nested]);
    // §46 (auto mode: the nested repository is the CLI's call, the git check still runs): a checkout over a changed file
    // there asks; the probe that found it ran nothing of the nested repository's.
    c.permissionMode = "auto";
    write(nested, "lib.txt", "acme changed\n");
    expect(await preBash(c, "git checkout -- lib.txt", nested, "b2")).toBe("ask");
    expect(c.scopeReasons?.get("b2")?.code).toBe("git_command");
    expect(existsSync(filterMark)).toBe(false);
    expect(existsSync(monitorMark)).toBe(false);
  });
});
