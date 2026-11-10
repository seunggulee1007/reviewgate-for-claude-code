import { describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import { ASK_REASON, buildHooks, needsAsk, unpromptedBlocked, type HookContext } from "../src/session/hooks.js";

/** docs/PROTOCOL.md §33 tool policy: which tools never prompt, which always keep their card. */

const opts = { signal: new AbortController().signal };

function ctx(over: Partial<HookContext> = {}): HookContext {
  return {
    budget: new BudgetState({ maxFiles: 5, maxLines: 200 }),
    cwd: "/tmp",
    root: "/tmp",
    ignorePatterns: [],
    autoAllowTools: new Set(),
    emit: () => {},
    log: () => {},
    ...over,
  };
}

function preToolUse(toolName: string, toolInput: Record<string, unknown>): HookInput {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "s", transcript_path: "", cwd: "/tmp", tool_use_id: "t1" } as unknown as HookInput;
}

function decision(out: unknown): { decision?: string; reason?: string } {
  const h = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return { decision: h?.permissionDecision, reason: h?.permissionDecisionReason };
}

describe("cross-session tools (audit peer-07)", () => {
  it("ListAgents only lists sessions: never asks, also outside a turn; SendMessage keeps its card", async () => {
    expect(needsAsk("ListAgents", new Set())).toBe(false);
    expect(needsAsk("SendMessage", new Set())).toBe(true);
    expect(unpromptedBlocked("ListAgents", {}, { turnActive: false })).toBe(false);
    expect(unpromptedBlocked("SendMessage", { to: "acme-b4", message: "done" }, { turnActive: false })).toBe(true);
    const preOther = buildHooks(ctx()).PreToolUse![2]!.hooks[0]!;
    expect(await preOther(preToolUse("ListAgents", {}), "t1", opts)).toEqual({});
    expect(decision(await preOther(preToolUse("SendMessage", { to: "acme-b4", message: "#514 done" }), "t1", opts))).toEqual({ decision: "ask", reason: ASK_REASON });
  });
});
