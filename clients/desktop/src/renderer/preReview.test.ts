/**
 * MARK: wave3 desktop-flow — §36.13: which AI pre-review findings show where (the Mac's PreReviewDisplay rules) and how the
 * runs follow replies, events and dismissals; the §36.13 JSON example decodes as is.
 */
import { describe, expect, it } from "vitest";
import type { PreReviewEvent, PreReviewFinding, PreReviewRun } from "@reviewgate/engine";
import {
  applyRun,
  findingCounts,
  findingQuestion,
  findingsByLine,
  findingsOfFile,
  firstFindingPath,
  headStatus,
  noteBody,
  shownRuns,
  unplacedFindings,
  withoutFinding,
} from "./preReview";

const finding = (id: string, file: string, line: number | null = null, summary = "s"): PreReviewFinding => ({ id, file, line, summary, shortSummary: `short ${id}`, failureScenario: `scenario ${id}` });
const run = (prereviewId: string, o: Partial<PreReviewRun> = {}): PreReviewRun => ({
  prereviewId,
  status: "done",
  source: "round",
  endTree: "b2",
  startedAt: "2026-10-23T03:00:00.000Z",
  findings: [],
  ...o,
});

describe("§36.13 which findings show", () => {
  const runs = [
    run("toolu_2", { source: "main", findings: [finding("f1", "a.ts", 3)] }),
    run("pr-2", { findings: [finding("f1", "a.ts", 3), finding("f2", "b.ts")] }),
    run("pr-1", { findings: [finding("f9", "c.ts", 1)] }),
  ];

  it("the newest round run and the main chat's runs; an older round run is replaced", () => {
    expect(shownRuns(runs).map((r) => r.prereviewId)).toEqual(["toolu_2", "pr-2"]);
    expect(findingCounts(runs)).toEqual({ "a.ts": 2, "b.ts": 1 });
    expect(findingsByLine(findingsOfFile(runs, "a.ts")).get(3)).toHaveLength(2);
    expect(findingsOfFile(runs, "c.ts")).toEqual([]);
  });

  it("a whole-file finding or one outside the shown lines sits above the diff", () => {
    expect(unplacedFindings(findingsOfFile(runs, "b.ts"), new Set([1, 2])).map((i) => i.finding.id)).toEqual(["f2"]);
    expect(unplacedFindings(findingsOfFile(runs, "a.ts"), new Set([3]))).toEqual([]);
    expect(unplacedFindings(findingsOfFile(runs, "a.ts"), new Set([10]))).toHaveLength(2);
    // the full-file view places none
    expect(unplacedFindings(findingsOfFile(runs, "a.ts"), null)).toHaveLength(2);
  });

  it("'N findings' leads to the first file of the list with one", () => {
    expect(firstFindingPath(["z.ts", "b.ts", "a.ts"], findingCounts(runs))).toBe("b.ts");
    expect(firstFindingPath([], findingCounts(runs))).toBe("a.ts");
    expect(firstFindingPath(["x"], {})).toBeNull();
  });
});

describe("§36.13 the Changes head's status", () => {
  it("follows the newest round run; the main chat's findings count too", () => {
    expect(headStatus([], "b2")).toEqual({ kind: "idle" });
    expect(headStatus([run("pr-1", { status: "running" })], "b2")).toEqual({ kind: "running", prereviewId: "pr-1" });
    expect(headStatus([run("pr-1", { findings: [finding("f1", "a.ts")] })], "b2")).toEqual({ kind: "done", count: 1, stale: false });
    expect(headStatus([run("pr-1", { findings: [finding("f1", "a.ts")] })], "b3")).toEqual({ kind: "done", count: 1, stale: true });
    expect(headStatus([run("pr-1", { status: "cancelled" })], "b2")).toEqual({ kind: "idle" });
    expect(headStatus([run("toolu_1", { source: "main", findings: [finding("f1", "a.ts")] })], "b2")).toEqual({ kind: "done", count: 1, stale: false });
    expect(headStatus([run("pr-1", { status: "failed", error: "side_limit" })], "b2")).toEqual({ kind: "failed", reason: "Too many side sessions are running — wait for one to finish" });
    expect(headStatus([run("pr-1", { status: "failed", error: "the CLI exited with 1" })], "b2")).toEqual({ kind: "failed", reason: "the CLI exited with 1" });
  });
});

describe("§36.13 runs and findings", () => {
  it("a reply / event replaces the run with its id; a new one goes first; a running run without findings reads as none", () => {
    let runs: PreReviewRun[] = [];
    runs = applyRun(runs, { ...run("pr-1", { status: "running" }), findings: undefined as unknown as PreReviewFinding[] });
    expect(runs[0]!.findings).toEqual([]);
    runs = applyRun(runs, run("toolu_7", { source: "main" }));
    runs = applyRun(runs, run("pr-1", { findings: [finding("f1", "x.java", 42)] }));
    expect(runs.map((r) => r.prereviewId)).toEqual(["toolu_7", "pr-1"]);
    expect(runs[1]!.findings).toHaveLength(1);
    expect(withoutFinding(runs, "pr-1", "f1")[1]!.findings).toEqual([]);
  });

  it("the §36.13 example as it arrives", () => {
    const wire: PreReviewEvent = JSON.parse(
      '{"type":"prereview","id":"p1","prereviewId":"pr-3f2a","status":"done","source":"round","scope":"round","effort":"medium","endTree":"9ac0…","startedAt":"2026-10-23T03:00:00.000Z","endedAt":"2026-10-23T03:01:40.000Z","costUSD":0.21,"findings":[{"id":"f1","file":"api/src/main/java/com/x/Svc.java","line":42,"summary":"A soft-deleted cart now throws NotFound","shortSummary":"deleted cart throws","failureScenario":"cart soft-deleted → the nightly batch aborts","category":"correctness"}]}',
    );
    const runs = applyRun([], wire);
    expect(headStatus(runs, "9ac0…")).toEqual({ kind: "done", count: 1, stale: false });
    expect(findingCounts(runs)).toEqual({ "api/src/main/java/com/x/Svc.java": 1 });
  });

  it("'Add as note' carries the summary and the failure scenario; 'Ask' quotes the summary", () => {
    const f: PreReviewFinding = { id: "f1", file: "a.ts", line: 4, summary: " Off by one in the loop ", shortSummary: "off by one", failureScenario: "last item skipped " };
    expect(noteBody(f)).toBe("Off by one in the loop\nlast item skipped");
    expect(noteBody({ id: "f2", file: "a.ts", line: null, summary: "", shortSummary: "short", failureScenario: "" })).toBe("short");
    expect(findingQuestion(f)).toContain("Off by one in the loop");
  });
});
