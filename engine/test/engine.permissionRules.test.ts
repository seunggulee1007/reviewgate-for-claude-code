import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, makeTempDir, removeDir, sh } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §33.5–33.8, engine side: the user's rules reach the session, `permission_rules` previews them,
 * remembered allows persist per repository.
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
      bash: true, // MARK: r2-skills-side (§33.5, M20): the Bash rules apply too unless applyUserBashRules: false
    });
    await h.engine.handle({ type: "set_settings", settings: { applyUserBashRules: false } });
    expect(h.session().permissionSettings.at(-1)).toEqual({ userRules: { allow: ["WebSearch", "mcp__github", "Bash(./gradlew:*)", "WebFetch(domain:docs.spring.io)", "Edit"], block: ["WebFetch(domain:evil.com)"] } });
    await h.engine.handle({ type: "set_settings", settings: { applyUserAllowRules: false } });
    expect(h.session().permissionSettings.at(-1)).toEqual({ userRules: { allow: [], block: [] } });
    await h.engine.handle({ type: "close_project" });

    const h2 = harness(configDir);
    await h2.hello({ loadUserSettings: false });
    await h2.open(dir);
    expect(h2.session().opts.settings.userRules).toEqual({ allow: ["WebFetch(domain:docs.spring.io)", "Edit"], block: [], bash: true });
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
      ["Bash(./gradlew:*)", "user", "applied", "bash_rule", null],
      ["WebFetch(domain:docs.spring.io)", "local", "applied", "non_mutating_tool", null],
      ["Edit", "local", "ignored", "edit_tool", null],
    ]);
    expect(reply).toMatchObject({ defaultMode: "auto", defaultModeSupported: true, applyUserAllowRules: true, applyUserBashRules: true, loadUserSettings: true });
    // MARK: r2-skills-side (§33.5, M20): with the Bash rules off they read as before — importable as app patterns.
    await h.engine.handle({ type: "set_settings", settings: { applyUserBashRules: false } });
    const off = await h.engine.request({ type: "permission_rules" });
    expect(off.rules.find((r) => r.rule === "Bash(./gradlew:*)")).toMatchObject({ status: "ignored", why: "bash", importAs: "Bash(./gradlew:*)" });
    expect(off.applyUserBashRules).toBe(false);
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

describe("remembered allows per repository (§33.7)", () => {
  const allowsFile = (dir: string) => join(dir, ".git", "reviewgate", "allows.json");

  it("persistSessionAllows (on by default) keeps them across open_project; forget_allows clears the file; off = memory only", async () => {
    const { dir, configDir } = setup();
    const h = harness(configDir);
    await h.hello();
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
    await h2.hello();
    await h.engine.handle({ type: "close_project" });
    await h2.open(dir);
    expect(h2.engine.state.session.rememberedAllows).toEqual(["Bash:npm run"]);
    expect([...(h2.session().opts.rememberedAllows ?? [])]).toEqual(["Bash:npm run"]);
    await h2.engine.handle({ type: "forget_allows" });
    // Release-2 review: an empty set that says when it was cleared (another worktree's window drops what it held before).
    await h2.waitFor(() => existsSync(allowsFile(dir)) && JSON.parse(readFileSync(allowsFile(dir), "utf8")).keys.length === 0, "allows file emptied");
    expect(JSON.parse(readFileSync(allowsFile(dir), "utf8"))).toMatchObject({ version: 1, keys: [], clearedAt: expect.any(String) });

    // Turned off, nothing is read back.
    writeFileSync(allowsFile(dir), JSON.stringify({ version: 1, keys: ["Bash:make"], savedAt: "2026-10-22T00:00:00Z" }));
    const h3 = harness(configDir);
    await h3.hello({ persistSessionAllows: false });
    await h2.engine.handle({ type: "close_project" });
    await h3.open(dir);
    expect(h3.engine.state.session.rememberedAllows).toEqual([]);
  });

  it("release-2 review: forget_allows in one worktree's window reaches the other open window — its next turn and its next save drop what it held, nothing is written back", async () => {
    const { dir, configDir } = setup();
    const wt = realpathSync(join(dir, ".."));
    const wb = join(wt, `${basename(dir)}-wb2`);
    sh(dir, "worktree", "add", "-q", "-b", "wb2", wb);
    dirs.push(wb);
    const remember = async (h: Harness, id: string, toolName: string, input: Record<string, unknown>) => {
      h.session().emit({ type: "permission_request", requestId: id, toolName, input, toolUseId: `t-${id}` });
      await h.settle();
      await h.engine.handle({ type: "permission_response", requestId: id, allow: true, remember: true });
    };
    const keysOnDisk = (): string[] => (existsSync(allowsFile(dir)) ? JSON.parse(readFileSync(allowsFile(dir), "utf8")).keys : []);
    const a = harness(configDir);
    await a.hello();
    await a.open(dir);
    await a.engine.handle({ type: "send", text: "go" });
    await remember(a, "A1", "Bash", { command: "git push origin main" });
    await a.waitFor(() => keysOnDisk().includes("Bash:git push"), "A's key saved");
    const b = harness(configDir);
    await b.hello();
    await b.open(realpathSync(wb));
    expect(b.engine.state.session.rememberedAllows).toEqual(["Bash:git push"]);
    // A clears the repository's set; B still holds it in memory.
    await a.engine.handle({ type: "forget_allows" });
    await a.waitFor(() => keysOnDisk().length === 0, "A's clear written");
    expect(b.engine.state.session.rememberedAllows).toEqual(["Bash:git push"]);
    // B's next save drops what it held before the clear: nothing is written back.
    await b.engine.handle({ type: "send", text: "go" });
    expect(b.engine.state.session.rememberedAllows).toEqual([]); // the turn's start read the clear
    expect([...(b.session().opts.rememberedAllows ?? [])]).toEqual([]); // the hooks' set too
    await remember(b, "B1", "WebFetch", { url: "https://tasks.example.com/acme/42" });
    await b.waitFor(() => keysOnDisk().includes("WebFetch:WebFetch"), "B's new key saved");
    expect(keysOnDisk()).toEqual(["WebFetch:WebFetch"]);
    expect(b.engine.state.session.rememberedAllows).toEqual(["WebFetch:WebFetch"]);
    // A reopened later starts with what was remembered after the clear only.
    b.session().emitTurnEnd();
    a.session().emitTurnEnd();
    await a.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "A's turn end");
    await a.engine.handle({ type: "close_project" });
    await a.open(dir);
    expect(a.engine.state.session.rememberedAllows).toEqual(["WebFetch:WebFetch"]);
  });

  it("release-2 review: a clear another window made reaches a window that only saves (no turn in between)", async () => {
    const { dir, configDir } = setup();
    const wb = join(realpathSync(join(dir, "..")), `${basename(dir)}-wb3`);
    sh(dir, "worktree", "add", "-q", "-b", "wb3", wb);
    dirs.push(wb);
    const keysOnDisk = (): string[] => (existsSync(allowsFile(dir)) ? JSON.parse(readFileSync(allowsFile(dir), "utf8")).keys : []);
    const b = harness(configDir);
    await b.hello();
    await b.open(realpathSync(wb));
    await b.engine.handle({ type: "send", text: "go" });
    b.session().emit({ type: "permission_request", requestId: "B1", toolName: "Bash", input: { command: "git push origin main" }, toolUseId: "t1" });
    await b.settle();
    await b.engine.handle({ type: "permission_response", requestId: "B1", allow: true, remember: true });
    await b.waitFor(() => keysOnDisk().includes("Bash:git push"), "B's key saved");
    // Another window (an engine on the main worktree) clears the set while B's turn runs.
    const a = harness(configDir);
    await a.hello();
    await a.open(dir);
    await a.engine.handle({ type: "forget_allows" });
    await a.waitFor(() => keysOnDisk().length === 0, "the clear written");
    await new Promise((r) => setTimeout(r, 5));
    b.session().emit({ type: "permission_request", requestId: "B2", toolName: "WebSearch", input: { query: "acme" }, toolUseId: "t2" });
    await b.settle();
    await b.engine.handle({ type: "permission_response", requestId: "B2", allow: true, remember: true });
    await b.waitFor(() => keysOnDisk().includes("WebSearch:WebSearch"), "B's next key saved");
    expect(keysOnDisk()).toEqual(["WebSearch:WebSearch"]);
    expect(b.engine.state.session.rememberedAllows).toEqual(["WebSearch:WebSearch"]);
  });

  it("the repository's worktrees share one set (MARK: r2-skills-side, M21); a worktree's older own set moves there", async () => {
    const { dir, configDir } = setup();
    const wt = join(dir, "..", `${basename(dir)}-wb`);
    sh(dir, "worktree", "add", "-q", "-b", "wb", wt);
    dirs.push(wt);
    const wbGitDir = sh(wt, "rev-parse", "--absolute-git-dir").trim();
    expect(wbGitDir).not.toBe(join(dir, ".git"));
    // What an older engine kept in the workbench's own gitdir.
    mkdirSync(join(wbGitDir, "reviewgate"), { recursive: true });
    writeFileSync(join(wbGitDir, "reviewgate", "allows.json"), JSON.stringify({ version: 1, keys: ["Bash:make build"], savedAt: "2026-10-22T00:00:00Z" }));
    const h = harness(configDir);
    await h.hello();
    await h.open(realpathSync(wt));
    expect(h.engine.state.session.rememberedAllows).toEqual(["Bash:make build"]);
    // §33.6: the repository the clients key "이 저장소에서 항상 허용" by — the same for every worktree.
    expect(realpathSync(h.engine.state.project!.commonDir!)).toBe(realpathSync(join(dir, ".git")));
    await h.engine.handle({ type: "send", text: "go" });
    h.session().emit({ type: "permission_request", requestId: "P1", toolName: "WebFetch", input: { url: "https://x.dev" }, toolUseId: "w1" });
    await h.settle();
    await h.engine.handle({ type: "permission_response", requestId: "P1", allow: true, remember: true });
    await h.waitFor(() => existsSync(allowsFile(dir)), "the repository's allows file");
    expect(JSON.parse(readFileSync(allowsFile(dir), "utf8")).keys).toEqual(["Bash:make build", "WebFetch:WebFetch"]);
    await h.waitFor(() => !existsSync(join(wbGitDir, "reviewgate", "allows.json")), "the workbench's own file moved");
    h.session().emitTurnEnd();
    await h.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn end");
    await h.engine.handle({ type: "close_project" });

    // The main worktree starts with the same set.
    const h2 = harness(configDir);
    await h2.hello();
    await h2.open(dir);
    expect(h2.engine.state.session.rememberedAllows).toEqual(["Bash:make build", "WebFetch:WebFetch"]);
    expect(realpathSync(h2.engine.state.project!.commonDir!)).toBe(realpathSync(join(dir, ".git")));
  });
});
