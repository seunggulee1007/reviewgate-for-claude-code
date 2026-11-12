import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerStatus, McpSetServersResult } from "@anthropic-ai/claude-agent-sdk";
import { expandMcpVars, inheritedMcpFiles, inheritedMcpServers, mainCheckoutOf } from "../src/mcp/mcpInherit.js";
import type { ClaudeSessionOptions } from "../src/session/claude.js";
import { FakeClaudeSession, makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §42.3: a session in a worktree outside the main checkout (a managed workbench) has the servers of the
 * `.mcp.json` files above the main checkout, as the terminal in the main checkout has them.
 */

class FakeMcpSession extends FakeClaudeSession {
  statuses: McpServerStatus[];
  setCalls: Record<string, unknown>[] = [];
  constructor(opts: ClaudeSessionOptions, initial: McpServerStatus[]) {
    super(opts);
    this.statuses = initial.map((s) => ({ ...s }));
  }
  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return this.statuses.map((s) => ({ ...s }));
  }
  async setMcpServers(servers: Record<string, unknown>): Promise<McpSetServersResult> {
    this.setCalls.push(servers);
    this.statuses = this.statuses.filter((s) => s.scope !== "dynamic");
    for (const name of Object.keys(servers)) this.statuses.push({ name, status: "connected", scope: "dynamic", config: servers[name] as never, tools: [] });
    return { added: Object.keys(servers), removed: [], errors: {} };
  }
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const mcpJson = (dir: string, servers: Record<string, unknown>) => writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));

/**
 * `<home>/.mcp.json` (ctx), `<home>/work/acme/.mcp.json` (db, docs, ctx), the main checkout `<home>/work/acme/app` and a
 * workbench of it in the managed folder `<home>/.reviewgate/worktrees/app-1234/feat` (below home, not below acme).
 */
function layout() {
  const home = realpathSync(makeTempDir("rg-mcp-inherit"));
  dirs.push(home);
  const acme = join(home, "work", "acme");
  const app = join(acme, "app");
  mkdirSync(app, { recursive: true });
  mcpJson(home, { ctx: { command: "node", args: ["home-ctx.js"] } });
  mcpJson(acme, { db: { command: "node", args: ["db.js", "${RG_TEST_DB:-local}"], env: { TOKEN: "${RG_TEST_TOKEN}" } }, docs: { type: "http", url: "https://docs.example.com/mcp" }, ctx: { command: "node", args: ["acme-ctx.js"] }, broken: { args: [] } });
  sh(app, "init", "-q", "-b", "main");
  sh(app, "config", "user.email", "t@e.com");
  sh(app, "config", "user.name", "T");
  write(app, "a.txt", "a\n");
  sh(app, "add", "-A");
  sh(app, "commit", "-qm", "init");
  const wt = join(home, ".reviewgate", "worktrees", "app-1234", "feat");
  mkdirSync(join(wt, ".."), { recursive: true });
  sh(app, "worktree", "add", "-q", "-b", "feat", wt);
  return { home, acme, app, wt };
}

describe("§42.3 .mcp.json files above the main checkout", () => {
  it("names the files a worktree outside the main checkout misses, root-most first; none in the main checkout or below it", () => {
    const { home, acme, app, wt } = layout();
    expect(mainCheckoutOf(join(app, ".git"))).toBe(app);
    expect(mainCheckoutOf(join(app, ".git") + "/")).toBe(app);
    expect(mainCheckoutOf("/srv/app.git")).toBeNull();
    // home is above the workbench too: the CLI reads its file there itself.
    expect(inheritedMcpFiles(wt, app)).toEqual([join(home, "work", ".mcp.json"), join(acme, ".mcp.json")]);
    expect(inheritedMcpFiles(app, app)).toEqual([]);
    expect(inheritedMcpFiles(join(app, ".claude", "worktrees", "x"), app)).toEqual([]);
  });

  it("reads their servers (a nearer file wins), expands ${VAR} as the CLI does, leaves out names the session has", async () => {
    const { app, wt, acme } = layout();
    const env = { RG_TEST_TOKEN: "t0k" };
    const got = await inheritedMcpServers(wt, app, { skip: new Set(["ctx"]), env });
    expect([...got.keys()].sort()).toEqual(["db", "docs"]);
    expect(got.get("db")).toEqual({ file: join(acme, ".mcp.json"), config: { type: "stdio", command: "node", args: ["db.js", "local"], env: { TOKEN: "t0k" } } });
    expect(got.get("docs")?.config).toEqual({ type: "http", url: "https://docs.example.com/mcp" });
    expect(expandMcpVars("${NOPE}/${A}", { A: "x" })).toBe("${NOPE}/x");
  });

  it("a session in the workbench gets them through setMcpServers, each labelled with its own .mcp.json", async () => {
    const { acme, wt } = layout();
    const mcp: FakeMcpSession[] = [];
    // What the CLI loads by itself from the workbench: home's ctx (and a user server).
    const own: McpServerStatus[] = [
      { name: "ctx", status: "connected", scope: "project", config: { type: "stdio", command: "node" } },
      { name: "gh", status: "connected", scope: "user", config: { type: "stdio", command: "npx" } },
    ];
    const h = makeHarness({ mcpPollMs: 30, sessionFactory: (o) => (mcp.push(new FakeMcpSession(o, own)), mcp.at(-1)!) });
    harnesses.push(h);
    await h.hello();
    await h.open(wt);
    await h.waitFor(() => (mcp[0]?.setCalls.length ?? 0) > 0, "the inherited servers reach the session");
    expect(Object.keys(mcp[0]!.setCalls[0]!).sort()).toEqual(["db", "docs"]);
    const st = await h.engine.request({ type: "mcp_status" });
    const db = st.servers.find((s) => s.name === "db")!;
    expect(db).toMatchObject({ status: "connected", source: "project", scope: "project", sessionAdded: false });
    expect(db.origin).toMatchObject({ file: join(acme, ".mcp.json"), place: "parent" });
    expect(st.servers.find((s) => s.name === "ctx")?.source).toBe("project");

    // A session-scope server joins the set; the inherited ones stay in it.
    await h.engine.request({ type: "mcp_add", name: "extra", scope: "session", config: { type: "stdio", command: "node" } });
    expect(Object.keys(mcp[0]!.setCalls.at(-1)!).sort()).toEqual(["db", "docs", "extra"]);
    await h.engine.request({ type: "mcp_remove", name: "extra", scope: "session" });
    expect(Object.keys(mcp[0]!.setCalls.at(-1)!).sort()).toEqual(["db", "docs"]);
  });

  it("the main checkout itself gets nothing extra (the CLI walks its folders)", async () => {
    const { app } = layout();
    const mcp: FakeMcpSession[] = [];
    const h = makeHarness({ mcpPollMs: 30, sessionFactory: (o) => (mcp.push(new FakeMcpSession(o, [])), mcp.at(-1)!) });
    harnesses.push(h);
    await h.hello();
    await h.open(app);
    await h.engine.request({ type: "mcp_status" });
    expect(mcp[0]!.setCalls).toEqual([]);
  });
});
