import { describe, expect, it } from "vitest";
import type { PreReviewRun } from "../src/protocol.js";
import {
  PREREVIEW_MAX_RUNS,
  isPreReviewEffort,
  isPreReviewScope,
  parseReportFindings,
  prereviewPrompt,
  restoreRuns,
  upsertRun,
  withIds,
} from "../src/review/prereview.js";

/** docs/PROTOCOL.md §36.13 (market-04): the pre-review's findings, prompt and stored runs. */

const rel = (f: string) => (f.startsWith("/repo/") ? f.slice("/repo/".length) : f);

const run = (id: string, over: Partial<PreReviewRun> = {}): PreReviewRun => ({
  prereviewId: id, status: "done", source: "round", endTree: "b1", startedAt: "2026-10-23T00:00:00.000Z", findings: [], ...over,
});

describe("parseReportFindings", () => {
  it("maps the CLI's ReportFindings input: repo-relative file, snake_case → camelCase, category kept", () => {
    const found = parseReportFindings({
      level: "low",
      findings: [
        { file: "/repo/calc.js", line: 4, summary: "Loop bound off by one", short_summary: "off-by-one", failure_scenario: "sumFirst([1,2],2) reads arr[2]", category: "correctness", verdict: "CONFIRMED" },
        { file: "src/a.ts", line: "12", summary: "s", short_summary: "", failure_scenario: "" },
        { file: "b.ts", summary: "whole file" },
        { file: "c.ts", line: -3, short_summary: "only short" },
      ],
    }, rel);
    expect(found).toEqual([
      { file: "calc.js", line: 4, summary: "Loop bound off by one", shortSummary: "off-by-one", failureScenario: "sumFirst([1,2],2) reads arr[2]", category: "correctness" },
      { file: "src/a.ts", line: 12, summary: "s", shortSummary: "", failureScenario: "" },
      { file: "b.ts", line: null, summary: "whole file", shortSummary: "", failureScenario: "" },
      { file: "c.ts", line: null, summary: "only short", shortSummary: "only short", failureScenario: "" },
    ]);
  });

  it("ignores what is not a finding", () => {
    expect(parseReportFindings(null, rel)).toEqual([]);
    expect(parseReportFindings({ findings: "x" }, rel)).toEqual([]);
    expect(parseReportFindings({ findings: [null, 3, { line: 2 }, { file: "", summary: "x" }, { file: "a", summary: "", short_summary: "" }] }, rel)).toEqual([]);
  });
});

describe("withIds", () => {
  it("numbers new findings from the run's counter (never reusing a dismissed id) and drops repeats", () => {
    const base = { line: 1, summary: "s", shortSummary: "", failureScenario: "" };
    const first = withIds([], [{ file: "a", ...base }, { file: "b", ...base }], 1);
    expect(first.findings.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(first.next).toBe(3);
    const more = withIds(first.findings, [{ file: "b", ...base }, { file: "c", ...base }], first.next);
    expect(more.findings.map((f) => [f.id, f.file])).toEqual([["f1", "a"], ["f2", "b"], ["f3", "c"]]);
    expect(more.next).toBe(4);
    // f2 dismissed meanwhile: the next finding is f4, not a second f2.
    const after = withIds([more.findings[0]!, more.findings[2]!], [{ file: "d", ...base }], more.next);
    expect(after.findings.map((f) => f.id)).toEqual(["f1", "f3", "f4"]);
  });
});

describe("prereviewPrompt", () => {
  it("runs /code-review <effort>, scoped to this round's patch, findings through ReportFindings", () => {
    const p = prereviewPrompt({
      effort: "medium",
      files: [{ path: "calc.js", oldPath: null, status: "M", added: 1, deleted: 1, isBinary: false }],
      patch: { text: "diff --git a/calc.js b/calc.js\n-a\n+b\n", lines: 3, truncated: false },
    });
    expect(p.startsWith("/code-review medium\n\n")).toBe(true);
    expect(p).toMatch(/Review ONLY the change/);
    expect(p).toContain("ReportFindings");
    expect(p).toContain("- calc.js (M, +1 −1)");
    expect(p).toContain("```diff\ndiff --git a/calc.js b/calc.js\n-a\n+b\n```");
    const cut = prereviewPrompt({ effort: "low", files: [], patch: { text: "x\n", lines: 1, truncated: true } });
    expect(cut).toMatch(/cut after 1 lines/);
  });

  it("scope and effort guards", () => {
    expect(["round", "files"].every(isPreReviewScope)).toBe(true);
    expect(isPreReviewScope("all")).toBe(false);
    expect(["low", "medium", "high"].every(isPreReviewEffort)).toBe(true);
    expect(isPreReviewEffort("max")).toBe(false);
  });
});

describe("stored runs", () => {
  it("upsertRun keeps the newest first, replaces the same id and keeps at most 5", () => {
    let runs: PreReviewRun[] = [];
    for (let i = 1; i <= 7; i++) runs = upsertRun(runs, run(`pr-${i}`));
    expect(runs.map((r) => r.prereviewId)).toEqual(["pr-7", "pr-6", "pr-5", "pr-4", "pr-3"]);
    expect(runs).toHaveLength(PREREVIEW_MAX_RUNS);
    runs = upsertRun(runs, run("pr-5", { status: "failed", error: "x" }));
    expect(runs.map((r) => r.prereviewId)).toEqual(["pr-7", "pr-6", "pr-5", "pr-4", "pr-3"]);
    expect(runs[2]!.status).toBe("failed");
    // A running run is never pushed out by newer ones (the main chat's reports).
    let withRunning = upsertRun([], run("pr-r", { status: "running" }));
    for (let i = 1; i <= 6; i++) withRunning = upsertRun(withRunning, run(`tu_${i}`, { source: "main" }));
    expect(withRunning.map((r) => r.prereviewId)).toEqual(["tu_6", "tu_5", "tu_4", "tu_3", "pr-r"]);
  });

  it("restoreRuns reads a review file leniently; a run that was running when the app closed has failed", () => {
    const restored = restoreRuns([
      run("pr-1", { status: "running" }),
      run("pr-2", { findings: [{ id: "f1", file: "a", line: null, summary: "s", shortSummary: "", failureScenario: "" }], costUSD: 0.2 }),
      { prereviewId: 3 },
      "junk",
      run("tu_1", { source: "main" }),
    ]);
    expect(restored.map((r) => [r.prereviewId, r.status])).toEqual([["pr-1", "failed"], ["pr-2", "done"], ["tu_1", "done"]]);
    expect(restored[0]!.error).toBe("interrupted (ReviewGate was closed)");
    expect(restored[0]!.endedAt).toBeDefined();
    expect(restored[1]!.findings).toHaveLength(1);
    expect(restoreRuns(undefined)).toEqual([]);
    expect(restoreRuns({})).toEqual([]);
  });
});
