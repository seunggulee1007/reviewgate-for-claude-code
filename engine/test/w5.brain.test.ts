import { mkdirSync, realpathSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  autoMemoryDir,
  canonicalRepoRoot,
  memoryTypeOf,
  parseIndex,
  parseMemory,
  projectKey,
  SubBrain,
} from "../src/brain/subBrain.js";
import { realpathLenient } from "../src/platform/paths.js";
import { makeHarness } from "./helpers/engine.js";
import { makeRepo, makeTempDir, removeDir, sh } from "./helpers/repo.js";
import { WAIT_MS } from "./helpers/wait.js";

/** docs/PROTOCOL.md §43.2: the sub-brain — Claude Code's auto memory of the repository, read only. */

const dirs: string[] = [];
function temp(prefix: string): string {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) removeDir(dirs.pop()!);
});

/** Java's String.hashCode, computed with BigInt (an independent spelling of the CLI's 32-bit hash). */
function javaHash(s: string): number {
  let h = 0n;
  for (let i = 0; i < s.length; i++) h = (h * 31n + BigInt(s.charCodeAt(i))) % 2n ** 32n;
  return Number(h >= 2n ** 31n ? h - 2n ** 32n : h);
}

function memo(dir: string, name: string, front: Record<string, string>, body = "", nestedType?: string): void {
  const lines = ["---", ...Object.entries(front).map(([k, v]) => `${k}: ${v}`)];
  if (nestedType) lines.push("metadata:", "  node_type: memory", `  type: ${nestedType}`);
  lines.push("---", "", body);
  writeFileSync(join(dir, `${name}.md`), lines.join("\n"));
}

describe("where the CLI keeps the memory (CLI 2.1.310)", () => {
  it("names the project folder as the CLI does", () => {
    expect(projectKey("/Users/dev/src/acme")).toBe("-Users-dev-src-acme");
    expect(projectKey("C:\\work\\my repo")).toBe("C--work-my-repo");
    const long = `/x/${"a".repeat(240)}`;
    const key = projectKey(long);
    expect(key).toBe(`${long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-${Math.abs(javaHash(long)).toString(36)}`);
  });

  it("a linked worktree and a subfolder use the main checkout's folder", () => {
    // The engine's own real-path spelling (Windows: long names, the on-disk case).
    const main = realpathLenient(makeRepo());
    dirs.push(main);
    const wt = join(temp("rg-brain-wt"), "linked");
    sh(main, "worktree", "add", "-q", wt, "-b", "linked");
    mkdirSync(join(main, "src", "deep"), { recursive: true });
    expect(canonicalRepoRoot(main)).toBe(main);
    expect(canonicalRepoRoot(join(main, "src", "deep"))).toBe(main);
    expect(canonicalRepoRoot(wt)).toBe(main);
    expect(canonicalRepoRoot(temp("rg-brain-none"))).toBeNull();
  });

  it("prefers the MEMORY.md the CLI loaded, then autoMemoryDirectory, then the CLI's rule", () => {
    const config = temp("rg-brain-config");
    const project = temp("rg-brain-project");
    const fromCli = join(config, "projects", "-elsewhere", "memory", "MEMORY.md");
    expect(autoMemoryDir({ projectPath: project, configDir: config, env: {}, cliMemoryFiles: [{ path: join(project, "CLAUDE.md"), type: "Project" }, { path: fromCli, type: "AutoMem" }] }))
      .toEqual({ dir: join(config, "projects", "-elsewhere", "memory"), source: "cli" });
    // A CLAUDE.md is not the memory folder.
    expect(autoMemoryDir({ projectPath: project, configDir: config, env: {}, cliMemoryFiles: [{ path: join(project, "CLAUDE.md"), type: "Project" }] })?.source).toBe("default");
    writeFileSync(join(config, "settings.json"), JSON.stringify({ autoMemoryDirectory: "~/notes/brain" }));
    expect(autoMemoryDir({ projectPath: project, configDir: config, env: {}, home: "/home/me" })).toEqual({ dir: resolve("/home/me", "notes", "brain"), source: "settings" });
    writeFileSync(join(config, "settings.json"), JSON.stringify({ autoMemoryDirectory: "relative/no" }));
    const key = projectKey(realpathLenient(project));
    expect(autoMemoryDir({ projectPath: project, configDir: config, env: {} })).toEqual({ dir: join(config, "projects", key, "memory"), source: "default" });
    expect(autoMemoryDir({ projectPath: project, configDir: config, env: { CLAUDE_CODE_REMOTE_MEMORY_DIR: "/remote" } })?.dir).toBe(join("/remote", "projects", key, "memory"));
  });
});

describe("reading a memory", () => {
  it("frontmatter: name, description, type at the top or under metadata; else the file name's prefix", () => {
    const nested = parseMemory("x", "---\nname: small-commits\ndescription: \"작게 커밋\"\nmetadata: \n  node_type: memory\n  type: feedback\n---\nbody");
    expect(nested).toMatchObject({ title: "small-commits", description: "작게 커밋", type: "feedback" });
    expect(parseMemory("x", "---\nname: a\ntype: reference\n---\n").type).toBe("reference");
    expect(parseMemory("project_alpha", "no frontmatter").type).toBe("project");
    expect(parseMemory("user-role", "").type).toBe("user");
    expect(parseMemory("notes", "---\ntype: weird\n---\n").type).toBe("other");
    expect(memoryTypeOf("Feedback")).toBe("feedback");
    expect(parseMemory("x", `---\ndescription: ${"가".repeat(400)}\n---\n`).description.length).toBe(300);
  });

  it("[[links]]: the target before | or #, deduplicated, at most 50", () => {
    const body = "See [[feedback-polite-korean]] and [[project_x|the alias]], [[ref#Heading]], again [[project_x]] and [[a.md]]";
    expect(parseMemory("x", body).links).toEqual(["feedback-polite-korean", "project_x", "ref", "a"]);
    const many = Array.from({ length: 80 }, (_, i) => `[[m${i}]]`).join(" ");
    expect(parseMemory("x", many).links).toHaveLength(50);
  });

  it("MEMORY.md: Markdown links to .md files and [[links]]", () => {
    expect(parseIndex("# Memory Index\n- [짧게 답](feedback_short_answers.md) — 요약\n- [x](./sub/project_b.md)\n- [[reference_c]]\n- [web](https://x.y)"))
      .toEqual(["feedback_short_answers", "project_b", "reference_c"]);
  });
});

describe("SubBrain", () => {
  function brain(dir: string, clock: { t: number }) {
    return new SubBrain({ now: () => clock.t, onChange: () => undefined, pollMs: 60_000 });
  }

  it("the first scan is the baseline; later scans list what was added, changed and removed, and who wrote it", async () => {
    const mem = join(temp("rg-brain-mem"), "memory");
    mkdirSync(mem);
    memo(mem, "feedback_small_commits", { name: "small-commits", description: "작게 커밋" }, "see [[project_alpha]] and [[gone]]", "feedback");
    memo(mem, "project_alpha", { name: "alpha", description: "알파" }, "");
    writeFileSync(join(mem, "MEMORY.md"), "- [small-commits](feedback_small_commits.md)\n- [old](reference_old.md)\n");
    const clock = { t: 1000 };
    const b = brain(mem, clock);
    b.setDir({ dir: mem, source: "default" });
    await b.scan();
    let snap = b.snapshot();
    expect(snap.baselineAt).toBe(1000);
    expect(snap.changes).toEqual([]);
    expect(snap.counts).toMatchObject({ feedback: 1, project: 1, user: 0 });
    expect(snap.hasIndex).toBe(true);
    expect(snap.unindexed).toEqual(["project_alpha"]);
    expect(snap.missing).toEqual(["reference_old"]);
    expect(snap.brokenLinks).toEqual([{ from: "feedback_small_commits", to: "gone" }]);
    expect(snap.memories.find((m) => m.name === "feedback_small_commits")?.links).toEqual(["project_alpha"]);

    // Claude writes one (a Write tool call), a subagent edits another, a shell removes nothing yet.
    clock.t = 2000;
    b.onToolUse("t1", "Write", { file_path: join(mem, "user_role.md") }, { by: "main" });
    memo(mem, "user_role", { name: "role", description: "역할" }, "");
    b.onToolUse("t2", "Edit", { file_path: join(mem, "project_alpha.md") }, { by: "agent", agentType: "oh-my-claudecode:executor" });
    memo(mem, "project_alpha", { name: "alpha", description: "알파 2" }, "longer body now");
    utimesSync(join(mem, "project_alpha.md"), new Date(5000), new Date(5000));
    b.onToolResult("t1", false);
    b.onToolResult("t2", false);
    await b.scan();
    snap = b.snapshot();
    expect(snap.changes.map((c) => [c.kind, c.name, c.by, c.agentType])).toEqual([
      ["add", "user_role", "main", undefined],
      ["change", "project_alpha", "agent", "oh-my-claudecode:executor"],
    ]);
    expect(snap.sessionCount).toBe(2);
    expect(snap.memories.find((m) => m.name === "user_role")?.session).toBe("add");

    // Removed by a shell: nobody the engine saw.
    clock.t = 3000;
    unlinkSync(join(mem, "feedback_small_commits.md"));
    await b.scan();
    snap = b.snapshot();
    expect(snap.changes[0]).toMatchObject({ kind: "remove", name: "feedback_small_commits", type: "feedback", title: "small-commits", by: "external" });
    expect(snap.tally).toEqual({ add: 1, change: 1, remove: 1 });
    // A denied write leaves no writer behind: the next change is external.
    b.onToolUse("t3", "Write", { file_path: join(mem, "user_role.md") }, { by: "main" });
    b.onToolResult("t3", true);
    memo(mem, "user_role", { name: "role", description: "역할 바뀜" }, "x");
    utimesSync(join(mem, "user_role.md"), new Date(9000), new Date(9000));
    await b.scan();
    expect(b.snapshot().changes[0]).toMatchObject({ kind: "change", name: "user_role", by: "external" });
  });

  it("a missing folder is empty, not an error; files appearing later are added", async () => {
    const mem = join(temp("rg-brain-missing"), "memory");
    const b = brain(mem, { t: 1 });
    b.setDir({ dir: mem, source: "default" });
    await b.scan();
    expect(b.snapshot()).toMatchObject({ dir: mem, exists: false, memories: [] });
    expect(b.snapshot().error).toBeUndefined();
    mkdirSync(mem);
    memo(mem, "reference_a", { description: "참고" }, "");
    await b.scan();
    expect(b.snapshot().changes).toMatchObject([{ kind: "add", name: "reference_a", type: "reference", by: "external" }]);
  });

  // Windows needs a privilege to make a symlink (and has no O_NOFOLLOW); the listing's rule is the same there.
  it.skipIf(process.platform === "win32")("never follows a symlink and never reads outside the folder", async () => {
    const root = temp("rg-brain-sym");
    const mem = join(root, "memory");
    mkdirSync(mem);
    writeFileSync(join(root, "secret.md"), "---\ndescription: outside\n---\n");
    symlinkSync(join(root, "secret.md"), join(mem, "linked.md"));
    memo(mem, "project_ok", { description: "ok" }, "body");
    const b = brain(mem, { t: 1 });
    b.setDir({ dir: mem, source: "default" });
    await b.scan();
    expect(b.snapshot().memories.map((m) => m.name)).toEqual(["project_ok"]);
    await expect(b.read("linked")).rejects.toThrow(/not_found/);
    await expect(b.read("../secret")).rejects.toThrow(/invalid_name/);
    await expect(b.read("MEMORY")).rejects.toThrow(/not_found/);
    const r = await b.read("project_ok");
    expect(r).toMatchObject({ type: "brain_memory", name: "project_ok", path: join(mem, "project_ok.md") });
    expect(r.text).toContain("body");
  });

  it("caps a file at 64 KiB (read as far as that) and the folder at 2 000 files", async () => {
    const mem = join(temp("rg-brain-big"), "memory");
    mkdirSync(mem);
    memo(mem, "project_big", { description: "big" }, `[[project_x]] ${"x".repeat(70 * 1024)}`);
    const b = new SubBrain({ now: () => 1, onChange: () => undefined, pollMs: 60_000, maxFiles: 3 });
    for (const n of ["a", "b", "c"]) memo(mem, `reference_${n}`, { description: n }, "");
    b.setDir({ dir: mem, source: "default" });
    await b.scan();
    const snap = b.snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.memories).toHaveLength(3);
    const big = await new SubBrain({ now: () => 1, onChange: () => undefined, pollMs: 60_000 });
    big.setDir({ dir: mem, source: "default" });
    await big.scan();
    expect(big.snapshot().memories.find((m) => m.name === "project_big")?.description).toBe("big");
    const read = await big.read("project_big");
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("the engine's brain command", () => {
  it("finds the repository's folder under CLAUDE_CONFIG_DIR, reads it, and attributes a subagent's write", async () => {
    const repo = realpathLenient(makeRepo());
    dirs.push(repo);
    const config = temp("rg-brain-cfg");
    const mem = join(config, "projects", projectKey(repo), "memory");
    mkdirSync(mem, { recursive: true });
    memo(mem, "project_alpha", { name: "alpha", description: "알파" }, "");
    writeFileSync(join(mem, "MEMORY.md"), "- [alpha](project_alpha.md)\n");
    const h = makeHarness({ env: { CLAUDE_CONFIG_DIR: config } });
    await h.hello();
    await h.open(repo);
    const first = await h.engine.request({ type: "brain", watch: true });
    expect(first).toMatchObject({ type: "brain", dir: mem, dirSource: "default", exists: true, hasIndex: true, watching: true });
    expect(first.memories.map((m) => m.name)).toEqual(["project_alpha"]);

    // An agent (Agent tool) writes a memory: the change names its type.
    const s = h.session();
    s.emit({ type: "tool_use", id: "agent-1", name: "Agent", input: { subagent_type: "oh-my-claudecode:writer", description: "d", prompt: "p" } });
    s.emit({ type: "tool_use", id: "w-1", name: "Write", input: { file_path: join(mem, "reference_new.md"), content: "x" }, parentToolUseId: "agent-1", file: join(mem, "reference_new.md") });
    memo(mem, "reference_new", { name: "new", description: "새것" }, "");
    s.emit({ type: "tool_result", toolUseId: "w-1", isError: false, preview: "ok", parentToolUseId: "agent-1" });
    const deadline = Date.now() + WAIT_MS;
    let changed: ReturnType<typeof h.ofType<"brain">>[number] | undefined;
    while (Date.now() < deadline) {
      changed = h.ofType("brain").find((e) => e.id === undefined && e.changes.length > 0);
      if (changed) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(changed?.changes[0]).toMatchObject({ kind: "add", name: "reference_new", by: "agent", agentType: "oh-my-claudecode:writer" });

    const text = await h.engine.request({ type: "brain_read", name: "reference_new" });
    expect(text.text).toContain("새것");
    await expect(h.engine.request({ type: "brain_read", name: "../x" })).rejects.toThrow(/invalid_name/);
    const stopped = await h.engine.request({ type: "brain", watch: false });
    expect(stopped.watching).toBe(false);
    await h.engine.dispose();
  });
});
