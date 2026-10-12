import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../src/protocol.js";
import {
  RUNNING_TURN_CALLS,
  RUNNING_TURN_CALL_CHARS,
  RUNNING_TURN_MESSAGE_CHARS,
  RUNNING_TURN_TEXT_CHARS,
  callInputText,
  runningTurnBlock,
  runningTurnFromRows,
  runningTurnHeader,
} from "../src/side/runningTurn.js";

/** docs/PROTOCOL.md §36.10: what a side question asked during a turn learns about that turn. */

const at = "2026-10-23T00:00:00.000Z";
const row = (turn: number, r: Record<string, unknown>): TranscriptItem => ({ at, turn, ...r }) as TranscriptItem;

describe("runningTurnBlock", () => {
  it("starts with the header and carries the request, the mentions, the text so far and the calls in order", () => {
    const text = runningTurnBlock({
      turn: 7,
      userMessage: "Fix the parser so empty input works",
      mentions: ["src/parse.ts", "docs/"],
      assistantText: "Let me look at the parser first.",
      calls: [
        { name: "Read", input: "src/parse.ts" },
        { name: "Agent", input: "(explore) Find the callers" },
        { name: "Grep", input: '{"pattern":"parse("}', agentType: "explore" },
        { name: "Bash", input: "npm test" },
      ],
    });
    expect(text.split("\n")[0]).toBe(runningTurnHeader(7));
    expect(runningTurnHeader(7)).toBe("[Turn 7 in progress — not part of the forked conversation]");
    expect(text).toContain("Fix the parser so empty input works");
    expect(text).toContain("Mentioned: src/parse.ts, docs/");
    expect(text).toContain("Let me look at the parser first.");
    const calls = text.slice(text.indexOf("Tool calls so far"));
    expect(calls.indexOf("- Read: src/parse.ts")).toBeGreaterThan(0);
    expect(calls.indexOf("- Agent: (explore) Find the callers")).toBeGreaterThan(calls.indexOf("- Read: src/parse.ts"));
    // A subagent's call sits under its agent type.
    expect(calls).toContain('  - [explore] Grep: {"pattern":"parse("}');
    expect(calls.indexOf("- Bash: npm test")).toBeGreaterThan(calls.indexOf("[explore] Grep"));
  });

  it("cuts the request at 4 000 chars, keeps the last ~2 000 chars of text and the newest 40 calls", () => {
    const long = "x".repeat(RUNNING_TURN_MESSAGE_CHARS + 500);
    const said = "a".repeat(5000) + "THE END";
    const calls = Array.from({ length: RUNNING_TURN_CALLS + 12 }, (_, i) => ({ name: "Read", input: `f${i}.ts` }));
    const text = runningTurnBlock({ turn: 3, userMessage: long, mentions: [], assistantText: said, calls });
    expect(text).not.toContain("x".repeat(RUNNING_TURN_MESSAGE_CHARS + 1));
    expect(text).toContain("x".repeat(RUNNING_TURN_MESSAGE_CHARS - 1) + "…");
    expect(text).toContain("THE END");
    expect(text).not.toContain("a".repeat(RUNNING_TURN_TEXT_CHARS + 1));
    expect(text).toContain("12 earlier calls not shown");
    expect(text).not.toContain("- Read: f11.ts\n");
    expect(text).toContain("- Read: f12.ts");
    expect(text).toContain(`- Read: f${RUNNING_TURN_CALLS + 11}.ts`);
    expect(text).not.toContain("Mentioned:");
  });

  it("says what is not known yet instead of leaving a gap", () => {
    const text = runningTurnBlock({ turn: 1, userMessage: null, mentions: [], assistantText: "  ", calls: [] });
    expect(text).toContain("(not available)");
    expect(text).toContain("(no text yet)");
    expect(text).toContain("(none yet)");
  });

  it("a text that holds backtick fences cannot close the block's fence", () => {
    const text = runningTurnBlock({ turn: 2, userMessage: "see ```js\ncode\n``` here", mentions: [], assistantText: "````\nmore", calls: [] });
    // Each fence the block opens is longer than any backtick run inside the text it quotes (3 → 4, 4 → 5).
    expect(text).toContain("````text\nsee ```js\ncode\n``` here\n````\n");
    expect(text).toContain("`````text\n````\nmore\n`````");
  });
});

describe("callInputText", () => {
  const rel = (abs: string) => (abs.startsWith("/repo/") ? abs.slice("/repo/".length) : null);
  it("Bash → the command on one line; edit / read tools → the repo-relative path; others → a compact preview", () => {
    expect(callInputText("Bash", { command: "cd x &&\n  npm test" }, rel)).toBe("cd x && npm test");
    expect(callInputText("Edit", { file_path: "/repo/src/a.ts", old_string: "x".repeat(900) }, rel)).toBe("src/a.ts");
    expect(callInputText("Read", { file_path: "/elsewhere/b.ts" }, rel)).toBe("/elsewhere/b.ts");
    expect(callInputText("NotebookEdit", { notebook_path: "/repo/n.ipynb" }, rel)).toBe("n.ipynb");
    expect(callInputText("Agent", { subagent_type: "explore", description: "Find callers", prompt: "long…" }, rel)).toBe("(explore) Find callers");
    expect(callInputText("Grep", { pattern: "foo", path: "/repo/src" }, rel)).toBe('{"pattern":"foo","path":"/repo/src"}');
    expect(callInputText("Bash", { command: "y".repeat(500) }, rel)).toHaveLength(RUNNING_TURN_CALL_CHARS);
    expect(callInputText("Grep", {}, rel)).toBe("");
  });
});

describe("runningTurnFromRows", () => {
  const rel = (abs: string) => (abs.startsWith("/repo/") ? abs.slice("/repo/".length) : null);
  it("takes the turn's user message with its mentions and its calls in order, a subagent's under its type", () => {
    const rows = [
      row(1, { kind: "user_message", text: "old request" }),
      row(1, { kind: "tool_use", id: "t0", name: "Read", input: { file_path: "/repo/old.ts" } }),
      row(2, { kind: "user_message", text: "new request", mentions: ["src/a.ts"] }),
      row(2, { kind: "tool_use", id: "t1", name: "Agent", input: { subagent_type: "explore", description: "Look around" } }),
      row(2, { kind: "tool_use", id: "t2", name: "Grep", input: { pattern: "x" }, parentToolUseId: "t1" }),
      row(2, { kind: "tool_result", toolUseId: "t2", isError: false, preview: "" }),
      row(2, { kind: "tool_use", id: "t3", name: "Edit", input: { file_path: "/repo/src/a.ts" }, file: "/repo/src/a.ts" }),
    ];
    const ctx = runningTurnFromRows(rows, 2, rel);
    expect(ctx.userMessage).toBe("new request");
    expect(ctx.mentions).toEqual(["src/a.ts"]);
    expect(ctx.calls).toEqual([
      { name: "Agent", input: "(explore) Look around" },
      { name: "Grep", input: '{"pattern":"x"}', agentType: "explore" },
      { name: "Edit", input: "src/a.ts" },
    ]);
  });

  it("a peer turn's request is the delivered peer messages; a subagent of unknown type is 'subagent'", () => {
    const rows = [
      row(4, { kind: "peer_message", id: "p1", from: "s1", fromName: "api", state: "delivered", body: "Please rerun the tests" }),
      row(4, { kind: "tool_use", id: "t9", name: "Bash", input: { command: "ls" }, parentToolUseId: "gone" }),
    ];
    const ctx = runningTurnFromRows(rows, 4, rel);
    expect(ctx.userMessage).toBe("[peer message from api] Please rerun the tests");
    expect(ctx.calls).toEqual([{ name: "Bash", input: "ls", agentType: "subagent" }]);
    expect(runningTurnFromRows(rows, 5, rel).userMessage).toBeNull();
  });
});
