import { describe, expect, it } from "vitest";
import type { HookInput, Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { isWriterTool } from "../src/review/live.js";
import { BudgetState } from "../src/session/budget.js";
import { ClaudeSession } from "../src/session/claude.js";
import { buildHooks, needsAsk, READ_ONLY_TOOLS, unpromptedBlocked, type HookContext } from "../src/session/hooks.js";

/** docs/PROTOCOL.md §36.13: the main chat's ReportFindings is a read-only report — never a permission card. */

function ctx(over: Partial<HookContext> = {}): HookContext {
  return { budget: new BudgetState({ maxFiles: 5, maxLines: 200 }), cwd: "/tmp", root: "/tmp", ignorePatterns: [], autoAllowTools: new Set(), interrupted: false, emit: () => {}, log: () => {}, ...over };
}

describe("ReportFindings in the main session", () => {
  it("is a read-only tool: no ask, allowed outside a turn, never a writer of the live view", async () => {
    expect(READ_ONLY_TOOLS.has("ReportFindings")).toBe(true);
    expect(needsAsk("ReportFindings", new Set())).toBe(false);
    expect(unpromptedBlocked("ReportFindings", { findings: [] }, { turnActive: false })).toBe(false);
    expect(isWriterTool("ReportFindings")).toBe(false);
    const preOther = buildHooks(ctx()).PreToolUse![2]!.hooks[0]!;
    const input = { hook_event_name: "PreToolUse", tool_name: "ReportFindings", tool_input: { level: "low", findings: [] }, session_id: "s", transcript_path: "", cwd: "/tmp", tool_use_id: "t1" } as unknown as HookInput;
    expect(await preOther(input, "t1", { signal: new AbortController().signal })).toEqual({});
  });

  it("the main session starts with CLAUDE_CODE_REPORT_FINDINGS=1 unless the environment sets it", async () => {
    const started = async (): Promise<Options | undefined> => {
      let options: Options | undefined;
      const queryFn = (args: { options?: Options }): Query => {
        options = args.options;
        const q = {
          next: async () => ({ done: true, value: undefined }),
          return: async () => ({ done: true, value: undefined }),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
        return q as unknown as Query;
      };
      const s = new ClaudeSession({
        cwd: "/tmp",
        settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
        claudePath: "/nonexistent/claude",
        env: {},
        platform: { killTree: async () => undefined, isWindows: false },
        emit: () => {},
        log: () => {},
        queryFn: queryFn as never,
      });
      await s.start();
      await s.dispose();
      return options;
    };
    const prev = process.env.CLAUDE_CODE_REPORT_FINDINGS;
    try {
      delete process.env.CLAUDE_CODE_REPORT_FINDINGS;
      expect((await started())?.env?.CLAUDE_CODE_REPORT_FINDINGS).toBe("1");
      process.env.CLAUDE_CODE_REPORT_FINDINGS = "0";
      expect((await started())?.env?.CLAUDE_CODE_REPORT_FINDINGS).toBe("0");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_REPORT_FINDINGS;
      else process.env.CLAUDE_CODE_REPORT_FINDINGS = prev;
    }
  });
});
