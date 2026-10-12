import { describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession, type ClaudeSessionOptions } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";

/** A session whose SDK → event translation is driven directly (nothing is spawned by the constructor). */
function fakeSession(extra: Partial<ClaudeSessionOptions> = {}) {
  const events: SessionEvent[] = [];
  const s = new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    ...extra,
  });
  (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
  const feed = (m: SDKMessage) => (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage(m);
  const hookCtx = (s as unknown as { hookCtx: { onBashSnapshot?: (toolUseId: string, tree: string, root: string) => void } }).hookCtx;
  return { s, feed, events, hookCtx };
}

const SID = "s1";
type Block = Record<string, unknown>;
function msg(id: string, content: Block[], parent: string | null = null): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: parent,
    uuid: "u",
    session_id: SID,
    message: { id, model: "claude-x", type: "message", role: "assistant", content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  } as unknown as SDKMessage;
}
function toolResult(toolUseId: string, content: unknown, isError = false, parent: string | null = null): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: parent,
    uuid: "u",
    session_id: SID,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  } as unknown as SDKMessage;
}
const text = (t: string): Block => ({ type: "text", text: t });
const use = (id: string, name: string, input: Record<string, unknown> = {}): Block => ({ type: "tool_use", id, name, input });
const uses = (events: SessionEvent[]) => events.filter((e): e is Extract<SessionEvent, { type: "tool_use" }> => e.type === "tool_use");

describe("tool_use rationaleSource / rationaleAge (§34.8)", () => {
  it("same_message for the call's own API message, earlier for the agent's latest text; age = the agent's calls in between", () => {
    const f = fakeSession();
    // The real CLI delivers each block of one API message as its own SDK message with the same id.
    f.feed(msg("m1", [text("I'll fix the null check in a.ts.")]));
    f.feed(msg("m1", [use("t1", "Read", { file_path: "/tmp/a.ts" })]));
    f.feed(msg("m1", [use("t2", "Edit", { file_path: "/tmp/a.ts" })]));
    f.feed(msg("m2", [use("t3", "Edit", { file_path: "/tmp/a.ts" })]));
    f.feed(msg("m3", [text("Now the tests."), use("t4", "Bash", { command: "npm test" })]));
    f.feed(msg("m4", [use("t5", "Edit", { file_path: "/tmp/b.ts" })]));
    const by = Object.fromEntries(uses(f.events).map((u) => [u.id, [u.rationale, u.rationaleSource, u.rationaleAge]]));
    expect(by).toEqual({
      t1: ["I'll fix the null check in a.ts.", "same_message", 0],
      t2: ["I'll fix the null check in a.ts.", "same_message", 1],
      t3: ["I'll fix the null check in a.ts.", "earlier", 2],
      t4: ["Now the tests.", "same_message", 0],
      t5: ["Now the tests.", "earlier", 1],
    });
  });

  it("a subagent's calls count against its own text only; a call before any text has none", () => {
    const f = fakeSession();
    f.feed(msg("m1", [text("Delegating the tenant fix."), use("ag", "Agent", { description: "fix", subagent_type: "executor", prompt: "x" })]));
    f.feed(msg("s0", [use("s1", "Read", { file_path: "/tmp/t.java" })], "ag"));
    f.feed(msg("s1", [text("The tenant id is never checked, so I add the guard.")], "ag"));
    f.feed(msg("s2", [use("s2", "Edit", { file_path: "/tmp/t.java" })], "ag"));
    f.feed(msg("s3", [use("s3", "Edit", { file_path: "/tmp/t.java" })], "ag"));
    const by = Object.fromEntries(uses(f.events).map((u) => [u.id, [u.rationale ?? null, u.rationaleSource ?? null, u.rationaleAge ?? null]]));
    expect(by.ag).toEqual(["Delegating the tenant fix.", "same_message", 0]);
    expect(by.s1).toEqual([null, null, null]);
    expect(by.s2).toEqual(["The tenant id is never checked, so I add the guard.", "earlier", 0]);
    expect(by.s3).toEqual(["The tenant id is never checked, so I add the guard.", "earlier", 1]);
    // Subagent text is never streamed into the transcript.
    expect(f.events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("Delegating the tenant fix.");
  });
});

describe("subagent text and reports (§34.8)", () => {
  it("the query runs with forwardSubagentText", async () => {
    let options: Options | undefined;
    const f = fakeSession({
      queryFn: ((args: { options?: Options }) => {
        options = args.options;
        return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), interrupt: async () => {}, close: () => {} };
      }) as unknown as ClaudeSessionOptions["queryFn"],
    });
    await f.s.start();
    expect(options?.forwardSubagentText).toBe(true);
    await f.s.dispose();
  });

  it("an Agent call's result keeps the subagent's report (≤ 4 000 chars) next to the preview; other tools carry none", () => {
    const f = fakeSession();
    f.feed(msg("m1", [use("ag", "Agent", { description: "fix", subagent_type: "executor", prompt: "x" }), use("r1", "Read", { file_path: "/tmp/a" })]));
    const report = "- api/Svc.java: the tenant guard.\n" + "x".repeat(5000);
    f.feed(toolResult("ag", [{ type: "text", text: report }, { type: "text", text: "agentId: a1 (for resuming)" }]));
    f.feed(toolResult("r1", "contents"));
    const results = f.events.filter((e): e is Extract<SessionEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results[0]!.agentReport!.startsWith("- api/Svc.java: the tenant guard.")).toBe(true);
    expect(results[0]!.agentReport!.length).toBe(4000);
    expect(results[1]).not.toHaveProperty("agentReport");
  });
});

describe("settings.testCommandPatterns (§34.9)", () => {
  it("are read live for every Bash result", () => {
    let patterns: string[] = [];
    const f = fakeSession({ testCommandPatterns: () => patterns });
    f.feed(msg("m1", [use("b1", "Bash", { command: "./ci.sh unit" })]));
    f.feed(toolResult("b1", "ok"));
    patterns = ["./ci.sh *"];
    f.feed(msg("m2", [use("b2", "Bash", { command: "./ci.sh unit" })]));
    f.feed(toolResult("b2", "ok"));
    const results = f.events.filter((e): e is Extract<SessionEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results.map((r) => r.testOutcome)).toEqual([undefined, "pass"]);
  });
});

describe("post-Bash snapshots (§34.6)", () => {
  it("are forwarded as bash_snapshot with the tree and the repository root", () => {
    const f = fakeSession();
    f.hookCtx.onBashSnapshot?.("b1", "tree1", "/repo");
    expect(f.events).toContainEqual({ type: "bash_snapshot", toolUseId: "b1", tree: "tree1", root: "/repo" });
  });
});
