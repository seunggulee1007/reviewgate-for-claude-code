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

  it("the CLI's line first: no second (named) row; a PreToolUse block stays its own row", () => {
    const { events, feed } = session();
    feed(sys("hook_response", { hook_id: "h0", hook_name: "PreToolUse:Bash", hook_event: "PreToolUse", outcome: "error", exit_code: 2, stdout: "", stderr: "no rm -rf", output: "" }));
    feed(sys("informational", { content: "Stop hook prevented continuation: tests are red", level: "warning", prevent_continuation: true }));
    feed(sys("hook_response", { hook_id: "h1", hook_name: "Stop", hook_event: "Stop", outcome: "success", exit_code: 0, stdout: '{"decision":"block","reason":"tests are red"}', stderr: "", output: "" }));
    expect(blocked(events)).toEqual([
      ["PreToolUse:Bash", "no rm -rf"],
      [null, "Stop hook prevented continuation: tests are red"],
    ]);
  });
});
