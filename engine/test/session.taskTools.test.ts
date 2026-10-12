import { describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { isWriterTool } from "../src/review/live.js";
import { BudgetState } from "../src/session/budget.js";
import { buildHooks, needsAsk, READ_ONLY_TOOLS, unpromptedBlocked, type HookContext } from "../src/session/hooks.js";
import { allowPatternSuggestions, classifyRules, userRuleApplies } from "../src/session/permissionRules.js";

/**
 * docs/PROTOCOL.md §43.5: Claude's to-do list tools (CLI 2.1.310 gives them with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` or a
 * 4.x model) only keep a list — like TodoWrite they never put a permission card in front of the user. Stopping a
 * background task (TaskStop) and starting a subagent (Task / Agent) still ask.
 */

const LIST_TOOLS = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"] as const;
const STILL_ASKED = ["TaskStop", "Task", "Agent"] as const;

function ctx(over: Partial<HookContext> = {}): HookContext {
  return { budget: new BudgetState({ maxFiles: 5, maxLines: 200 }), cwd: "/tmp", root: "/tmp", ignorePatterns: [], autoAllowTools: new Set(), interrupted: false, emit: () => {}, log: () => {}, ...over };
}

async function preOther(toolName: string, toolInput: Record<string, unknown>, over: Partial<HookContext> = {}): Promise<unknown> {
  const hook = buildHooks(ctx(over)).PreToolUse![2]!.hooks[0]!;
  const input = { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "s", transcript_path: "", cwd: "/tmp", tool_use_id: "t1" } as unknown as HookInput;
  return hook(input, "t1", { signal: new AbortController().signal });
}

describe("Claude's to-do list tools (§43.5)", () => {
  it("TaskCreate / TaskUpdate / TaskList / TaskGet are read-only: no card, allowed between turns, never a writer", async () => {
    for (const tool of LIST_TOOLS) {
      expect(READ_ONLY_TOOLS.has(tool), tool).toBe(true);
      expect(needsAsk(tool, new Set()), tool).toBe(false);
      expect(unpromptedBlocked(tool, {}, { turnActive: false }), tool).toBe(false);
      expect(isWriterTool(tool), tool).toBe(false);
    }
    expect(await preOther("TaskCreate", { subject: "Spring 설정 정리", description: "application.yml", activeForm: "정리하는 중" })).toEqual({});
    expect(await preOther("TaskUpdate", { taskId: "1", status: "completed" })).toEqual({});
    expect(await preOther("TaskList", {})).toEqual({});
    expect(await preOther("TaskGet", { taskId: "1" })).toEqual({});
  });

  it("TaskStop, Task and Agent still ask", async () => {
    for (const tool of STILL_ASKED) {
      expect(READ_ONLY_TOOLS.has(tool), tool).toBe(false);
      expect(needsAsk(tool, new Set()), tool).toBe(true);
    }
    expect(await preOther("TaskStop", { task_id: "b1" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    expect(await preOther("Agent", { subagent_type: "executor", prompt: "x", description: "x" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    expect(unpromptedBlocked("TaskStop", {}, { turnActive: false })).toBe(true);
  });

  it("the permission rules see them as tools that change no file: a user's rule for one is applied", () => {
    for (const tool of LIST_TOOLS) {
      expect(userRuleApplies(tool), tool).toBe(true);
      expect(allowPatternSuggestions(tool, {}), tool).toEqual([tool]);
    }
    expect(userRuleApplies("TaskStop")).toBe(false);
    const rows = classifyRules({ sources: [], allow: LIST_TOOLS.map((rule) => ({ rule, source: "user" as const })), block: [], userSkipped: [], defaultMode: null }, { applyUserRules: true });
    for (const r of rows) expect(r, r.rule).toMatchObject({ status: "applied" });
  });
});
