import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerStatus, McpSetServersResult } from "@anthropic-ai/claude-agent-sdk";
import { mcpAddArgs, mcpRemoveArgs, redactArgs, redactUrl, toServerInfo, validateMcpConfig, MCP_PREFS_FILE } from "../src/mcp/mcp.js";
import type { ClaudeSessionOptions } from "../src/session/claude.js";
import { FakeClaudeSession, fakePlatform, makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §22: MCP status / reconnect / toggle / add / remove / auth. */

class FakeMcpSession extends FakeClaudeSession {
  statuses: McpServerStatus[] = [];
  toggles: [string, boolean][] = [];
  reconnects: string[] = [];
  setCalls: Record<string, unknown>[] = [];
  statusCalls = 0;
  constructor(opts: ClaudeSessionOptions, initial: McpServerStatus[]) {
    super(opts);
    this.statuses = initial.map((s) => ({ ...s }));
  }
  async mcpServerStatus(): Promise<McpServerStatus[]> {
    this.statusCalls += 1;
    return this.statuses.map((s) => ({ ...s }));
  }
  async reconnectMcpServer(name: string): Promise<void> {
    if (!this.statuses.some((s) => s.name === name)) throw new Error(`Server not found: ${name}`);
    this.reconnects.push(name);
  }
  async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    this.toggles.push([name, enabled]);
    const s = this.statuses.find((x) => x.name === name);
    if (s) s.status = enabled ? "connected" : "disabled";
  }
  async setMcpServers(servers: Record<string, unknown>): Promise<McpSetServersResult> {
    this.setCalls.push(servers);
    this.statuses = this.statuses.filter((s) => s.scope !== "dynamic");
    for (const name of Object.keys(servers)) this.statuses.push({ name, status: "connected", scope: "dynamic", config: servers[name] as never, tools: [] });
    return { added: Object.keys(servers), removed: [], errors: {} };
  }
}

const SERVERS: McpServerStatus[] = [
  { name: "github", status: "connected", scope: "user", config: { type: "stdio", command: "npx", args: ["-y", "gh-mcp", "--token", "ghp_secretvalue"], env: { GITHUB_TOKEN: "ghp_SECRET" } }, tools: [{ name: "create_issue" }, { name: "list_prs" }], serverInfo: { name: "gh", version: "1.0" } },
  { name: "linear", status: "needs-auth", scope: "project", config: { type: "http", url: "https://mcp.linear.app/mcp?api_key=abc123", headers: { Authorization: "Bearer xyz" } } },
  { name: "plugin:omc:t", status: "failed", scope: "dynamic" as never, error: "spawn ENOENT", config: { type: "stdio", command: "node", args: ["x.js"] } },
];

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-mcp"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@e.com");
  sh(dir, "config", "user.name", "T");
  write(dir, "a.txt", "a\n");
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

function setup(extra: { runClaude?: (args: string[], cwd: string) => Promise<{ status: number | null; stdout: string; stderr: string }>; terminal?: string[] } = {}) {
  const mcp: FakeMcpSession[] = [];
  const h = makeHarness({
    mcpPollMs: 30,
    sessionFactory: (o) => {
      const s = new FakeMcpSession(o, SERVERS);
      mcp.push(s);
      return s;
    },
    platform: { ...fakePlatform, openTerminal: async (c: string) => void extra.terminal?.push(c) },
    ...(extra.runClaude ? { runClaude: extra.runClaude } : {}),
  });
  harnesses.push(h);
  return { h, mcp };
}

describe("MCP helpers", () => {
  it("redacts env / header values, secret args and URL credentials", () => {
    const info = toServerInfo(SERVERS[0] as never, { disabled: new Set(), sessionAdded: new Set() });
    expect(info).toMatchObject({ name: "github", status: "connected", source: "user", transport: "stdio", toolCount: 2, tools: ["create_issue", "list_prs"], serverInfo: { name: "gh", version: "1.0" } });
    expect(info.config).toEqual({ command: "npx", args: ["-y", "gh-mcp", "--token", "***"], envKeys: ["GITHUB_TOKEN"] });
    expect(JSON.stringify(info)).not.toContain("ghp_");
    const remote = toServerInfo(SERVERS[1] as never, { disabled: new Set(["linear"]), sessionAdded: new Set() });
    expect(remote.config).toEqual({ url: "https://mcp.linear.app/mcp?api_key=***", headerKeys: ["Authorization"] });
    expect(remote.disabledByUser).toBe(true);
    expect(remote.toolCount).toBeNull();
    expect(toServerInfo(SERVERS[2] as never, { disabled: new Set(), sessionAdded: new Set() }).source).toBe("plugin");
    expect(redactUrl("https://user:pw@h.example/x?token=1&q=ok")).toBe("https://h.example/x?token=***&q=ok");
    expect(redactArgs(["API_KEY=abc", "--password=x", "plain"])).toEqual(["API_KEY=***", "--password=x".replace("=x", "=***"), "plain"]);
  });

  it("validates configs and builds claude mcp argv without a shell", () => {
    expect(() => validateMcpConfig({ type: "stdio", command: "" })).toThrow(/invalid_mcp_config:command/);
    expect(() => validateMcpConfig({ type: "stdio", command: "x", env: { "BAD KEY": "v" } })).toThrow(/invalid_mcp_config:env/);
    expect(() => validateMcpConfig({ type: "http", url: "file:///etc/passwd" })).toThrow(/invalid_mcp_config:url/);
    expect(() => validateMcpConfig({ type: "http", url: "https://x", headers: { A: "b\nc" } })).toThrow(/invalid_mcp_config:header/);
    expect(() => validateMcpConfig({ type: "ws", url: "https://x" })).toThrow(/invalid_mcp_config:type/);
    const stdio = validateMcpConfig({ command: "npx", args: ["-y", "srv; rm -rf /"], env: { K: "v" } });
    expect(mcpAddArgs("srv", "user", stdio)).toEqual(["mcp", "add", "--scope", "user", "--transport", "stdio", "srv", "--env", "K=v", "--", "npx", "-y", "srv; rm -rf /"]);
    expect(mcpAddArgs("web", "project", validateMcpConfig({ type: "http", url: "https://m.example/mcp", headers: { "X-Key": "1" } }))).toEqual(["mcp", "add", "--scope", "project", "--transport", "http", "web", "https://m.example/mcp", "--header", "X-Key: 1"]);
    expect(mcpRemoveArgs("web", "project")).toEqual(["mcp", "remove", "--scope", "project", "web"]);
  });
});

describe("MCP in the engine (§22)", () => {
  it("mcp_status lists the live servers (redacted), raises mcp_auth_required once, and polls only emit on change", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const { h, mcp } = setup();
    await h.hello();
    await h.open(dir);
    const st = await h.engine.request({ type: "mcp_status" });
    expect(st.type).toBe("mcp_status");
    expect(st.servers.map((s) => [s.name, s.status, s.source])).toEqual([["github", "connected", "user"], ["linear", "needs-auth", "project"], ["plugin:omc:t", "failed", "plugin"]]);
    expect(JSON.stringify(h.events)).not.toContain("ghp_SECRET");
    expect(JSON.stringify(h.events)).not.toContain("Bearer xyz");
    const auth = h.ofType("error").filter((e) => e.code === "mcp_auth_required");
    expect(auth).toHaveLength(1);
    expect(auth[0]!.server).toBe("linear");
    const n = h.ofType("mcp_status").length;
    const calls = mcp[0]!.statusCalls;
    await h.waitFor(() => mcp[0]!.statusCalls >= calls + 2, "two more polls");
    await h.settle();
    expect(h.ofType("mcp_status").length).toBe(n); // no change → no event
    mcp[0]!.statuses[2]!.status = "connected";
    // `> n`, not `=== n + 1`: under load a poll tick joins the round still in flight and emits its event too, so the
    // count can step from n to n + 2 between two looks — every event after n must carry the change.
    await h.waitFor(() => h.ofType("mcp_status").length > n, "a change is emitted");
    expect(h.ofType("mcp_status").slice(n).every((e) => e.servers.some((s) => s.name === "plugin:omc:t" && s.status === "connected"))).toBe(true);
    await h.settle();
    expect(h.engine.state.session.extensions?.mcpServers).toContainEqual({ name: "plugin:omc:t", status: "connected" });
  });

  it("mcp_toggle is session-level, persisted per project and re-applied at the next session start; mcp_reconnect", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const { h, mcp } = setup();
    await h.hello();
    await h.open(dir);
    const off = await h.engine.request({ type: "mcp_toggle", name: "github", enabled: false });
    expect(off.servers.find((s) => s.name === "github")).toMatchObject({ status: "disabled", disabledByUser: true });
    expect(mcp[0]!.toggles).toEqual([["github", false]]);
    const prefs = join(dir, ".git", MCP_PREFS_FILE);
    const readPrefs = () => (existsSync(prefs) ? JSON.parse(readFileSync(prefs, "utf8")) : null);
    await h.waitFor(() => readPrefs()?.disabled?.length === 1, "prefs written");
    expect(readPrefs()).toEqual({ version: 1, disabled: ["github"] });
    await h.engine.request({ type: "restart_session" });
    await h.waitFor(() => mcp.length === 2 && mcp[1]!.toggles.length > 0, "re-applied");
    expect(mcp[1]!.toggles).toEqual([["github", false]]);
    await h.engine.request({ type: "mcp_reconnect", name: "linear" });
    expect(mcp[1]!.reconnects).toEqual(["linear"]);
    await expect(h.engine.request({ type: "mcp_reconnect", name: "nope" })).rejects.toThrow(/mcp_failed:Server not found/);
    await h.engine.request({ type: "mcp_toggle", name: "github", enabled: true });
    await h.waitFor(() => readPrefs()?.disabled?.length === 0, "prefs cleared");
  });

  it("mcp_add / mcp_remove: session scope through setMcpServers, project / user scope through the claude CLI", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const runs: { args: string[]; cwd: string }[] = [];
    const { h, mcp } = setup({
      runClaude: async (args, cwd) => {
        runs.push({ args, cwd });
        if (args[1] === "add" && args.includes("project")) write(cwd, ".mcp.json", JSON.stringify({ mcpServers: {} }));
        return args.includes("broken") ? { status: 1, stdout: "", stderr: "Error: MCP server broken already exists\n" } : { status: 0, stdout: "Added", stderr: "" };
      },
    });
    await h.hello();
    await h.open(dir);
    const added = await h.engine.request({ type: "mcp_add", name: "local-srv", scope: "session", config: { type: "stdio", command: "node", args: ["srv.js"], env: { TOKEN: "s3cret" } } });
    expect(mcp[0]!.setCalls.at(-1)).toEqual({ "local-srv": { type: "stdio", command: "node", args: ["srv.js"], env: { TOKEN: "s3cret" } } });
    expect(added.servers.find((s) => s.name === "local-srv")).toMatchObject({ source: "session", sessionAdded: true, config: { envKeys: ["TOKEN"] } });
    expect(JSON.stringify(added)).not.toContain("s3cret");
    await h.engine.request({ type: "mcp_remove", name: "local-srv", scope: "session" });
    expect(mcp[0]!.setCalls.at(-1)).toEqual({});
    await expect(h.engine.request({ type: "mcp_remove", name: "local-srv", scope: "session" })).rejects.toThrow(/unknown_mcp_server/);

    const proj = await h.engine.request({ type: "mcp_add", name: "web", scope: "project", config: { type: "http", url: "https://m.example/mcp" } });
    expect(runs[0]).toEqual({ args: ["mcp", "add", "--scope", "project", "--transport", "http", "web", "https://m.example/mcp"], cwd: dir });
    expect(proj.restartRequired).toBe(true);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    await h.waitFor((s) => s.branches.isWorktreeDirty, "worktree dirty after .mcp.json");
    await h.engine.request({ type: "mcp_remove", name: "web", scope: "user" });
    expect(runs[1]!.args).toEqual(["mcp", "remove", "--scope", "user", "web"]);
    await expect(h.engine.request({ type: "mcp_add", name: "broken", scope: "user", config: { command: "x" } })).rejects.toThrow(/mcp_cli_failed:Error: MCP server broken already exists/);
    await expect(h.engine.request({ type: "mcp_add", name: "bad name", scope: "user", config: { command: "x" } })).rejects.toThrow(/invalid_mcp_name/);
    // §36.6: `local` is a scope now (engine.localSettings.test.ts); anything else is still refused.
    await expect(h.engine.request({ type: "mcp_add", name: "x", scope: "elsewhere" as never, config: { command: "x" } })).rejects.toThrow(/invalid_mcp_scope/);
    // A new session clears restartRequired.
    await h.engine.request({ type: "restart_session" });
    expect((await h.engine.request({ type: "mcp_status" })).restartRequired).toBe(false);
  });

  it("mcp_auth opens a terminal running claude /mcp in the project", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const terminal: string[] = [];
    const { h } = setup({ terminal });
    await h.hello();
    await h.open(dir);
    await h.engine.request({ type: "mcp_auth", name: "linear" });
    expect(terminal).toEqual([`cd '${dir}' && claude /mcp`]);
  });

  it("refuses without a session", async () => {
    const { h } = setup();
    await h.hello();
    await expect(h.engine.request({ type: "mcp_status" })).rejects.toThrow(/no_session/);
  });
});
