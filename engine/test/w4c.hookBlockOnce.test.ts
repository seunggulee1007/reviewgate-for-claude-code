// MARK: wave4c w4c-trust — §41.2 (0.2.7 regression): a UserPromptSubmit / Stop hook that blocks makes ONE chat row. The
// CLI reports it twice — the hook's own `hook_response` (named, §40.1) and `informational{prevent_continuation}` — and
// both became a `hook_blocked` notice ("훅이 막음: UserPromptSubmit — …" + "훅이 이 턴을 멈췄어요").
import { afterEach, describe, expect, it } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";

const sessions: ClaudeSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.dispose();
});

function session(): { events: SessionEvent[]; feed: (m: unknown) => void } {
  const events: SessionEvent[] = [];
  const queryFn = (): Query => {
    let done: () => void = () => {};
    const ended = new Promise<void>((r) => (done = r));
    return {
      async next() {
        await ended;
        return { done: true, value: undefined };
      },
      async return() {
        done();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      initializationResult: () => new Promise(() => {}),
    } as unknown as Query;
  };
  const s = new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    queryFn: queryFn as never,
  });
  sessions.push(s);
  (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
  const feed = (m: unknown) => (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage(m as SDKMessage);
  return { events, feed };
}

const sys = (subtype: string, extra: Record<string, unknown>) => ({ type: "system", subtype, uuid: "u", session_id: "s1", ...extra });
const result = (extra: Record<string, unknown>) => ({ type: "result", subtype: "success", session_id: "s1", usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5, total_cost_usd: 0, is_error: false, result: "", ...extra });
const blocked = (events: SessionEvent[]) =>
  events.filter((e): e is Extract<SessionEvent, { type: "error" }> => e.type === "error" && e.code === "hook_blocked").map((e) => [e.hookName ?? null, e.detail ?? null]);
const info = { content: "UserPromptSubmit operation blocked by hook:\ncommit first", level: "warning", prevent_continuation: true };

describe("a blocking prompt / stop hook is one row (§41.2)", () => {
  it("JSON block: the named row only", () => {
    const { events, feed } = session();
    feed(sys("hook_response", { hook_id: "h1", hook_name: "UserPromptSubmit", hook_event: "UserPromptSubmit", outcome: "success", exit_code: 0, stdout: '{"decision":"block","reason":"commit first"}', stderr: "", output: "" }));
    feed(sys("informational", info));
    feed(result({ terminal_reason: "hook_stopped" }));
    expect(blocked(events)).toEqual([["UserPromptSubmit", "commit first"]]);
  });

  it("exit 2: the named row only", () => {
    const { events, feed } = session();
    feed(sys("hook_response", { hook_id: "h1", hook_name: "UserPromptSubmit", hook_event: "UserPromptSubmit", outcome: "error", exit_code: 2, stdout: "", stderr: "commit first\n", output: "" }));
    feed(sys("informational", info));
    expect(blocked(events)).toEqual([["UserPromptSubmit", "commit first"]]);
  });

  it("the CLI's line first: no second (named) row; a PreToolUse block is no row (its call's result says it, §38.2)", () => {
    const { events, feed } = session();
    feed(sys("hook_response", { hook_id: "h0", hook_name: "PreToolUse:Bash", hook_event: "PreToolUse", outcome: "error", exit_code: 2, stdout: "", stderr: "no rm -rf", output: "" }));
    feed(sys("informational", { content: "Stop hook prevented continuation: tests are red", level: "warning", prevent_continuation: true }));
    feed(sys("hook_response", { hook_id: "h1", hook_name: "Stop", hook_event: "Stop", outcome: "success", exit_code: 0, stdout: '{"decision":"block","reason":"tests are red"}', stderr: "", output: "" }));
    expect(blocked(events)).toEqual([[null, "Stop hook prevented continuation: tests are red"]]);
  });
});

const userResult = (id: string, text: string, isError: boolean, parent: string | null = null) => ({
  type: "user", parent_tool_use_id: parent, session_id: "s1", uuid: `r-${id}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] },
});
const results = (events: SessionEvent[]) => events.filter((e): e is Extract<SessionEvent, { type: "tool_result" }> => e.type === "tool_result");

describe("a user / plugin PreToolUse hook's deny is a quiet row under the call it denied (§38.2)", () => {
  it("JSON deny (a subagent's Read, CLI 2.1.318's words): its result says which hook and why; no notice", () => {
    const { events, feed } = session();
    feed(sys("hook_started", { hook_id: "h1", hook_name: "PreToolUse:Read", hook_event: "PreToolUse" }));
    feed(sys("hook_response", {
      hook_id: "h1", hook_name: "PreToolUse:Read", hook_event: "PreToolUse", outcome: "success", exit_code: 0, stderr: "",
      stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[ACME READ BUDGET] Denied: delta.diff is 82394 bytes (budget 45000)"}}', output: "",
    }));
    feed(userResult("toolu_r1", "PreToolUse:Read hook error: [ACME READ BUDGET] Denied: delta.diff is 82394 bytes (budget 45000)", true, "toolu_agent"));
    expect(blocked(events)).toEqual([]);
    expect(results(events)[0]).toMatchObject({
      toolUseId: "toolu_r1", isError: true, parentToolUseId: "toolu_agent",
      hookDenied: { hook: "PreToolUse:Read", reason: "[ACME READ BUDGET] Denied: delta.diff is 82394 bytes (budget 45000)" },
    });
  });

  it("exit 2: the reason without the CLI's [command] frame; an unrelated error result is no hook deny", () => {
    const { events, feed } = session();
    feed(userResult("toolu_x", "Exit code 1\nnpm ERR! missing script", true));
    feed(sys("hook_response", { hook_id: "h2", hook_name: "PreToolUse:Bash", hook_event: "PreToolUse", outcome: "error", exit_code: 2, stdout: "", stderr: "[ACME GUARD] no rm -rf here\n", output: "" }));
    feed(userResult("toolu_other", "Exit code 2\nboom", true));
    feed(userResult("toolu_b", "PreToolUse:Bash hook error: [node .claude/guard.mjs]: [ACME GUARD] no rm -rf here\n", true));
    expect(blocked(events)).toEqual([]);
    expect(results(events).map((r) => [r.toolUseId, r.hookDenied ?? null])).toEqual([
      ["toolu_x", null],
      ["toolu_other", null],
      ["toolu_b", { hook: "PreToolUse:Bash", reason: "[ACME GUARD] no rm -rf here" }],
    ]);
  });

  it("a hook that failed (exit 1) is still a notice; the app's own deny (no hook_response) is no hook deny", () => {
    const { events, feed } = session();
    feed(sys("hook_response", { hook_id: "h3", hook_name: "PreToolUse:Edit", hook_event: "PreToolUse", outcome: "error", exit_code: 1, stdout: "", stderr: "TypeError: x is undefined", output: "" }));
    feed(userResult("toolu_e", "PreToolUse:Edit hook error: The review gate blocked this edit", true));
    expect(events.filter((e) => e.type === "error" && e.code === "hook_failed")).toHaveLength(1);
    expect(results(events)[0]).not.toHaveProperty("hookDenied");
  });
});
