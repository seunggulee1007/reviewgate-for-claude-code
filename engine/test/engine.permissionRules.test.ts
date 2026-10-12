import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, makeTempDir, removeDir, sh } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §33.5–33.8, engine side: the user's rules reach the session, `permission_rules` previews them,
 * remembered allows can persist per worktree.
 */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function setup(): { dir: string; configDir: string } {
  const dir = realpathSync(makeRepo());
  dirs.push(dir);
  const configDir = makeTempDir("rg-claude-config");
  dirs.push(configDir);
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ permissions: { allow: ["WebSearch", "mcp__github", "Bash(./gradlew:*)"], deny: ["WebFetch(domain:evil.com)"], defaultMode: "auto" } }));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["WebFetch(domain:docs.spring.io)", "Edit"] } }));
  return { dir, configDir };
}

function harness(configDir: string): Harness {
  const h = makeHarness({ env: { CLAUDE_CONFIG_DIR: configDir } });
  harnesses.push(h);
  return h;
}

describe("the user's Claude Code rules (§33.5)", () => {
  it("reach the session at start (user rules only with user settings; off with applyUserAllowRules: false, live)", async () => {
    const { dir, configDir } = setup();
    const h = harness(configDir);
    await h.hello({ loadUserSettings: true });
    await h.open(dir);
    expect(h.session().opts.settings.userRules).toEqual({
      allow: ["WebSearch", "mcp__github", "Bash(./gradlew:*)", "WebFetch(domain:docs.spring.io)", "Edit"],
      block: ["WebFetch(domain:evil.com)"],
    });
    await h.engine.handle({ type: "set_settings", settings: { applyUserAllowRules: false } });
    expect(h.session().permissionSettings.at(-1)).toEqual({ userRules: { allow: [], block: [] } });
    await h.engine.handle({ type: "close_project" });

    const h2 = harness(configDir);
    await h2.hello({ loadUserSettings: false });
    await h2.open(dir);
    expect(h2.session().opts.settings.userRules).toEqual({ allow: ["WebFetch(domain:docs.spring.io)", "Edit"], block: [] });
  });

  it("permission_rules previews every allow rule with its status, why and what importing would add", async () => {
    const { dir, configDir } = setup();
    const h = harness(configDir);
    await h.hello({ loadUserSettings: true });
    await h.open(dir);
    const reply = await h.engine.request({ type: "permission_rules" });
    expect(reply.type).toBe("permission_rules");
    expect(reply.sources.map((s) => [s.scope, s.exists])).toEqual([["user", true], ["project", false], ["local", true]]);
    expect(reply.sources[0]!.path).toBe(join(configDir, "settings.json"));
    expect(reply.rules.map((r) => [r.rule, r.source, r.status, r.why, r.importAs])).toEqual([
      ["WebSearch", "user", "applied", "non_mutating_tool", null],
      ["mcp__github", "user", "applied", "read_mcp_tools", "mcp__github__*"],
      ["Bash(./gradlew:*)", "user", "ignored", "bash", "Bash(./gradlew:*)"],
      ["WebFetch(domain:docs.spring.io)", "local", "applied", "non_mutating_tool", null],
      ["Edit", "local", "ignored", "edit_tool", null],
    ]);
    expect(reply).toMatchObject({ defaultMode: "auto", defaultModeSupported: true, applyUserAllowRules: true, loadUserSettings: true });
  });

  it("an allow pattern added while requests are queued answers the ones it covers; a late response to one of them is a no-op", async () => {
    const { dir, configDir } = setup();
    const h = harness(configDir);
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "look things up" });
    const s = h.session();
    s.emit({ type: "permission_request", requestId: "Q1", toolName: "mcp__github__create_issue", input: { body: "x" }, toolUseId: "m1" });
    s.emit({ type: "permission_request", requestId: "Q2", toolName: "mcp__github__update_issue", input: { body: "y" }, toolUseId: "m2" });
    s.emit({ type: "permission_request", requestId: "Q3", toolName: "WebFetch", input: { url: "https://example.com" }, toolUseId: "w1" });
    await h.settle();
    // "Always allow in this project" on Q1's card: the client saves the pattern, then answers Q1.
    await h.engine.handle({ type: "set_settings", settings: { bashAllowPatterns: ["mcp__github__*"] } });
    await h.engine.request({ type: "permission_response", requestId: "Q1", allow: true });
    expect(s.permissionResponses.map((r) => [r.requestId, r.allow])).toEqual([["Q1", true], ["Q2", true]]);
    expect(h.engine.state.session.pendingPermissions!.map((p) => p.requestId)).toEqual(["Q3"]);
  });
});

describe("remembered allows per worktree (§33.7)", () => {
  const allowsFile = (dir: string) => join(dir, ".git", "reviewgate", "allows.json");

  it("persistSessionAllows keeps them across open_project; forget_allows clears the file; off = memory only", async () => {
    const { dir, configDir } = setup();
    const h = harness(configDir);
    await h.hello({ persistSessionAllows: true });
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "go" });
    h.session().emit({ type: "permission_request", requestId: "P1", toolName: "Bash", input: { command: "npm run build" }, toolUseId: "b1" });
    await h.settle();
    await h.engine.handle({ type: "permission_response", requestId: "P1", allow: true, remember: true });
    await h.waitFor(() => existsSync(allowsFile(dir)), "allows file");
    expect(JSON.parse(readFileSync(allowsFile(dir), "utf8"))).toMatchObject({ version: 1, keys: ["Bash:npm run"] });
    h.session().emitTurnEnd();
    await h.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn end");

    // Another engine (the app restarted) opening the same worktree starts with them.
    const h2 = harness(configDir);
    await h2.hello({ persistSessionAllows: true });
    await h.engine.handle({ type: "close_project" });
    await h2.open(dir);
    expect(h2.engine.state.session.rememberedAllows).toEqual(["Bash:npm run"]);
    expect([...(h2.session().opts.rememberedAllows ?? [])]).toEqual(["Bash:npm run"]);
    await h2.engine.handle({ type: "forget_allows" });
    await h2.waitFor(() => !existsSync(allowsFile(dir)), "allows file removed");

    // Without the option nothing is read back.
    writeFileSync(allowsFile(dir), JSON.stringify({ version: 1, keys: ["Bash:make"], savedAt: "2026-10-22T00:00:00Z" }));
    const h3 = harness(configDir);
    await h3.hello();
    await h2.engine.handle({ type: "close_project" });
    await h3.open(dir);
    expect(h3.engine.state.session.rememberedAllows).toEqual([]);
  });

  it("each worktree keeps its own set (a workbench's lives in its own gitdir)", async () => {
    const { dir, configDir } = setup();
    const wt = join(dir, "..", `${basename(dir)}-wb`);
    sh(dir, "worktree", "add", "-q", "-b", "wb", wt);
    dirs.push(wt);
    const h = harness(configDir);
    await h.hello({ persistSessionAllows: true });
    await h.open(realpathSync(wt));
    await h.engine.handle({ type: "send", text: "go" });
    h.session().emit({ type: "permission_request", requestId: "P1", toolName: "WebFetch", input: { url: "https://x.dev" }, toolUseId: "w1" });
    await h.settle();
    await h.engine.handle({ type: "permission_response", requestId: "P1", allow: true, remember: true });
    const wbGitDir = sh(wt, "rev-parse", "--absolute-git-dir").trim();
    await h.waitFor(() => existsSync(join(wbGitDir, "reviewgate", "allows.json")), "workbench allows file");
    expect(wbGitDir).not.toBe(join(dir, ".git"));
    expect(existsSync(allowsFile(dir))).toBe(false);
  });
});
