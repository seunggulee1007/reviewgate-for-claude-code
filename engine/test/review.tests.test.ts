import { describe, expect, it } from "vitest";
import { lastTestOf } from "../src/review/tests.js";
import { buildTurnSummary, type ToolCallInfo } from "../src/review/summary.js";

const at = (n: number) => `2026-10-23T01:00:${String(n).padStart(2, "0")}.000Z`;
/** Calls in tool_use order; `r` = the tool_result order. */
function calls(rows: [string, Partial<ToolCallInfo> & { r?: number }][]): Map<string, ToolCallInfo> {
  return new Map(
    rows.map(([id, c], i) => [
      id,
      { name: c.name ?? "Bash", turn: c.turn ?? 4, seq: i, ...c, ...(c.r !== undefined ? { resultSeq: c.r, resultAt: at(c.r) } : {}) } as ToolCallInfo,
    ]),
  );
}

describe("lastTestOf (§34.9 turn_summary.lastTest)", () => {
  it("the last recognized test call by tool_result order; afterLastEdit when no file-changing call finished after it", () => {
    const c = calls([
      ["e1", { name: "Edit", fileChanging: true, r: 1 }],
      ["t1", { command: "./mvn-ci.sh -q -o test", testOutcome: "fail", r: 2 }],
      ["e2", { name: "Edit", fileChanging: true, r: 3 }],
      // Parallel calls: t2's result arrived after t3's although it was issued first.
      ["t2", { command: "./mvn-ci.sh -q -o test -pl api", testOutcome: "pass", r: 5 }],
      ["t3", { command: "./mvn-ci.sh -q -o test -pl web", testOutcome: "fail", r: 4 }],
      ["ls", { command: "ls", r: 6 }],
    ]);
    expect(lastTestOf(c, 4)).toEqual({ verdict: "pass", command: "./mvn-ci.sh -q -o test -pl api", toolUseId: "t2", at: at(5), afterLastEdit: true, runs: 3 });
  });

  it("an edit (or a Bash call that changed files) after the last test: afterLastEdit false; subagent calls count too", () => {
    const c = calls([
      ["t1", { command: "npx vitest run", testOutcome: "pass", r: 1 }],
      ["s1", { name: "Write", parentToolUseId: "ag", fileChanging: true, r: 2 }],
    ]);
    expect(lastTestOf(c, 4)).toMatchObject({ toolUseId: "t1", afterLastEdit: false, runs: 1 });
    const b = calls([
      ["t1", { command: "npx vitest run", testOutcome: "pass", r: 1 }],
      ["b1", { command: "npm run fmt", fileChanging: true, r: 2 }],
    ]);
    expect(lastTestOf(b, 4)?.afterLastEdit).toBe(false);
    // A failed edit changed nothing; a test that itself wrote files (snapshots) is not "after" itself.
    const f = calls([
      ["t1", { command: "npx vitest run -u", testOutcome: "pass", fileChanging: true, r: 2 }],
      ["e1", { name: "Edit", isError: true, r: 3 }],
    ]);
    expect(lastTestOf(f, 4)?.afterLastEdit).toBe(true);
  });

  it("null when the turn ran no test; other turns' calls never count", () => {
    expect(lastTestOf(calls([["ls", { command: "ls", r: 1 }]]), 4)).toBeNull();
    const c = calls([
      ["old", { command: "npm test", testOutcome: "fail", r: 1, turn: 3 }],
      ["e1", { name: "Edit", fileChanging: true, r: 2 }],
    ]);
    expect(lastTestOf(c, 4)).toBeNull();
  });

  it("turn_summary carries lastTest (null when none ran)", () => {
    const c = calls([
      ["e1", { name: "Edit", fileChanging: true, r: 1 }],
      ["t1", { command: "./gradlew test", testOutcome: "pass", r: 2 }],
    ]);
    const s = buildTurnSummary({ turn: 4, files: [], calls: c, commandIds: ["t1"], plan: null });
    expect(s.lastTest).toEqual({ verdict: "pass", command: "./gradlew test", toolUseId: "t1", at: at(2), afterLastEdit: true, runs: 1 });
    expect(buildTurnSummary({ turn: 5, files: [], calls: c, commandIds: [], plan: null }).lastTest).toBeNull();
  });
});
