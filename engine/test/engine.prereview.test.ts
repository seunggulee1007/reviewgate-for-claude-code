import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { PreReviewEvent } from "../src/protocol.js";
import { PREREVIEW_SYSTEM } from "../src/review/prereview.js";
import { SideQuery } from "../src/side/sideQuery.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { FakeSide, makeSideRepo, waitForEvent, type SideScript } from "./helpers/fakeSide.js";
import { removeDir, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §36.13 (market-04): Claude reviews the round first in a read-only fork; findings sit on the diff lines. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function setup(script: SideScript) {
  const sides: FakeSide[] = [];
  const h = makeHarness({ sideQueryFactory: (o) => {
    const f = new FakeSide(o, script);
    sides.push(f);
    return f;
  } });
  harnesses.push(h);
  return { h, sides };
}

/** A turn that changes README.md (an off-by-one style bug) and adds util.js: two pending files. */
async function reviewedTurn(h: Harness, dir: string): Promise<void> {
  await h.engine.handle({ type: "send", text: "Change README and add util.js" });
  h.session().emitSessionInfo();
  write(dir, "README.md", "line1\nline2 changed\nline3\n");
  write(dir, "util.js", "function last(a) { return a[a.length]; }\n");
  h.session().emitTurnEnd({ toolFiles: [], lastUuid: "uuid-1" });
  await h.waitFor((s) => s.gate.phase === "reviewing" && s.changedFiles.length === 2, "review");
}

const findingsCall = (dir: string) => ({
  type: "tool_use" as const,
  id: "toolu_rf1",
  name: "ReportFindings",
  input: {
    level: "medium",
    findings: [
      { file: join(dir, "util.js"), line: 1, summary: "a[a.length] is out of bounds", short_summary: "reads past the end", failure_scenario: "last([1,2]) returns undefined", category: "correctness" },
      { file: "README.md", line: 2, summary: "Typo", short_summary: "typo", failure_scenario: "docs read oddly" },
    ],
  },
});

const prereviews = (h: Harness, id: string) => h.ofType("prereview").filter((e) => e.prereviewId === id);

type ReviewFile = { prereviews?: PreReviewEvent[] };

/** The review file is written behind the git pins (serialized, best effort): poll until `pred` holds. */
async function reviewFile(dir: string, pred: (f: ReviewFile) => boolean): Promise<ReviewFile> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    let f: ReviewFile = {};
    try {
      f = JSON.parse(readFileSync(join(dir, ".git", "reviewgate-review.json"), "utf8")) as ReviewFile;
    } catch {
      // not written yet
    }
    if (pred(f)) return f;
    if (Date.now() > deadline) throw new Error(`review file: ${JSON.stringify(f.prereviews)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("§36.13 prereview_start", () => {
  it("runs /code-review <effort> in a read-only fork scoped to the round; ReportFindings become findings; done at the end; stored with the review", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    const { h, sides } = setup((o) => ({ text: "I reported 2 findings.", cost: 0.03, events: [findingsCall(dir)], hold: o.prompt.includes("HOLD") }));
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    const endTree = h.engine.state.gate.reviewEndTree!;
    const main = h.session();
    const reply = await h.engine.request({ type: "prereview_start", scope: "round", effort: "medium" });
    expect(reply).toMatchObject({ type: "prereview", status: "running", source: "round", scope: "round", effort: "medium", endTree, findings: [] });
    expect(reply.prereviewId).toMatch(/^pr-[0-9a-f]{8}$/);
    const id = reply.prereviewId;
    const done = await waitForEvent(h, "prereview", (e) => e.prereviewId === id && e.status === "done");
    const o = sides[0]!.opts;
    expect(o.prompt.startsWith("/code-review medium\n\n")).toBe(true);
    expect(o.prompt).toContain("+line2 changed");
    expect(o.prompt).toContain("a[a.length]");
    expect(o.prompt).toContain("- README.md (M, +1 −1)");
    expect(o.env.CLAUDE_CODE_REPORT_FINDINGS).toBe("1");
    expect(o.extraTools).toEqual(["ReportFindings"]);
    expect(o.persistSession).toBe(false);
    expect(o.allowWeb).toBe(false); // the reviewed patch is untrusted: no web to carry it out, whatever sideAllowWeb says
    expect(o.system).toBe(PREREVIEW_SYSTEM);
    expect(o.forkFrom).toBe("sess-1");
    expect(done.findings).toEqual([
      { id: "f1", file: "util.js", line: 1, summary: "a[a.length] is out of bounds", shortSummary: "reads past the end", failureScenario: "last([1,2]) returns undefined", category: "correctness" },
      { id: "f2", file: "README.md", line: 2, summary: "Typo", shortSummary: "typo", failureScenario: "docs read oddly" },
    ]);
    expect(done.endedAt).toBeDefined();
    expect(done.costUSD).toBeCloseTo(0.03);
    // start (the reply) → findings → done.
    expect(prereviews(h, id).map((e) => [e.status, e.findings.length])).toEqual([["running", 0], ["running", 2], ["done", 2]]);
    await h.settle();
    const st = h.engine.state;
    expect(st.gate.prereviews).toHaveLength(1);
    expect(st.gate.prereviews![0]).toMatchObject({ prereviewId: id, status: "done", findings: done.findings });
    expect(st.hud.sideCostUSD).toBeCloseTo(0.03);
    // Nothing reached the main conversation or the review.
    expect(main.sends).toHaveLength(1);
    expect(st.changedFiles.map((f) => f.state)).toEqual(["pending", "pending"]);
    expect((await h.engine.request({ type: "side_list" })).threads).toEqual([]);
    // Stored with the review.
    const file = await reviewFile(dir, (f) => f.prereviews?.[0]?.status === "done");
    expect(file.prereviews?.map((r) => [r.prereviewId, r.findings.length])).toEqual([[id, 2]]);

    // The fork cannot change a file — and may report.
    const q = new SideQuery(o).queryOptions();
    const hook = q.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
    const decide = async (tool: string, input: Record<string, unknown>) => {
      const out = await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, session_id: "s", transcript_path: "", cwd: dir, tool_use_id: "t" } as unknown as HookInput, "t", { signal: new AbortController().signal });
      return (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
    };
    expect(await decide("ReportFindings", { findings: [] })).toBe("allow");
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"]) expect(await decide(t, { file_path: join(dir, "util.js") }), t).toBe("deny");
    expect(await decide("Bash", { command: "sed -i s/a/b/ util.js" })).toBe("deny");
  });

  it("files scope sends only those files; refusals: no_review, invalid_prereview, not_a_changed_file, prereview_running", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    const { h, sides } = setup(() => ({ text: "", hold: true }));
    await h.hello();
    await h.open(dir);
    await expect(h.engine.request({ type: "prereview_start", scope: "round", effort: "low" })).rejects.toThrow(/^no_review$/);
    await reviewedTurn(h, dir);
    await expect(h.engine.request({ type: "prereview_start", scope: "round", effort: "max" as never })).rejects.toThrow(/invalid_prereview/);
    await expect(h.engine.request({ type: "prereview_start", scope: "all" as never, effort: "low" })).rejects.toThrow(/invalid_prereview/);
    await expect(h.engine.request({ type: "prereview_start", scope: "files", effort: "low" })).rejects.toThrow(/invalid_prereview/);
    await expect(h.engine.request({ type: "prereview_start", scope: "files", paths: ["nope.txt"], effort: "low" })).rejects.toThrow(/not_a_changed_file:nope.txt/);
    const r = await h.engine.request({ type: "prereview_start", scope: "files", paths: ["util.js"], effort: "high" });
    expect(r).toMatchObject({ scope: "files", paths: ["util.js"], effort: "high" });
    expect(sides[0]!.opts.prompt.startsWith("/code-review high")).toBe(true);
    expect(sides[0]!.opts.prompt).toContain("a[a.length]");
    expect(sides[0]!.opts.prompt).not.toContain("line2 changed");
    await expect(h.engine.request({ type: "prereview_start", scope: "round", effort: "low" })).rejects.toThrow(/prereview_running/);

    // cancel → cancelled; again → not_running; unknown ids.
    await h.engine.request({ type: "prereview_cancel", prereviewId: r.prereviewId });
    const ended = await waitForEvent(h, "prereview", (e) => e.prereviewId === r.prereviewId && e.status === "cancelled");
    expect(ended.endedAt).toBeDefined();
    await expect(h.engine.request({ type: "prereview_cancel", prereviewId: r.prereviewId })).rejects.toThrow(/not_running/);
    await expect(h.engine.request({ type: "prereview_cancel", prereviewId: "pr-00000000" })).rejects.toThrow(/unknown_prereview/);
    await expect(h.engine.request({ type: "prereview_dismiss", prereviewId: "pr-00000000", findingId: "f1" })).rejects.toThrow(/unknown_prereview/);
    await expect(h.engine.request({ type: "prereview_dismiss", prereviewId: r.prereviewId, findingId: "f9" })).rejects.toThrow(/unknown_finding/);
  });

  it("a failed fork fails the run; dismiss removes a finding; the round's end (finish_review) removes the runs", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    let fail = true;
    const { h } = setup(() => (fail ? { text: "", error: "the side session ended without an answer" } : { text: "done", events: [findingsCall(dir)] }));
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    const bad = await h.engine.request({ type: "prereview_start", scope: "round", effort: "low" });
    const failed = await waitForEvent(h, "prereview", (e) => e.prereviewId === bad.prereviewId && e.status === "failed");
    expect(failed.error).toBe("the side session ended without an answer");
    fail = false;
    const ok = await h.engine.request({ type: "prereview_start", scope: "round", effort: "low" });
    await waitForEvent(h, "prereview", (e) => e.prereviewId === ok.prereviewId && e.status === "done");
    await h.engine.request({ type: "prereview_dismiss", prereviewId: ok.prereviewId, findingId: "f1" });
    await h.settle();
    const kept = h.engine.state.gate.prereviews!.find((r) => r.prereviewId === ok.prereviewId)!;
    expect(kept.findings.map((f) => f.id)).toEqual(["f2"]);
    expect(h.engine.state.gate.prereviews!.map((r) => r.prereviewId)).toEqual([ok.prereviewId, bad.prereviewId]);
    await h.engine.request({ type: "finish_review" });
    await h.settle();
    expect(h.engine.state.gate.prereviews).toEqual([]);
  });

  it("runs survive an engine restart with the review; one stopped by the engine (not by the user) has failed", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    const { h } = setup(() => ({ text: "", hold: true }));
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    const r = await h.engine.request({ type: "prereview_start", scope: "round", effort: "low" });
    const saved = await reviewFile(dir, (f) => (f.prereviews ?? []).length > 0);
    expect(saved.prereviews?.[0]).toMatchObject({ prereviewId: r.prereviewId, status: "running" });
    // Closing the app stops the fork: the run failed (interrupted), it was not the user's cancel.
    await h.engine.dispose();
    const { h: h2 } = setup(() => ({ text: "" }));
    await h2.hello();
    await h2.open(dir);
    await h2.waitFor((s) => (s.gate.prereviews ?? []).length === 1, "restored runs");
    expect(h2.engine.state.gate.prereviews![0]).toMatchObject({ prereviewId: r.prereviewId, status: "failed" });
    expect(h2.engine.state.gate.prereviews![0]!.error).toMatch(/^interrupted/);
  });
});

describe("§36.13 the main chat's ReportFindings", () => {
  it("allowed without a card; becomes a run source main (prereviewId = the tool_use id) kept while a review is in progress", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    const { h } = setup(() => ({ text: "x" }));
    await h.hello();
    await h.open(dir);
    // No review yet: the event goes out, nothing is kept.
    await h.engine.handle({ type: "send", text: "/code-review low" });
    h.session().emitSessionInfo();
    h.session().emit({ ...findingsCall(dir), id: "toolu_main0" });
    const first = await waitForEvent(h, "prereview", (e) => e.prereviewId === "toolu_main0");
    expect(first).toMatchObject({ status: "done", source: "main", endTree: null });
    expect(first.findings.map((f) => f.file)).toEqual(["util.js", "README.md"]);
    h.session().emitTurnEnd({ toolFiles: [] });
    await h.waitFor((s) => s.gate.canSend, "turn 1 done");
    expect(h.engine.state.gate.prereviews ?? []).toEqual([]);
    expect(h.engine.state.session.pendingPermissions).toEqual([]);

    // Over a standing review: kept, on the held B.
    await h.engine.handle({ type: "send", text: "Change README and add util.js" });
    write(dir, "README.md", "line1\nline2 changed\nline3\n");
    write(dir, "util.js", "function last(a) { return a[a.length]; }\n");
    h.session().emitTurnEnd({ toolFiles: [], lastUuid: "uuid-2" });
    await h.waitFor((s) => s.gate.phase === "reviewing" && s.changedFiles.length === 2, "review");
    const b = h.engine.state.gate.reviewEndTree;
    await h.engine.handle({ type: "send", text: "/code-review low" });
    h.session().emit({ ...findingsCall(dir), id: "toolu_main1" });
    const main = await waitForEvent(h, "prereview", (e) => e.prereviewId === "toolu_main1");
    expect(main).toMatchObject({ status: "done", source: "main", endTree: b });
    await h.settle();
    expect(h.engine.state.gate.prereviews!.map((r) => [r.prereviewId, r.source])).toEqual([["toolu_main1", "main"]]);
    // The call itself is an ordinary tool row of the chat.
    expect(h.ofType("tool_use").some((e) => e.id === "toolu_main1" && e.name === "ReportFindings")).toBe(true);
  });

  it("a report made in the turn that creates the review joins that review once it is collected (its B); a turn that changes nothing keeps none", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    const { h } = setup(() => ({ text: "x" }));
    await h.hello();
    await h.open(dir);
    // A fresh turn edits, then reviews its own change (the code-review skill through the Skill tool).
    await h.engine.handle({ type: "send", text: "Change README and add util.js, then review your change" });
    h.session().emitSessionInfo();
    write(dir, "README.md", "line1\nline2 changed\nline3\n");
    write(dir, "util.js", "function last(a) { return a[a.length]; }\n");
    h.session().emit({ ...findingsCall(dir), id: "toolu_self" });
    const during = await waitForEvent(h, "prereview", (e) => e.prereviewId === "toolu_self");
    expect(during.endTree).toBeNull();
    h.session().emitTurnEnd({ toolFiles: [], lastUuid: "uuid-self" });
    await h.waitFor((s) => s.gate.phase === "reviewing" && (s.gate.prereviews ?? []).length === 1, "the report joins the new review");
    const b = h.engine.state.gate.reviewEndTree;
    expect(h.engine.state.gate.prereviews![0]).toMatchObject({ prereviewId: "toolu_self", source: "main", status: "done", endTree: b });
    expect(h.ofType("prereview").filter((e) => e.prereviewId === "toolu_self").at(-1)!.endTree).toBe(b);

    // A question turn that reports but changes nothing over no review: nothing kept.
    await h.engine.request({ type: "finish_review" });
    await h.settle();
    await h.engine.handle({ type: "send", text: "review again" });
    h.session().emit({ ...findingsCall(dir), id: "toolu_none" });
    h.session().emitTurnEnd({ toolFiles: [] });
    await h.waitFor((s) => s.gate.canSend, "turn done");
    await h.settle();
    expect(h.engine.state.gate.prereviews ?? []).toEqual([]);
  });
});
