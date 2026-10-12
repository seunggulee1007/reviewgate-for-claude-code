import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { applyMcpToggle, emptyToggles, mcpOffBy, mcpOffNames, MCP_REPO_PREFS_FILE } from "../src/mcp/mcpScopes.js";
import { McpFileIndex, mcpOriginOf, mcpRemoveCommand } from "../src/mcp/mcpOrigin.js";
import { MCP_PREFS_FILE, toServerInfo } from "../src/mcp/mcp.js";
import { instructionKind, instructionTarget, subagentList } from "../src/instructions/claudeMd.js";
import type { ClaudeSessionOptions } from "../src/session/claude.js";
import { FakeClaudeSession, fakePlatform, makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §42.3: MCP servers (where they live, a choice for every worktree, the login) and Claude's instructions. */

class FakeMcpSession extends FakeClaudeSession {
  statuses: McpServerStatus[];
  toggles: [string, boolean][] = [];
  reconnects: string[] = [];
  /** What a reconnect turns the server into (the login took in the terminal). */
  onReconnect: (name: string) => void = () => undefined;
  constructor(opts: ClaudeSessionOptions, initial: McpServerStatus[]) {
    super(opts);
    this.statuses = initial.map((s) => ({ ...s }));
  }
  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return this.statuses.map((s) => ({ ...s }));
  }
  async reconnectMcpServer(name: string): Promise<void> {
    this.reconnects.push(name);
    this.onReconnect(name);
  }
  async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    this.toggles.push([name, enabled]);
    const s = this.statuses.find((x) => x.name === name);
    if (s) s.status = enabled ? "connected" : "disabled";
  }
}

const SERVERS: McpServerStatus[] = [
  { name: "parentsrv", status: "connected", scope: "project", config: { type: "stdio", command: "true" } },
  { name: "own", status: "connected", scope: "project", config: { type: "stdio", command: "true" } },
  { name: "ghost", status: "failed", scope: "project", config: { type: "stdio", command: "true" } },
  { name: "github", status: "connected", scope: "user", config: { type: "stdio", command: "npx" } },
  { name: "linear", status: "needs-auth", scope: "project", config: { type: "http", url: "https://mcp.linear.app/mcp" } },
  { name: "plugin:omc:t", status: "connected", scope: "dynamic" as never, config: { type: "stdio", command: "node" } },
];

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** `<ws>/.mcp.json` (parentsrv, linear) above `<ws>/repo` (its own .mcp.json: own). */
function workspace(): { ws: string; repo: string } {
  const ws = realpathSync(makeTempDir("rg-w4d-config"));
  dirs.push(ws);
  writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { parentsrv: { command: "true" }, linear: { type: "http", url: "https://mcp.linear.app/mcp" } } }));
  const repo = join(ws, "repo");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@e.com");
  sh(repo, "config", "user.name", "T");
  write(repo, "a.txt", "a\n");
  write(repo, ".mcp.json", JSON.stringify({ mcpServers: { own: { command: "true" } } }));
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "init");
  return { ws, repo };
}

function setup(extra: { runClaude?: (args: string[], cwd: string) => Promise<{ status: number | null; stdout: string; stderr: string }>; terminal?: [string, string | undefined][]; servers?: McpServerStatus[] } = {}) {
  const mcp: FakeMcpSession[] = [];
  const h = makeHarness({
    mcpPollMs: 30,
    sessionFactory: (o) => {
      const s = new FakeMcpSession(o, extra.servers ?? SERVERS);
      mcp.push(s);
      return s;
    },
    platform: { ...fakePlatform, openTerminal: async (c: string, cwd?: string) => void extra.terminal?.push([c, cwd]) },
    ...(extra.runClaude ? { runClaude: extra.runClaude } : {}),
  });
  harnesses.push(h);
  return { h, mcp };
}

describe("§42.3 helpers", () => {
  it("a choice for this worktree or for every worktree: exceptions, the effective set and who turned it off", () => {
    const t = emptyToggles();
    applyMcpToggle(t, "a", false, "repository");
    expect(mcpOffBy(t, "a")).toBe("repository");
    applyMcpToggle(t, "a", true, "worktree");
    expect(mcpOffBy(t, "a")).toBeNull();
    expect(t.worktreeOn.has("a")).toBe(true);
    applyMcpToggle(t, "a", false, "worktree");
    expect(mcpOffBy(t, "a")).toBe("worktree");
    expect(t.worktreeOn.has("a")).toBe(false);
    applyMcpToggle(t, "a", true, "repository");
    expect(mcpOffBy(t, "a")).toBeNull();
    expect([...mcpOffNames(t)]).toEqual([]);
    applyMcpToggle(t, "b", false, "worktree");
    applyMcpToggle(t, "c", false, "repository");
    expect([...mcpOffNames(t)].sort()).toEqual(["b", "c"]);
  });

  it("finds the .mcp.json that defines a server (the nearest from the project up) and says what can remove it", async () => {
    const { ws, repo } = workspace();
    const index = new McpFileIndex();
    const ctx = { root: repo, claudeJson: "/home/u/.claude.json", index, windows: false };
    const info = (name: string) => toServerInfo(SERVERS.find((s) => s.name === name) as never, { disabled: new Set(), sessionAdded: new Set() });
    expect(await mcpOriginOf(info("parentsrv"), ctx)).toEqual({ file: join(ws, ".mcp.json"), place: "parent", removable: true });
    expect(await mcpOriginOf(info("own"), ctx)).toEqual({ file: join(repo, ".mcp.json"), place: "project", removable: true });
    expect(await mcpOriginOf(info("ghost"), ctx)).toEqual({ file: null, place: null, removable: false, reason: "not_found", command: "claude mcp remove --scope project ghost" });
    expect(await mcpOriginOf(info("github"), ctx)).toEqual({ file: "/home/u/.claude.json", place: "home", removable: true });
    expect(await mcpOriginOf(info("plugin:omc:t"), ctx)).toMatchObject({ removable: false, reason: "plugin" });
    const ro = await mcpOriginOf(info("parentsrv"), { ...ctx, isWritable: async () => false });
    expect(ro).toEqual({ file: join(ws, ".mcp.json"), place: "parent", removable: false, reason: "read_only", command: mcpRemoveCommand("parentsrv", "project", ws, false) });
    expect(mcpRemoveCommand("parentsrv", "project", "/w/workspace", false)).toBe("cd /w/workspace && claude mcp remove --scope project parentsrv");
    expect(mcpRemoveCommand("my srv", "project", "C:\\Work Space", true)).toBe('cd /d "C:\\Work Space" && claude mcp remove --scope project "my srv"');
    expect(mcpRemoveCommand("x", "user", "/a b", false)).toBe("cd '/a b' && claude mcp remove --scope user x");
    // Edited files are read again (mtime / size).
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { linear: {} } }));
    expect(await index.projectFileOf("parentsrv", repo)).toBeNull();
  });

  it("instruction kinds: what each memory file is", () => {
    const ctx = { root: "/w/repo", configDir: "/h/.claude" };
    expect(instructionKind("/h/.claude/CLAUDE.md", "User", ctx)).toBe("user");
    expect(instructionKind("/w/repo/CLAUDE.md", "Project", ctx)).toBe("project");
    expect(instructionKind("/w/repo/.claude/CLAUDE.md", "Project", ctx)).toBe("project");
    expect(instructionKind("/w/repo/CLAUDE.local.md", "Local", ctx)).toBe("local");
    expect(instructionKind("/w/CLAUDE.md", "Project", ctx)).toBe("parent");
    expect(instructionKind("/w/repo/api/CLAUDE.md", "Project", ctx)).toBe("nested");
    expect(instructionKind("/w/repo/.claude/rules/java.md", "Project", ctx)).toBe("rules");
    expect(instructionKind("/h/.claude/projects/-w-repo/memory/MEMORY.md", "AutoMem", ctx)).toBe("auto_memory");
    expect(instructionKind("/Library/Application Support/ClaudeCode/CLAUDE.md", "Managed", ctx)).toBe("managed");
    expect(instructionKind("/elsewhere/notes.md", "Project", ctx)).toBe("other");
  });

  it("instruction targets: CLAUDE.md / CLAUDE.local.md inside the project only", () => {
    const { ws, repo } = workspace();
    expect(instructionTarget(repo, "CLAUDE.md")).toEqual({ abs: join(repo, "CLAUDE.md"), relPath: "CLAUDE.md", kind: "project" });
    expect(instructionTarget(repo, "CLAUDE.local.md")?.kind).toBe("local");
    expect(instructionTarget(repo, "api/CLAUDE.md")?.kind).toBe("nested");
    expect(instructionTarget(repo, join(repo, ".claude", "CLAUDE.md"))?.relPath).toBe(".claude/CLAUDE.md");
    for (const bad of ["../CLAUDE.md", join(ws, "CLAUDE.md"), "README.md", ".git/CLAUDE.md", "", "a\nb/CLAUDE.md", "/etc/CLAUDE.md"]) expect(instructionTarget(repo, bad)).toBeNull();
    // A symlink may only name something inside the project.
    writeFileSync(join(ws, "outside.md"), "x");
    mkdirSync(join(repo, "lnk"));
    symlinkSync(join(ws, "outside.md"), join(repo, "lnk", "CLAUDE.md"));
    expect(instructionTarget(repo, "lnk/CLAUDE.md")).toBeNull();
    writeFileSync(join(repo, "AGENTS.md"), "rules");
    symlinkSync(join(repo, "AGENTS.md"), join(repo, "CLAUDE.md"));
    expect(instructionTarget(repo, "CLAUDE.md")?.kind).toBe("project");
  });

  it("subagents: name, a short description, the model and the file when it is found", () => {
    const { repo } = workspace();
    mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
    writeFileSync(join(repo, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\n---\n");
    const plugin = join(repo, "plug");
    mkdirSync(join(plugin, "agents"), { recursive: true });
    writeFileSync(join(plugin, "agents", "executor.md"), "x");
    const list = subagentList(
      [
        { name: "reviewer", description: "Reviews.", model: "sonnet" },
        { name: "omc:executor", description: `Does ${"work ".repeat(100)}` },
        { name: "general-purpose", description: "Built in" },
        { name: "reviewer", description: "dup" },
        { bogus: true },
      ],
      { root: repo, configDir: "/nonexistent", plugins: [{ name: "omc", path: plugin }] },
    );
    expect(list?.map((a) => [a.name, a.source ?? null, a.path ?? null, a.model ?? null])).toEqual([
      ["reviewer", "project", join(repo, ".claude", "agents", "reviewer.md"), "sonnet"],
      ["omc:executor", "plugin", join(plugin, "agents", "executor.md"), null],
      ["general-purpose", null, null, null],
    ]);
    expect(list![1]!.description.length).toBeLessThanOrEqual(300);
    expect(subagentList("nope", { root: repo, configDir: "/x", plugins: [] })).toBeNull();
  });
});

describe("§42.3 MCP servers in the engine", () => {
  it("mcp_status says where each server lives; a parent folder's server is removed by the CLI run in that folder, only with the confirmed file", async () => {
    const { ws, repo } = workspace();
    const runs: { args: string[]; cwd: string }[] = [];
    const { h } = setup({ runClaude: async (args, cwd) => (runs.push({ args, cwd }), { status: 0, stdout: "Removed", stderr: "" }) });
    await h.hello();
    await h.open(repo);
    const st = await h.engine.request({ type: "mcp_status" });
    const by = (n: string) => st.servers.find((s) => s.name === n)!;
    expect(by("parentsrv").origin).toEqual({ file: join(ws, ".mcp.json"), place: "parent", removable: true });
    expect(by("own").origin).toMatchObject({ file: join(repo, ".mcp.json"), place: "project", removable: true });
    expect(by("ghost").origin).toMatchObject({ removable: false, reason: "not_found" });
    expect(st.repositoryToggle).toBe(true);
    // Without `file` (an older client): the project's own .mcp.json as before.
    await h.engine.request({ type: "mcp_remove", name: "parentsrv", scope: "project" });
    expect(runs.at(-1)).toEqual({ args: ["mcp", "remove", "--scope", "project", "parentsrv"], cwd: repo });
    await h.engine.request({ type: "mcp_remove", name: "parentsrv", scope: "project", file: join(ws, ".mcp.json") });
    expect(runs.at(-1)).toEqual({ args: ["mcp", "remove", "--scope", "project", "parentsrv"], cwd: ws });
    await expect(h.engine.request({ type: "mcp_remove", name: "parentsrv", scope: "project", file: join(repo, ".mcp.json") })).rejects.toThrow(/mcp_origin_changed/);
    expect(runs).toHaveLength(2);
  });

  it("mcp_toggle {scope: repository} reaches every worktree of the repository; a worktree can keep it on for itself", async () => {
    const { ws, repo } = workspace();
    const linked = join(ws, "linked");
    sh(repo, "worktree", "add", "-q", "-b", "feat", linked);
    const a = setup();
    await a.h.hello();
    await a.h.open(repo);
    const off = await a.h.engine.request({ type: "mcp_toggle", name: "github", enabled: false, scope: "repository" });
    expect(off.servers.find((s) => s.name === "github")).toMatchObject({ status: "disabled", disabledByUser: true, disabledIn: "repository" });
    const repoFile = join(repo, ".git", MCP_REPO_PREFS_FILE);
    expect(JSON.parse(readFileSync(repoFile, "utf8"))).toEqual({ version: 1, disabled: ["github"] });
    // This worktree's own file is not where the repository's choice lives.
    const own = join(repo, ".git", MCP_PREFS_FILE);
    expect(existsSync(own) ? JSON.parse(readFileSync(own, "utf8")).disabled : []).toEqual([]);

    const b = setup();
    await b.h.hello();
    await b.h.open(linked);
    await b.h.waitFor(() => b.mcp[0]!.toggles.some(([n, on]) => n === "github" && !on), "the linked worktree turns github off");
    const bs = await b.h.engine.request({ type: "mcp_status" });
    expect(bs.servers.find((s) => s.name === "github")).toMatchObject({ disabledByUser: true, disabledIn: "repository" });

    // On again for every worktree: the other window follows on its next poll.
    await a.h.engine.request({ type: "mcp_toggle", name: "github", enabled: true, scope: "repository" });
    await b.h.waitFor(() => b.mcp[0]!.toggles.some(([n, on]) => n === "github" && on), "the linked worktree turns github on again");

    // Off for the repository, on in the linked worktree only (an exception kept in its own file).
    await a.h.engine.request({ type: "mcp_toggle", name: "github", enabled: false, scope: "repository" });
    await b.h.waitFor(() => b.mcp[0]!.statuses.find((s) => s.name === "github")!.status === "disabled", "off again");
    const kept = await b.h.engine.request({ type: "mcp_toggle", name: "github", enabled: true });
    expect(kept.servers.find((s) => s.name === "github")).toMatchObject({ status: "connected", disabledByUser: false });
    const linkedGitDir = sh(linked, "rev-parse", "--git-dir").trim();
    // Windows: git prints a linked worktree's git dir as "C:/…/.git/worktrees/linked" — absolute without a leading "/".
    const linkedPrefs = join(resolve(linked, linkedGitDir), MCP_PREFS_FILE);
    await b.h.waitFor(() => existsSync(linkedPrefs) && JSON.parse(readFileSync(linkedPrefs, "utf8")).enabled?.includes("github"), "the exception is saved");
    expect(JSON.parse(readFileSync(linkedPrefs, "utf8"))).toEqual({ version: 1, disabled: [], enabled: ["github"] });
  });

  it("mcp_auth: the terminal starts in the project, the server waits for the login and the polls reconnect it until it connects", async () => {
    const { repo } = workspace();
    const terminal: [string, string | undefined][] = [];
    const { h, mcp } = setup({ terminal });
    await h.hello();
    await h.open(repo);
    await h.engine.request({ type: "mcp_status" });
    await h.engine.request({ type: "mcp_auth", name: "linear" });
    expect(terminal).toEqual([[`cd '${repo}' && claude /mcp`, repo]]);
    const waiting = await h.engine.request({ type: "mcp_status" });
    expect(waiting.servers.find((s) => s.name === "linear")).toMatchObject({ status: "needs-auth", authWaiting: true });
    // The login has not happened yet: the reconnect leaves it needing one; then it takes.
    await h.waitFor(() => mcp[0]!.reconnects.includes("linear"), "a reconnect after the login");
    mcp[0]!.onReconnect = (name) => {
      const s = mcp[0]!.statuses.find((x) => x.name === name);
      if (s) s.status = "connected";
    };
    await h.waitFor(() => h.engine.state.session.extensions?.mcpServers.some((s) => s.name === "linear" && s.status === "connected") === true, "connected");
    const done = await h.engine.request({ type: "mcp_status" });
    expect(done.servers.find((s) => s.name === "linear")!.authWaiting).toBeUndefined();
    const n = mcp[0]!.reconnects.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(mcp[0]!.reconnects.length).toBe(n); // connected: no more reconnects
  });
});

describe("§42.3 Claude's instructions in the engine", () => {
  it("projectInstructions, memory file kinds and agents in the extensions", async () => {
    const { repo } = workspace();
    const { h, mcp } = setup();
    await h.hello();
    const s = await h.open(repo);
    expect(s.session.extensions?.projectInstructions).toEqual([
      { path: join(repo, "CLAUDE.md"), relPath: "CLAUDE.md", kind: "project", exists: false },
      { path: join(repo, "CLAUDE.local.md"), relPath: "CLAUDE.local.md", kind: "local", exists: false },
    ]);
    mcp.at(-1)!.emit({ type: "extensions_info", memoryFiles: [{ path: join(repo, "CLAUDE.md"), type: "Project", tokens: 5 }, { path: "/nonexistent/reviewgate-test-claude-config/CLAUDE.md", type: "User" }] });
    await h.waitFor((st) => st.session.extensions?.memoryFiles !== null, "memory files");
    expect(h.engine.state.session.extensions?.memoryFiles).toEqual([
      { path: join(repo, "CLAUDE.md"), type: "Project", tokens: 5, kind: "project", editable: true },
      { path: "/nonexistent/reviewgate-test-claude-config/CLAUDE.md", type: "User", kind: "user" },
    ]);
    mcp.at(-1)!.emit({ type: "agents_info", agents: [{ name: "Explore", description: "Fast read-only search.", model: "haiku" }] });
    await h.waitFor((st) => (st.session.extensions?.agents?.length ?? 0) === 1, "agents");
    expect(h.engine.state.session.extensions?.agents).toEqual([{ name: "Explore", description: "Fast read-only search.", model: "haiku" }]);
  });

  it("claude_md_read / claude_md_write: create, save over what was read, refuse a stale base, a path outside, a file in the review and a running turn", async () => {
    const { repo } = workspace();
    const { h, mcp } = setup();
    await h.hello();
    await h.open(repo);
    const missing = await h.engine.request({ type: "claude_md_read", path: "CLAUDE.md" });
    expect(missing).toMatchObject({ type: "claude_md", path: join(repo, "CLAUDE.md"), relPath: "CLAUDE.md", kind: "project", text: "", sha: null, exists: false });
    const created = await h.engine.request({ type: "claude_md_write", path: "CLAUDE.md", text: "# Rules\n- Use Korean.\n", baseSha: null });
    expect(created).toMatchObject({ exists: true, saved: true });
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("# Rules\n- Use Korean.\n");
    await h.waitFor((st) => st.session.extensions?.projectInstructions?.[0]?.exists === true && st.branches.isWorktreeDirty, "exists + dirty");
    await expect(h.engine.request({ type: "claude_md_write", path: "CLAUDE.md", text: "x", baseSha: null })).rejects.toThrow(/claude_md_changed/);
    const read = await h.engine.request({ type: "claude_md_read", path: join(repo, "CLAUDE.md") });
    expect(read.sha).toBe(created.sha);
    writeFileSync(join(repo, "CLAUDE.md"), "changed in the editor\n");
    await expect(h.engine.request({ type: "claude_md_write", path: "CLAUDE.md", text: "mine", baseSha: read.sha })).rejects.toThrow(/claude_md_changed/);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("changed in the editor\n");
    await expect(h.engine.request({ type: "claude_md_read", path: "../CLAUDE.md" })).rejects.toThrow(/invalid_path/);
    await expect(h.engine.request({ type: "claude_md_write", path: "a.txt", text: "x", baseSha: null })).rejects.toThrow(/invalid_path/);

    // Claude changes CLAUDE.local.md in a turn: while it is in the review the app does not save over it.
    await h.engine.handle({ type: "send", text: "add a local rule" });
    await expect(h.engine.request({ type: "claude_md_write", path: "CLAUDE.local.md", text: "x", baseSha: null })).rejects.toThrow(/session_busy/);
    write(repo, "CLAUDE.local.md", "by claude\n");
    mcp.at(-1)!.emitTurnEnd({ toolFiles: [{ path: join(repo, "CLAUDE.local.md"), tools: ["Write"], count: 1, toolUseIds: ["w1"] }] });
    await h.waitFor((st) => st.gate.phase === "reviewing", "reviewing");
    const local = await h.engine.request({ type: "claude_md_read", path: "CLAUDE.local.md" });
    await expect(h.engine.request({ type: "claude_md_write", path: "CLAUDE.local.md", text: "mine", baseSha: local.sha })).rejects.toThrow(/in_review/);
    // CLAUDE.md is not in the review: saving it goes on.
    const latest = await h.engine.request({ type: "claude_md_read", path: "CLAUDE.md" });
    await h.engine.request({ type: "claude_md_write", path: "CLAUDE.md", text: "final\n", baseSha: latest.sha });
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("final\n");
  });
});
