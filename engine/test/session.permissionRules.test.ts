import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanUseTool, HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { ALLOW_PATTERN_REASON, ASK_REASON, autoAllowReason, buildHooks, READ_ONLY_TOOLS, USER_RULE_REASON, type HookContext } from "../src/session/hooks.js";
import {
  allowPatternSuggestions,
  classifyRules,
  isReadMcpTool,
  loadPermissionRules,
  matchesToolPattern,
  mcpToolName,
  parseRule,
  userRuleAllows,
} from "../src/session/permissionRules.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §33.5–33.8 (audit daily-04, SME-04, market-14): the user's Claude Code `permissions.allow` rules apply
 * to tools that cannot change files; the app's "always allow" patterns take MCP / WebFetch forms; rules the app does not
 * apply can be previewed and imported.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const opts = { signal: new AbortController().signal };

function preToolUse(toolName: string, toolInput: Record<string, unknown>): HookInput {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "s", transcript_path: "", cwd: "/tmp", tool_use_id: "t1" } as unknown as HookInput;
}

function decision(out: unknown): { decision?: string; reason?: string } {
  const h = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return { decision: h?.permissionDecision, reason: h?.permissionDecisionReason };
}

function ctx(over: Partial<HookContext> = {}): HookContext {
  return { budget: new BudgetState({ maxFiles: 5, maxLines: 200 }), cwd: "/tmp", root: "/tmp", ignorePatterns: [], autoAllowTools: new Set(), emit: () => {}, log: () => {}, ...over };
}

const USER_ALLOW = [
  "WebSearch",
  "WebFetch(domain:docs.spring.io)",
  "WebFetch(domain:*.google.com)",
  "mcp__github",
  "mcp__mysql-mcp__*",
  "mcp__context7__resolve-library-id",
  "Agent",
  "Task(executor)",
  "ListAgents",
  "SendMessage",
  "Bash(npm test:*)",
  "Bash(./gradlew:*)",
  "Edit",
  "Write(src/**)",
];

describe("the user's allow rules (§33.5)", () => {
  it("parseRule: Tool or Tool(content); garbage is null", () => {
    expect(parseRule("WebSearch")).toEqual({ tool: "WebSearch", content: null, raw: "WebSearch" });
    expect(parseRule(" WebFetch(domain:docs.spring.io) ")).toEqual({ tool: "WebFetch", content: "domain:docs.spring.io", raw: "WebFetch(domain:docs.spring.io)" });
    expect(parseRule("Bash(npm test:*)")).toEqual({ tool: "Bash", content: "npm test:*", raw: "Bash(npm test:*)" });
    expect(parseRule("mcp__github")).toEqual({ tool: "mcp__github", content: null, raw: "mcp__github" });
    expect(parseRule("")).toBeNull();
    expect(parseRule("Bash(unclosed")).toBeNull();
    expect(parseRule(42 as unknown as string)).toBeNull();
  });

  it("mcpToolName normalizes like the CLI; isReadMcpTool reads annotations, else the tool's verbs", () => {
    expect(mcpToolName("claude.ai Claude Docs", "batch")).toBe("mcp__claude_ai_Claude_Docs__batch");
    expect(mcpToolName("mysql-mcp", "query")).toBe("mcp__mysql-mcp__query");
    expect(isReadMcpTool("mcp__github__get_issue")).toBe(true);
    expect(isReadMcpTool("mcp__elasticsearch__search")).toBe(true);
    expect(isReadMcpTool("mcp__context7__query-docs")).toBe(true);
    expect(isReadMcpTool("mcp__elasticsearch__list_indices")).toBe(true);
    expect(isReadMcpTool("mcp__github__create_issue")).toBe(false);
    expect(isReadMcpTool("mcp__github__update_issue_status")).toBe(false);
    expect(isReadMcpTool("mcp__fs__write_file")).toBe(false);
    expect(isReadMcpTool("mcp__elasticsearch__esql")).toBe(false); // no verb we know: asks
    // The server's annotations win over the name.
    const hints = new Map([["mcp__x__esql", { readOnly: true }], ["mcp__x__get_and_purge", { destructive: true }]]);
    expect(isReadMcpTool("mcp__x__esql", hints)).toBe(true);
    expect(isReadMcpTool("mcp__x__get_and_purge", hints)).toBe(false);
    expect(isReadMcpTool("Bash")).toBe(false);
  });

  it("applies to tools that cannot change files; never to Bash, edit tools or SendMessage; deny / ask rules win", () => {
    const rules = { allow: USER_ALLOW, block: ["WebFetch(domain:evil.docs.spring.io)", "mcp__github__get_secret"] };
    const yes = (tool: string, input: Record<string, unknown> = {}) => userRuleAllows(tool, input, rules);
    expect(yes("WebSearch", { query: "q" })).toBe(true);
    expect(yes("WebFetch", { url: "https://docs.spring.io/spring-boot/x.html" })).toBe(true);
    expect(yes("WebFetch", { url: "https://maps.google.com/x" })).toBe(true);
    expect(yes("WebFetch", { url: "https://google.com/x" })).toBe(false);
    expect(yes("WebFetch", { url: "https://evil.com/x" })).toBe(false);
    expect(yes("mcp__github__get_issue")).toBe(true);
    expect(yes("mcp__github__create_issue")).toBe(false); // a write: still asks
    expect(yes("mcp__github__get_secret")).toBe(false); // a user ask / deny rule
    expect(yes("mcp__mysql-mcp__query")).toBe(true);
    expect(yes("mcp__context7__resolve-library-id")).toBe(true);
    expect(yes("mcp__context7__query-docs")).toBe(false); // only that one tool was allowed
    expect(yes("Agent", { description: "d", prompt: "p" })).toBe(true);
    expect(yes("Task", { subagent_type: "planner" })).toBe(true); // `Agent` covers every subagent (Agent / Task are one tool)
    const typed = { allow: ["Task(executor)"], block: [] };
    expect(userRuleAllows("Agent", { subagent_type: "executor" }, typed)).toBe(true);
    expect(userRuleAllows("Agent", { subagent_type: "planner" }, typed)).toBe(false);
    expect(yes("SendMessage", { to: "x", message: "m" })).toBe(false);
    expect(yes("Bash", { command: "npm test" })).toBe(false);
    expect(yes("Edit", { file_path: "/tmp/a" })).toBe(false);
    expect(yes("Write", { file_path: "/tmp/src/a" })).toBe(false);
  });

  it("the PreToolUse hook allows by the user's rule (reason ReviewGate: allowed by your Claude Code settings) and asks without it", async () => {
    const off = buildHooks(ctx()).PreToolUse![2]!.hooks[0]!;
    expect(decision(await off(preToolUse("WebSearch", { query: "q" }), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    const c = ctx({ userRules: { allow: USER_ALLOW, block: [] } });
    const on = buildHooks(c).PreToolUse![2]!.hooks[0]!;
    expect(decision(await on(preToolUse("WebSearch", { query: "q" }), "t1", opts))).toEqual({ decision: "allow", reason: USER_RULE_REASON });
    expect(decision(await on(preToolUse("mcp__github__get_issue", { id: 1 }), "t1", opts))).toEqual({ decision: "allow", reason: USER_RULE_REASON });
    expect(decision(await on(preToolUse("mcp__github__create_issue", { body: "x" }), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    expect(decision(await on(preToolUse("SendMessage", { to: "b4", message: "m" }), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    // Bash rules of the user's settings never apply (import them instead, §33.8).
    const bash = buildHooks(c).PreToolUse![1]!.hooks[0]!;
    expect(decision(await bash(preToolUse("Bash", { command: "npm test" }), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
    // canUseTool consults the same rule.
    expect(autoAllowReason("WebSearch", { query: "q" }, c)).toBe(USER_RULE_REASON);
  });
});

describe("app allow patterns beyond Bash (§33.6)", () => {
  it("matchesToolPattern: mcp__server__tool, mcp__server__*, mcp__server, WebFetch(domain:x), WebSearch, Agent; never edit tools or SendMessage", () => {
    expect(matchesToolPattern("mcp__github__*", "mcp__github__create_issue", {})).toBe(true);
    expect(matchesToolPattern("mcp__github", "mcp__github__create_issue", {})).toBe(true);
    expect(matchesToolPattern("mcp__github__get_issue", "mcp__github__get_issue", {})).toBe(true);
    expect(matchesToolPattern("mcp__github__get_issue", "mcp__github__create_issue", {})).toBe(false);
    expect(matchesToolPattern("mcp__git*", "mcp__github__x", {})).toBe(true);
    expect(matchesToolPattern("mcp__github__*", "mcp__githubx__y", {})).toBe(false);
    expect(matchesToolPattern("WebFetch(domain:ghe.example.com)", "WebFetch", { url: "https://ghe.example.com/a/b" })).toBe(true);
    expect(matchesToolPattern("WebFetch(domain:ghe.example.com)", "WebFetch", { url: "https://github.com/a/b" })).toBe(false);
    expect(matchesToolPattern("WebSearch", "WebSearch", { query: "q" })).toBe(true);
    expect(matchesToolPattern("Agent", "Agent", {})).toBe(true);
    expect(matchesToolPattern("Edit", "Edit", { file_path: "/x" })).toBe(false);
    expect(matchesToolPattern("SendMessage", "SendMessage", { to: "x" })).toBe(false);
    expect(matchesToolPattern("Bash(npm test:*)", "WebSearch", {})).toBe(false);
  });

  it("bashAllowPatterns take these forms in the hooks too (live list)", async () => {
    const c = ctx({ bashAllowPatterns: ["Bash(npm test:*)", "mcp__github__*", "WebFetch(domain:docs.spring.io)"] });
    const other = buildHooks(c).PreToolUse![2]!.hooks[0]!;
    expect(decision(await other(preToolUse("mcp__github__create_issue", {}), "t1", opts))).toEqual({ decision: "allow", reason: ALLOW_PATTERN_REASON });
    expect(decision(await other(preToolUse("WebFetch", { url: "https://docs.spring.io/a" }), "t1", opts))).toEqual({ decision: "allow", reason: ALLOW_PATTERN_REASON });
    expect(decision(await other(preToolUse("WebFetch", { url: "https://example.com/a" }), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
  });

  it("allowPatternSuggestions: what a card offers to 'always allow in this project', most specific first", () => {
    expect(allowPatternSuggestions("mcp__github__get_issue", {})).toEqual(["mcp__github__get_issue", "mcp__github__*"]);
    expect(allowPatternSuggestions("WebFetch", { url: "https://Docs.Spring.io/a?b=1" })).toEqual(["WebFetch(domain:docs.spring.io)"]);
    expect(allowPatternSuggestions("WebFetch", { url: "not a url" })).toEqual([]);
    expect(allowPatternSuggestions("WebSearch", { query: "q" })).toEqual(["WebSearch"]);
    expect(allowPatternSuggestions("Agent", { prompt: "p" })).toEqual(["Agent"]);
    for (const t of ["Bash", "Edit", "Write", "SendMessage", "EnterWorktree", "Workflow", "CronCreate"]) expect(allowPatternSuggestions(t, {}), t).toEqual([]);
  });

  it("canUseTool puts the suggestions on the card (none when a reason makes it special)", async () => {
    const events: SessionEvent[] = [];
    const s = new ClaudeSession({
      cwd: "/tmp",
      settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
      claudePath: "/nonexistent/claude",
      env: {},
      platform: { killTree: async () => undefined, isWindows: false },
      emit: (e) => events.push(e),
      log: () => {},
    });
    (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
    const canUseTool = (s as unknown as { canUseTool: CanUseTool }).canUseTool;
    void canUseTool("mcp__github__get_issue", { id: 1 }, { ...opts, toolUseID: "m1" } as never);
    void canUseTool("Bash", { command: "make" }, { ...opts, toolUseID: "b1" } as never);
    for (let i = 0; i < 300 && events.filter((e) => e.type === "permission_request").length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    const reqs = events.filter((e): e is Extract<SessionEvent, { type: "permission_request" }> => e.type === "permission_request");
    expect(reqs.find((r) => r.toolName.startsWith("mcp__"))!.allowPatterns).toEqual(["mcp__github__get_issue", "mcp__github__*"]);
    expect(reqs.find((r) => r.toolName === "Bash")).not.toHaveProperty("allowPatterns");
  });
});

describe("settings files and the import preview (§33.5, §33.8)", () => {
  function files(): { configDir: string; root: string } {
    const base = makeTempDir("rg-rules");
    dirs.push(base);
    const configDir = join(base, "config");
    const root = join(base, "repo");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ permissions: { allow: ["WebSearch", "mcp__github", "Bash(./gradlew:*)"], deny: ["WebFetch(domain:evil.com)"], defaultMode: "auto" } }));
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["mcp__github__create_issue", "Edit(src/**)"] } }));
    writeFileSync(join(root, ".claude", "settings.local.json"), "{ not json");
    return { configDir, root };
  }

  it("loadPermissionRules reads user / project / local files (user only when user settings load); a broken file is reported, not fatal", () => {
    const { configDir, root } = files();
    const r = loadPermissionRules({ configDir, root, loadUser: true });
    expect(r.sources.map((s) => [s.scope, s.exists, s.error !== undefined])).toEqual([["user", true, false], ["project", true, false], ["local", true, true]]);
    expect(r.allow.map((x) => [x.rule, x.source])).toEqual([
      ["WebSearch", "user"], ["mcp__github", "user"], ["Bash(./gradlew:*)", "user"], ["mcp__github__create_issue", "project"], ["Edit(src/**)", "project"],
    ]);
    expect(r.block.map((x) => x.rule)).toEqual(["WebFetch(domain:evil.com)"]);
    expect(r.defaultMode).toBe("auto");
    const noUser = loadPermissionRules({ configDir, root, loadUser: false });
    expect(noUser.allow.map((x) => x.rule)).toEqual(["mcp__github__create_issue", "Edit(src/**)"]);
    expect(noUser.userSkipped.map((x) => x.rule)).toEqual(["WebSearch", "mcp__github", "Bash(./gradlew:*)"]);
  });

  it("classifyRules: applied / ignored with why, and what importing would add", () => {
    const { configDir, root } = files();
    const rows = classifyRules(loadPermissionRules({ configDir, root, loadUser: true }), { applyUserRules: true });
    expect(rows.map((r) => [r.rule, r.status, r.why, r.importAs])).toEqual([
      ["WebSearch", "applied", "non_mutating_tool", null],
      ["mcp__github", "applied", "read_mcp_tools", "mcp__github__*"],
      ["Bash(./gradlew:*)", "ignored", "bash", "Bash(./gradlew:*)"],
      ["mcp__github__create_issue", "ignored", "mutating_mcp_tool", "mcp__github__create_issue"],
      ["Edit(src/**)", "ignored", "edit_tool", null],
    ]);
    const off = classifyRules(loadPermissionRules({ configDir, root, loadUser: true }), { applyUserRules: false });
    expect(off.find((r) => r.rule === "WebSearch")).toMatchObject({ status: "ignored", why: "rules_off", importAs: "WebSearch" });
    const noUser = classifyRules(loadPermissionRules({ configDir, root, loadUser: false }), { applyUserRules: true });
    expect(noUser.find((r) => r.rule === "WebSearch")).toMatchObject({ source: "user", status: "ignored", why: "user_settings_off", importAs: "WebSearch" });
  });

  it("classifyRules: a rule for any read-only tool of the permission layer is applied — §36.13 ReportFindings too", () => {
    const rules = [...READ_ONLY_TOOLS].map((rule) => ({ rule, source: "user" as const }));
    const rows = classifyRules({ sources: [], allow: rules, block: [], userSkipped: [], defaultMode: null }, { applyUserRules: true });
    for (const r of rows) {
      expect([r.rule, r.status]).toEqual([r.rule, "applied"]);
      expect(["already_allowed", "non_mutating_tool"]).toContain(r.why);
    }
    expect(rows.find((r) => r.rule === "ReportFindings")).toMatchObject({ status: "applied", why: "already_allowed", importAs: null });
  });
});
