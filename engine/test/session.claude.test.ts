import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";

/** A session whose SDK → event translation is driven directly (nothing is spawned by the constructor). */
function fakeSession(): {
  feed: (m: SDKMessage) => void;
  events: SessionEvent[];
  text: () => string;
  /** What the post-Bash hook reports (hooks.ts onBashFiles). */
  onBashFiles: (toolUseId: string, files: string[]) => void;
} {
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
  // As if the engine had sent a message (sendUser needs a started query): a result ends this turn.
  (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
  const feed = (m: SDKMessage) => (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage(m);
  const text = () => events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
  const onBashFiles = (toolUseId: string, files: string[]) =>
    (s as unknown as { hookCtx: { onBashFiles: (id: string, f: string[]) => void } }).hookCtx.onBashFiles(toolUseId, files);
  return { feed, events, text, onBashFiles };
}

const SID = "s1";

function assistant(id: string, text: string, model = "claude-x"): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "u",
    session_id: SID,
    message: { id, model, type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  } as unknown as SDKMessage;
}

function stream(event: Record<string, unknown>): SDKMessage {
  return { type: "stream_event", parent_tool_use_id: null, uuid: "u", session_id: SID, event } as unknown as SDKMessage;
}

const messageStart = (id: string) => stream({ type: "message_start", message: { id, type: "message", role: "assistant", content: [] } });
const textStart = () => stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
const textDelta = (text: string) => stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const blockStop = () => stream({ type: "content_block_stop", index: 0 });

describe("ClaudeSession SDK → events: non-streamed assistant text", () => {
  it("emits a synthetic (non-streamed) assistant text block as one text_delta", () => {
    const s = fakeSession();
    s.feed(assistant("523d492c", "/help isn't available in this environment.", "<synthetic>"));
    const deltas = s.events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect(s.text()).toBe("/help isn't available in this environment.");
  });

  it("does not duplicate text that was fully streamed", () => {
    const s = fakeSession();
    s.feed(messageStart("msg_1"));
    s.feed(textStart());
    s.feed(textDelta("p"));
    s.feed(textDelta("ong"));
    s.feed(assistant("msg_1", "pong")); // the CLI sends the full block before content_block_stop
    s.feed(blockStop());
    expect(s.events.filter((e) => e.type === "text_delta")).toHaveLength(2);
    expect(s.text()).toBe("pong");
  });

  it("emits only the remainder when the full message carries more than was streamed", () => {
    const s = fakeSession();
    s.feed(messageStart("msg_2"));
    s.feed(textStart());
    s.feed(textDelta("pong"));
    s.feed(assistant("msg_2", "pong and more"));
    s.feed(blockStop());
    const deltas = s.events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text);
    expect(deltas).toEqual(["pong", " and more"]);
  });

  it("ignores subagent text and tracks several text blocks of one message in order", () => {
    const s = fakeSession();
    s.feed(messageStart("msg_3"));
    s.feed(textStart());
    s.feed(textDelta("one"));
    s.feed(assistant("msg_3", "one"));
    s.feed(blockStop());
    s.feed(stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
    s.feed(textDelta("two"));
    s.feed(assistant("msg_3", "two"));
    s.feed({ ...(assistant("msg_sub", "hidden") as object), parent_tool_use_id: "toolu_1" } as SDKMessage);
    expect(s.text()).toBe("onetwo");
  });

  it("forwards compaction status as thinking activity", () => {
    const s = fakeSession();
    s.feed({ type: "system", subtype: "status", status: "compacting", uuid: "u", session_id: SID } as unknown as SDKMessage);
    s.feed({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "Not enough messages to compact.", uuid: "u", session_id: SID } as unknown as SDKMessage);
    s.feed(assistant("c0739a45", "Not enough messages to compact.", "<synthetic>"));
    expect(s.events).toEqual([
      { type: "activity", kind: "thinking", detail: "compacting" },
      { type: "text_delta", text: "Not enough messages to compact." },
    ]);
  });
});

// ------------------------------------------------------------------ change → cause linkage

type Block = Record<string, unknown>;

function assistantBlocks(id: string, content: Block[], parent: string | null = null): SDKMessage {
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

const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });
const result = { type: "result", subtype: "success", session_id: SID, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5, total_cost_usd: 0 } as unknown as SDKMessage;


describe("ClaudeSession SDK → events: change → cause linkage", () => {
  it("emits subagent inner tool calls with parentToolUseId on tool_use and tool_result; top-level calls carry none", () => {
    const s = fakeSession();
    s.feed(assistantBlocks("m1", [toolUse("agent1", "Agent", { description: "explore", subagent_type: "Explore", prompt: "x" })]));
    s.feed(assistantBlocks("m2", [toolUse("inner1", "Edit", { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" })], "agent1"));
    s.feed(toolResult("inner1", "ok", false, "agent1"));
    s.feed(toolResult("agent1", [{ type: "text", text: "done" }]));
    const uses = s.events.filter((e) => e.type === "tool_use");
    const results = s.events.filter((e) => e.type === "tool_result");
    expect(uses.map((e) => [e.id, e.parentToolUseId])).toEqual([["agent1", undefined], ["inner1", "agent1"]]);
    expect(uses[0]).not.toHaveProperty("parentToolUseId");
    expect(results.map((e) => [e.toolUseId, e.parentToolUseId])).toEqual([["inner1", "agent1"], ["agent1", undefined]]);
  });

  it("records the preceding text block of the same API message as rationale (last 400 chars), else the agent's latest text this turn", () => {
    const s = fakeSession();
    s.feed(assistantBlocks("m1", [{ type: "text", text: "  I'll fix the null check in a.ts.  " }]));
    s.feed(assistantBlocks("m1", [toolUse("t1", "Edit", { file_path: "/tmp/a.ts" })]));
    s.feed(assistantBlocks("m1", [toolUse("t2", "Read", { file_path: "/tmp/b.ts" })]));
    s.feed(assistantBlocks("m2", [toolUse("t3", "Read", { file_path: "/tmp/c.ts" })]));
    const long = "x".repeat(1000) + " Let me run the tests.";
    s.feed(assistantBlocks("m3", [{ type: "text", text: long }, toolUse("t4", "Bash", { command: "npm test" })]));
    const by = (id: string) => s.events.find((e) => e.type === "tool_use" && e.id === id) as Extract<SessionEvent, { type: "tool_use" }>;
    expect(by("t1").rationale).toBe("I'll fix the null check in a.ts.");
    expect(by("t2").rationale).toBe("I'll fix the null check in a.ts.");
    // m2 has no text: the main agent's latest explanation (m1) still applies (text → Read → Edit, real CLI shape).
    expect(by("t3").rationale).toBe("I'll fix the null check in a.ts.");
    expect(by("t4").rationale!.length).toBeLessThanOrEqual(400);
    expect(by("t4").rationale!.startsWith("…")).toBe(true);
    expect(by("t4").rationale!.endsWith("Let me run the tests.")).toBe(true);
    // A subagent never inherits the main agent's text; it gets its own.
    s.feed(assistantBlocks("m4", [toolUse("s1", "Write", { file_path: "/tmp/d.ts" })], "agentX"));
    s.feed(assistantBlocks("m5", [{ type: "text", text: "Creating e.ts." }], "agentX"));
    s.feed(assistantBlocks("m6", [toolUse("s2", "Write", { file_path: "/tmp/e.ts" })], "agentX"));
    s.feed(assistantBlocks("m7", [toolUse("t5", "Edit", { file_path: "/tmp/a.ts" })]));
    expect(by("s1")).not.toHaveProperty("rationale");
    expect(by("s2").rationale).toBe("Creating e.ts.");
    expect(by("t5").rationale!.endsWith("Let me run the tests.")).toBe(true);
  });

  it("turn_end.toolFiles carries the tool_use ids per file; post-Bash files get the Bash id unless an edit explains them", () => {
    const s = fakeSession();
    // Absolute for the host (`D:\\tmp\\a.ts` on Windows): the edit tools' paths are resolved, the post-Bash ones arrive resolved.
    const [a, b] = [resolve("/tmp/a.ts"), resolve("/tmp/b.ts")];
    // Real CLI shape (2.1.303, Haiku): the text explaining the edit precedes a Read of the file, the Edit follows without text.
    s.feed(assistantBlocks("m0", [{ type: "text", text: "Now I'll update a.ts." }, toolUse("r0", "Read", { file_path: "/tmp/a.ts" })]));
    s.feed(assistantBlocks("m1", [toolUse("e1", "Edit", { file_path: "/tmp/a.ts" }), toolUse("e2", "Write", { file_path: "/tmp/a.ts" })]));
    s.feed(assistantBlocks("m1", [toolUse("b1", "Bash", { command: "sed -i '' s/x/y/ b.ts a.ts" })]));
    s.onBashFiles("b1", [a, b]);
    s.feed(assistantBlocks("m1", [toolUse("b2", "Bash", { command: "touch a.ts" })]));
    s.onBashFiles("b2", [a]);
    s.feed(result);
    const end = s.events.find((e) => e.type === "turn_end") as Extract<SessionEvent, { type: "turn_end" }>;
    const byPath = Object.fromEntries(end.toolFiles.map((f) => [f.path, f]));
    expect(byPath[a]).toEqual({ path: a, tools: ["Read", "Edit", "Write", "Bash"], count: 4, toolUseIds: ["e1", "e2", "b2"] });
    expect(byPath[b]).toEqual({ path: b, tools: ["Bash"], count: 1, toolUseIds: ["b1"] });
  });

  it("tool_result: 500-char preview + truncated; Bash keeps up to ~20k chars (never on the wire) and a test outcome", () => {
    const s = fakeSession();
    s.feed(assistantBlocks("m1", [toolUse("r1", "Read", { file_path: "/tmp/a.ts" }), toolUse("b1", "Bash", { command: "cd engine && npx vitest run" })]));
    s.feed(toolResult("r1", "y".repeat(800)));
    const out = "z".repeat(30_000) + "\n Test Files  1 failed | 3 passed (4)\n";
    s.feed(toolResult("b1", [{ type: "text", text: out }]));
    const [read, bash] = s.events.filter((e) => e.type === "tool_result") as Extract<SessionEvent, { type: "tool_result" }>[];
    expect(read!.preview).toHaveLength(500);
    expect(read!.truncated).toBe(true);
    expect(read).not.toHaveProperty("output");
    expect(read).not.toHaveProperty("testOutcome");
    expect(bash!.preview).toHaveLength(500);
    expect(bash!.output!.truncated).toBe(true);
    expect(bash!.output!.text.length).toBeLessThanOrEqual(20_100);
    expect(bash!.output!.text.endsWith("1 failed | 3 passed (4)\n")).toBe(true);
    expect(bash!.testOutcome).toBe("fail");

    s.feed(assistantBlocks("m2", [toolUse("b2", "Bash", { command: "ls" }), toolUse("b3", "Bash", { command: "swift test --package-path Core" })]));
    s.feed(toolResult("b2", "a\nb"));
    s.feed(toolResult("b3", "Exit code 1\nerror: build failed", true));
    const [ls, swift] = (s.events.filter((e) => e.type === "tool_result") as Extract<SessionEvent, { type: "tool_result" }>[]).slice(2);
    expect(ls).toEqual({ type: "tool_result", toolUseId: "b2", isError: false, preview: "a\nb" });
    expect(swift!.testOutcome).toBe("fail");
    expect(swift).not.toHaveProperty("output");
  });
});
