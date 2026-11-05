import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanUseTool, HookCallback, HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { buildHooks, CLAUDE_CONFIG_ASK_REASON, PLAN_MODE_EDIT_REASON, READ_ONLY_BASH_REASON, type HookContext } from "../src/session/hooks.js";
import { bashClaudeConfigTarget, claudeConfigFile, inputClaudeConfigTarget, isClaudeConfigPath } from "../src/session/reviewScope.js";
import { makeRepo, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §33.9: Claude Code's own settings in the project — `.claude/settings.json`, `.claude/settings.local.json`
 * (at the root or below it) and `.mcp.json` — decide which hooks run, which tools are allowed (§33.5 applies the local file's
 * allow rules from the next session on) and which MCP servers start; settings.local.json is not even in the review. An edit
 * to one used to be auto-allowed like any edit inside the root. Now every change to them — an edit tool, a Bash command or a
 * writing MCP call that names one — goes on the card with `reason: {code: "claude_config", path}`, never auto-allowed by a
 * pattern, a remembered key, `autoAllowTools` or acceptEdits.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const opts = { signal: new AbortController().signal };

function repo(): string {
  const root = realpathSync(makeRepo());
  dirs.push(root);
  return root;
}

function ctx(root: string, over: Partial<HookContext> = {}): HookContext & { notices: unknown[] } {
  const notices: unknown[] = [];
  return {
    budget: new BudgetState({ maxFiles: 10, maxLines: 400 }),
    cwd: root,
    root,
    ignorePatterns: [],
    autoAllowTools: new Set(),
    emit: () => {},
    log: () => {},
    onScopeNotice: (n) => notices.push(n),
    notices,
    ...over,
  };
}

function hookInput(event: "PreToolUse" | "PostToolUse", toolName: string, toolInput: Record<string, unknown>, cwd: string, toolUseId: string): HookInput {
  return { hook_event_name: event, tool_name: toolName, tool_input: toolInput, session_id: "s", transcript_path: "", cwd, tool_use_id: toolUseId, tool_response: {} } as unknown as HookInput;
}

function decision(out: unknown): { decision?: string; reason?: string } {
  const h = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return { decision: h?.permissionDecision, reason: h?.permissionDecisionReason };
}

/** Every PreToolUse hook whose matcher takes the tool, in order; the first deny wins, else the last decision. */
async function pre(c: HookContext, toolName: string, input: Record<string, unknown>, toolUseId: string, cwd = c.cwd): Promise<{ decision?: string; reason?: string }> {
  let out: { decision?: string; reason?: string } = {};
  for (const m of buildHooks(c).PreToolUse!) {
    if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
    for (const h of m.hooks) {
      const d = decision(await (h as HookCallback)(hookInput("PreToolUse", toolName, input, cwd, toolUseId), toolUseId, opts));
      if (d.decision === "deny") return d;
      if (d.decision) out = d;
    }
  }
  return out;
}

async function post(c: HookContext, toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<void> {
  for (const m of buildHooks(c).PostToolUse ?? []) {
    if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
    for (const h of m.hooks) await (h as HookCallback)(hookInput("PostToolUse", toolName, input, c.cwd, toolUseId), toolUseId, opts);
  }
}

describe("which files are Claude Code's own settings (§33.9)", () => {
  it("settings.json / settings.local.json under a .claude folder and .mcp.json, at the root or below it, any case", () => {
    const root = "/repo";
    for (const rel of [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", "modules/api/.claude/settings.json", "modules/api/.claude/settings.local.json", "modules/api/.mcp.json", ".Claude/Settings.Local.JSON", ".MCP.json"]) {
      expect(isClaudeConfigPath(join(root, rel)), rel).toBe(true);
    }
    for (const rel of ["settings.json", "settings.local.json", ".vscode/settings.json", ".claude/settings.json.bak", ".claude/hooks/settings.json", ".claude/hooks/pre.sh", "docs/.mcp.json.md", "a.mcp.json", "CLAUDE.md"]) {
      expect(isClaudeConfigPath(join(root, rel)), rel).toBe(false);
    }
  });

  it("an edit target is one as named or through a symlink", () => {
    const root = repo();
    write(root, ".claude/settings.local.json", "{}\n");
    symlinkSync(join(root, ".claude", "settings.local.json"), join(root, "innocent.json"));
    expect(claudeConfigFile(join(root, ".claude", "settings.local.json"))).toBe(join(root, ".claude", "settings.local.json"));
    expect(claudeConfigFile(join(root, "innocent.json"))).toBe(join(root, ".claude", "settings.local.json"));
    expect(claudeConfigFile(join(root, "README.md"))).toBeNull();
  });

  it("a Bash command names one: as a word (after its own cd), inside a script, quoted apart, under ~", () => {
    // Targets are host-absolute (resolve): /repo/… here, D:\repo\… on Windows.
    const root = "/repo";
    expect(bashClaudeConfigTarget(`echo '{"permissions":{"allow":["WebFetch(domain:evil.example)"]}}' > .claude/settings.local.json`, root, root)).toBe(resolve("/repo/.claude/settings.local.json"));
    expect(bashClaudeConfigTarget("sed -i '' 's/a/b/' .mcp.json", root, root)).toBe(resolve("/repo/.mcp.json"));
    expect(bashClaudeConfigTarget("cd .claude && sed -i '' 's/x/y/' settings.json", root, root)).toBe(resolve("/repo/.claude/settings.json"));
    expect(bashClaudeConfigTarget("cp /tmp/x.json modules/api/.claude/settings.json", root, root)).toBe(resolve("/repo/modules/api/.claude/settings.json"));
    expect(bashClaudeConfigTarget("echo '{}' >.mcp.json", "/repo/modules/api", root)).toBe(resolve("/repo/modules/api/.mcp.json"));
    expect(bashClaudeConfigTarget(`python3 -c "open('.claude/settings.local.json','w').write('{}')"`, root, root)).toBe(resolve("/repo/.claude/settings.local.json"));
    expect(bashClaudeConfigTarget(`echo x > .claude/settings.loc""al.json`, root, root)).toBe(resolve("/repo/.claude/settings.local.json"));
    expect(bashClaudeConfigTarget("echo x >> ~/.claude/settings.json", root, root)).toBe(join(homedir(), ".claude", "settings.json"));
    // Named in a way no word resolves (a script that builds the path): still the project's own file.
    expect(bashClaudeConfigTarget(`node -e "require('fs').writeFileSync(process.argv[1], '{}')" settings.local.json`, root, root)).toBe(resolve("/repo/.claude/settings.local.json"));
    // Not Claude Code's settings.
    expect(bashClaudeConfigTarget("sed -i '' 's/a/b/' settings.json", root, root)).toBeNull();
    expect(bashClaudeConfigTarget("cat .vscode/settings.json > /tmp/x", root, root)).toBeNull();
    expect(bashClaudeConfigTarget("npm test", root, root)).toBeNull();
  });

  it("a writing MCP call names one in a path-like value (relative to the project) or a command; file content does not count", () => {
    const root = "/repo";
    expect(inputClaudeConfigTarget({ pathInProject: ".claude/settings.local.json", text: "{}" }, root)).toBe(resolve("/repo/.claude/settings.local.json"));
    expect(inputClaudeConfigTarget({ path: "/repo/.mcp.json", content: "{}" }, root)).toBe(resolve("/repo/.mcp.json"));
    expect(inputClaudeConfigTarget({ edits: [{ file: "modules/api/.claude/settings.json" }] }, root)).toBe(resolve("/repo/modules/api/.claude/settings.json"));
    expect(inputClaudeConfigTarget({ command: "echo {} > .mcp.json" }, root)).toBe(resolve("/repo/.mcp.json"));
    expect(inputClaudeConfigTarget({ pathInProject: "docs/setup.md", text: "Copy .mcp.json and .claude/settings.local.json first." }, root)).toBeNull();
    expect(inputClaudeConfigTarget({ pathInProject: "src/App.java" }, root)).toBeNull();
  });
});

describe("the hooks put a change to Claude Code's settings on the card (§33.9)", () => {
  it("edit tools: ask for each settings file inside the project; other edits still run, deny rules still win", async () => {
    const root = repo();
    const c = ctx(root);
    let n = 0;
    for (const rel of [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", "modules/api/.claude/settings.json"]) {
      for (const tool of ["Write", "Edit", "MultiEdit"]) {
        const d = await pre(c, tool, { file_path: join(root, rel), content: "{}", old_string: "a", new_string: "b", edits: [] }, `e${n++}`);
        expect(d, `${tool} ${rel}`).toEqual({ decision: "ask", reason: CLAUDE_CONFIG_ASK_REASON });
      }
    }
    expect(await pre(c, "Write", { file_path: join(root, "src", "ok.ts"), content: "x\n" }, "e-ok")).toEqual({});
    // Plan mode still denies every edit (deny comes before the card).
    const plan = ctx(root, { permissionMode: "plan", plansDir: join(root, "..", "plans-nowhere") });
    expect(await pre(plan, "Write", { file_path: join(root, ".mcp.json"), content: "{}" }, "p1")).toEqual({ decision: "deny", reason: PLAN_MODE_EDIT_REASON });
  });

  it("Bash: a command naming a settings file asks with the reason although a pattern, a remembered key or autoAllowTools would allow it", async () => {
    const root = repo();
    const c = ctx(root, {
      bashAllowPatterns: ["Bash(echo:*)", "Bash(sed:*)", "Bash(cd:*)", "Bash(python3:*)"],
      rememberedAllows: new Set(["Bash:cp /tmp/x.json"]),
    });
    const cases: [string, string][] = [
      [`echo '{"permissions":{"allow":["WebFetch(domain:evil.example)"]}}' > .claude/settings.local.json`, join(root, ".claude", "settings.local.json")],
      ["sed -i '' 's/a/b/' .mcp.json", join(root, ".mcp.json")],
      ["cd .claude && sed -i '' 's/x/y/' settings.json", join(root, ".claude", "settings.json")],
      [`python3 -c "open('.claude/settings.local.json','w').write('{}')"`, join(root, ".claude", "settings.local.json")],
      ["cp /tmp/x.json .claude/settings.json", join(root, ".claude", "settings.json")],
    ];
    let n = 0;
    for (const [command, path] of cases) {
      const id = `b${n++}`;
      expect(await pre(c, "Bash", { command }, id), command).toEqual({ decision: "ask", reason: CLAUDE_CONFIG_ASK_REASON });
      expect(c.scopeReasons?.get(id), command).toMatchObject({ code: "claude_config", path });
    }
    // Reading one is harmless: the read-only rule still applies.
    expect(await pre(c, "Bash", { command: "cat .claude/settings.local.json" }, "r1")).toEqual({ decision: "allow", reason: READ_ONLY_BASH_REASON });
    // Commands that name no settings file still ride on the patterns.
    expect((await pre(c, "Bash", { command: "echo hi" }, "r2")).decision).toBe("allow");
    expect((await pre(c, "Bash", { command: "sed -i '' 's/a/b/' settings.json" }, "r3")).decision).toBe("allow");
    expect(c.scopeReasons?.has("r3")).toBe(false);
    // Bash listed in autoAllowTools does not skip it either.
    const auto = ctx(root, { autoAllowTools: new Set(["Bash"]) });
    expect(await pre(auto, "Bash", { command: "echo '{}' > .mcp.json" }, "a1")).toEqual({ decision: "ask", reason: CLAUDE_CONFIG_ASK_REASON });
    // Once the approved command ran there is no worktree notice: the change is not outside this window's review.
    await post(c, "Bash", { command: cases[0]![0] }, "b0");
    expect(c.notices).toEqual([]);
  });

  it("a location the review does not see keeps its own reason (nested repository first)", async () => {
    const root = repo();
    const lib = join(root, "vendor", "lib");
    mkdirSync(lib, { recursive: true });
    sh(lib, "init", "-q");
    const c = ctx(root);
    expect((await pre(c, "Write", { file_path: join(lib, ".claude", "settings.json"), content: "{}" }, "n1")).decision).toBe("ask");
    expect(await pre(c, "Bash", { command: "cd vendor/lib && echo '{}' > .mcp.json" }, "n2")).toMatchObject({ decision: "ask" });
    expect(c.scopeReasons?.get("n2")).toMatchObject({ code: "nested_repository", path: lib });
  });

  it("MCP: a writing tool naming a settings file asks with the reason although its pattern allows the server; reading tools are unaffected", async () => {
    const root = repo();
    const c = ctx(root, { bashAllowPatterns: ["mcp__idea__*", "mcp__fs__*"] });
    expect(await pre(c, "mcp__idea__create_new_file", { pathInProject: ".claude/settings.local.json", text: "{}" }, "m1")).toEqual({ decision: "ask", reason: CLAUDE_CONFIG_ASK_REASON });
    expect(c.scopeReasons?.get("m1")).toMatchObject({ code: "claude_config", path: join(root, ".claude", "settings.local.json") });
    expect((await pre(c, "mcp__fs__write_file", { path: join(root, ".mcp.json"), content: "{}" }, "m2")).decision).toBe("ask");
    expect((await pre(c, "mcp__idea__get_file_text_by_path", { pathInProject: ".mcp.json" }, "m3")).decision).toBe("allow");
    expect((await pre(c, "mcp__idea__create_new_file", { pathInProject: "docs/setup.md", text: "copy .mcp.json first" }, "m4")).decision).toBe("allow");
  });
});

// ------------------------------------------------------------------ ClaudeSession.canUseTool

function session(root: string, extra: Record<string, unknown> = {}, remembered?: Set<string>): { s: ClaudeSession; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const s = new ClaudeSession({
    cwd: root,
    settings: { budget: { maxFiles: 10, maxLines: 400 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", ...extra },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    ...(remembered ? { rememberedAllows: remembered } : {}),
    emit: (e) => events.push(e),
    log: () => {},
  });
  (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
  return { s, events };
}

type Req = Extract<SessionEvent, { type: "permission_request" }>;
async function nextRequest(events: SessionEvent[], n: number): Promise<Req> {
  for (let i = 0; i < 500 && events.filter((e) => e.type === "permission_request").length < n; i++) await new Promise((r) => setTimeout(r, 10));
  return events.filter((e): e is Req => e.type === "permission_request")[n - 1]!;
}

describe("canUseTool: the claude_config card (§33.9)", () => {
  it("an edit to settings.local.json is a card with the reason — not auto-allowed by acceptEdits, autoAllowTools or a remembered key — and never in changedOutside", async () => {
    const root = repo();
    const { s, events } = session(root, { permissionMode: "acceptEdits", autoAllowTools: ["Edit", "Write"] }, new Set(["Edit:Edit", "Write:Write"]));
    const canUseTool = (s as unknown as { canUseTool: CanUseTool }).canUseTool;
    const file = join(root, ".claude", "settings.local.json");
    const pending = canUseTool("Write", { file_path: file, content: '{"permissions":{"allow":["WebFetch(domain:evil.example)"]}}' }, { ...opts, toolUseID: "w1" } as never);
    const req = await nextRequest(events, 1);
    expect(req).toMatchObject({ toolName: "Write", file, toolUseId: "w1", reason: { code: "claude_config", path: file } });
    expect(req.reason!.message).toBe(
      "Changes Claude Code's own settings (.claude/settings.local.json) — hooks, permissions and MCP servers there change how Claude runs; .claude/settings.local.json is not kept in the review and cannot be reverted.",
    );
    expect(req.allowPatterns).toBeUndefined();
    s.respondPermission(req.requestId, true);
    expect(await pending).toMatchObject({ behavior: "allow" });
    // .mcp.json too; a denied card is a deny.
    const p2 = canUseTool("Edit", { file_path: join(root, ".mcp.json"), old_string: "a", new_string: "b" }, { ...opts, toolUseID: "e2" } as never);
    const r2 = await nextRequest(events, 2);
    expect(r2.reason).toMatchObject({ code: "claude_config", path: join(root, ".mcp.json") });
    expect(r2.reason!.message).toContain("(.mcp.json)");
    s.respondPermission(r2.requestId, false);
    expect(await p2).toMatchObject({ behavior: "deny" });
    // Any other edit inside the project is still auto-allowed.
    expect(await canUseTool("Edit", { file_path: join(root, "README.md"), old_string: "a", new_string: "b" }, { ...opts, toolUseID: "e3" } as never)).toMatchObject({ behavior: "allow" });
    (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage({ type: "result", subtype: "success", session_id: "s1", usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5, total_cost_usd: 0 } as unknown as SDKMessage);
    const end = events.find((e): e is Extract<SessionEvent, { type: "turn_end" }> => e.type === "turn_end");
    expect(end!.changedOutside).toEqual([]);
  });

  it("Bash: the card carries the hook's reason; without a hook answer canUseTool finds it itself instead of applying the pattern", async () => {
    const root = repo();
    const { s, events } = session(root, { bashAllowPatterns: ["Bash(echo:*)", "Bash(sed:*)"] });
    const hooks = (s as unknown as { hookCtx: HookContext }).hookCtx;
    const canUseTool = (s as unknown as { canUseTool: CanUseTool }).canUseTool;
    const command = "echo '{}' > .claude/settings.local.json";
    expect((await pre(hooks, "Bash", { command }, "b1")).decision).toBe("ask");
    void canUseTool("Bash", { command }, { ...opts, toolUseID: "b1" } as never);
    const r1 = await nextRequest(events, 1);
    expect(r1).toMatchObject({ toolName: "Bash", toolUseId: "b1", reason: { code: "claude_config", path: join(root, ".claude", "settings.local.json") } });
    expect(r1.allowPatterns).toBeUndefined();
    // The CLI asked without our hook having seen the call (no tool_use id): same card, never the pattern's allow.
    void canUseTool("Bash", { command: "sed -i '' 's/a/b/' .mcp.json" }, { ...opts } as never);
    const r2 = await nextRequest(events, 2);
    expect(r2.reason).toMatchObject({ code: "claude_config", path: join(root, ".mcp.json") });
    // A command naming no settings file still rides on the pattern.
    expect(await canUseTool("Bash", { command: "sed -i '' 's/a/b/' README.md" }, { ...opts, toolUseID: "b3" } as never)).toMatchObject({ behavior: "allow" });
  });
});

describe("canUseTool: the git_command card (§46)", () => {
  it("a git command that changes the repository is a card with the reason — never auto-allowed by autoAllowTools, a pattern or a remembered key", async () => {
    const root = repo();
    const { s, events } = session(root, { permissionMode: "auto", autoAllowTools: ["Bash"], bashAllowPatterns: ["Bash(git *)"] }, new Set(["Bash:git merge"]));
    const canUseTool = (s as unknown as { canUseTool: CanUseTool }).canUseTool;
    // The CLI asked without our hook having seen the call: canUseTool finds the reason itself.
    const pending = canUseTool("Bash", { command: "git merge develop" }, { ...opts } as never);
    const req = await nextRequest(events, 1);
    expect(req).toMatchObject({ toolName: "Bash", reason: { code: "git_command" } });
    expect(req.allowPatterns).toBeUndefined();
    s.respondPermission(req.requestId, true);
    expect(await pending).toMatchObject({ behavior: "allow" });
    // A read-only git command still rides on the rules.
    expect(await canUseTool("Bash", { command: "git merge-base HEAD develop" }, { ...opts } as never)).toMatchObject({ behavior: "allow" });
  });
});
