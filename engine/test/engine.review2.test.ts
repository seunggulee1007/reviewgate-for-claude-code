import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileDiff } from "../src/diff/parse.js";
import type { EngineCommand, TranscriptItem } from "../src/protocol.js";
import type { ReviewGate } from "../src/review/gate.js";
import { REVIEW_FILE } from "../src/review/persist.js";
import { sessionTranscriptPath } from "../src/review/sessions.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §34.1–34.5 (review round 2, the review half): the held B stays readable while a turn runs, accept during
 * a turn, this turn vs the whole review, diff ranges (`since`), notes that survive `request_changes`, blob, and the range
 * trees' pins / persistence.
 */

/** "l1".."ln". */
const svc = (n = 20): string[] => Array.from({ length: n }, (_, i) => `l${i + 1}`);
const text = (lines: string[]): string => lines.join("\n") + "\n";
/** Svc.java with `edits` (1-based line → text) applied to the original 20 lines. */
function svcWith(edits: Record<number, string>, extraTop: string[] = []): string {
  const lines = svc();
  for (const [no, t] of Object.entries(edits)) lines[Number(no) - 1] = t;
  return text([...extraTop, ...lines]);
}

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-review2"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "Svc.java", text(svc()));
  write(dir, "other.txt", "other\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const gateOf = (h: Harness): ReviewGate => (h.engine as unknown as { gate: ReviewGate }).gate;
const adds = (d: FileDiff): string[] => d.hunks.flatMap((x) => x.lines.filter((l) => l.kind === "add").map((l) => l.text));
const dels = (d: FileDiff): string[] => d.hunks.flatMap((x) => x.lines.filter((l) => l.kind === "del").map((l) => l.text));

/** Ends the running turn with `files` edited by Edit calls and waits for its collection. */
async function collect(h: Harness, dir: string, files: string[]): Promise<void> {
  const turn = h.engine.state.hud.turnCount;
  h.session().emitTurnEnd({ toolFiles: files.map((f) => ({ path: join(dir, f), tools: ["Edit"], count: 1, toolUseIds: [`${f}@${turn}`] })) });
  await h.waitFor((s) => s.hud.turnCount > turn && s.gate.turnEndTree !== null && s.gate.phase !== "running" && s.gate.phase !== "collecting", "collection");
  await h.settle();
}

/** Turn 1: Svc.java line 2 rewritten, new.txt added. */
async function firstTurn(h: Harness, dir: string): Promise<void> {
  await h.hello({ budget: { maxFiles: 50, maxLines: 5000 } });
  await h.open(dir);
  await h.engine.request({ type: "send", text: "change Svc" });
  h.session().emitSessionInfo();
  write(dir, "Svc.java", svcWith({ 2: "l2 changed" }));
  write(dir, "new.txt", "brand new\n");
  await collect(h, dir, ["Svc.java", "new.txt"]);
  expect(h.engine.state.gate.phase).toBe("reviewing");
}

async function waitUntil(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function rangeRefs(dir: string): string[] {
  return sh(dir, "for-each-ref", "--format=%(refname)", "refs/reviewgate/main/range/").split("\n").filter(Boolean);
}

describe("§34.2 reviewing while a turn runs", () => {
  it("a question over a standing review keeps the held B readable (stale) until its collection replaces it", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await firstTurn(h, dir);
    const s1 = h.engine.state;
    const a = s1.gate.turnStartTree!;
    const b1 = s1.gate.turnEndTree!;
    expect(s1.gate.reviewEndTree).toBe(b1);
    const reviewed = await h.engine.request({ type: "select_file", path: "Svc.java" });
    expect(reviewed).toMatchObject({ scope: "turn", endTree: b1, baseTree: a });
    expect(reviewed.stale).toBeUndefined();
    expect(reviewed.since).toBeUndefined();

    await h.engine.request({ type: "send", text: "why l2?" });
    write(dir, "Svc.java", svcWith({ 2: "l2 changed", 15: "l15 by the answer" }));
    const running = h.engine.state;
    expect(running.gate.phase).toBe("running");
    expect(running.gate.turnEndTree).toBeNull();
    expect(running.gate.reviewEndTree).toBe(b1);
    const stale = await h.engine.request({ type: "select_file", path: "Svc.java" });
    expect(stale).toMatchObject({ scope: "turn", endTree: b1, baseTree: a, stale: true });
    expect(stale.diff).toEqual(reviewed.diff);
    const full = await h.engine.request({ type: "full_file", path: "Svc.java" });
    expect(full).toMatchObject({ stale: true, endTree: b1, changedNewLines: [2] });
    expect(full.lines[14]).toBe("l15"); // the held B's content, not the file the turn is editing

    await collect(h, dir, ["Svc.java"]);
    const s2 = h.engine.state;
    expect(s2.gate.reviewEndTree).toBe(s2.gate.turnEndTree);
    expect(s2.gate.reviewEndTree).not.toBe(b1);
    const fresh = await h.engine.request({ type: "select_file", path: "Svc.java" });
    expect(fresh.stale).toBeUndefined();
    expect(fresh.endTree).toBe(s2.gate.turnEndTree);
    expect(adds(fresh.diff)).toEqual(["l2 changed", "l15 by the answer"]);
  });

  it("a side question asked while the turn runs gets the held B's hunk as its anchor (and a promoted note its line)", async () => {
    const dir = track(makeRepo());
    const prompts: string[] = [];
    const h = makeHarness({
      sideQueryFactory: (o) => {
        prompts.push(o.prompt);
        return {
          run: async () => {
            o.emit({ type: "session", sessionId: "side-1" });
            o.emit({ type: "text_delta", text: "because" });
            return { sessionId: "side-1", text: "because", costUSD: 0, durationMs: 1, stopReason: "success", error: null, sawOutput: true };
          },
          interrupt: async () => {},
          dispose: async () => {},
        };
      },
    });
    harnesses.push(h);
    await firstTurn(h, dir);
    await h.engine.request({ type: "send", text: "keep going" });
    write(dir, "Svc.java", svcWith({ 2: "l2 changed", 15: "l15 by the turn" }));
    const t = (await h.engine.request({ type: "side_ask", anchor: { path: "Svc.java", line: 2, side: "new" }, question: "왜 바꿨어?" })).thread;
    expect(prompts[0]).toContain("+l2 changed");
    expect(prompts[0]).not.toContain("l15 by the turn");
    await h.waitFor(() => h.ofType("side_turn_end").length > 0, "side answer");
    await h.engine.request({ type: "side_promote", threadId: t.id, as: "note", text: "keep it" });
    expect(h.engine.state.reviewNotes.map((n) => [n.line, n.excerpt])).toEqual([[2, "l2 changed"]]);
    await collect(h, dir, ["Svc.java"]);
  });

  it("after a fresh send (nothing pending) there is no review B: the decided files stay listed without a diff", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await firstTurn(h, dir);
    await h.engine.request({ type: "accept_all" });
    await h.engine.request({ type: "send", text: "next" });
    const s = h.engine.state;
    expect(s.gate.phase).toBe("running");
    expect(s.gate.reviewEndTree).toBeNull();
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["Svc.java", "accepted"], ["new.txt", "accepted"]]);
    await expect(h.engine.request({ type: "select_file", path: "Svc.java" })).rejects.toThrow("no_review");
    await expect(h.engine.request({ type: "accept", paths: ["Svc.java"] })).rejects.toThrow("session_running");
  });

  it("accept during a turn applies at once; the collection keeps it only when the turn left the file alone", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await firstTurn(h, dir);
    const b1 = h.engine.state.gate.turnEndTree!;
    await h.engine.request({ type: "send", text: "append to new.txt" });
    await h.engine.request({ type: "accept", paths: ["Svc.java"] });
    let s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["Svc.java", "accepted"], ["new.txt", "pending"]]);
    expect(s.gate.lastReviewSummary).toBe("[Review gate] Accepted: Svc.java.");
    await h.engine.request({ type: "accept_all" });
    s = h.engine.state;
    expect(s.gate.pendingCount).toBe(0);
    expect(s.gate.lastReviewSummary).toBe("[Review gate] Accepted: Svc.java, new.txt.");
    // Reverts stay refused while the turn runs (its own collection would swallow them, §3) — but a reject waits for the
    // turn's end instead (M32): of an accepted file it is a no-op, as outside a turn.
    const refused: EngineCommand[] = [
      { type: "reject_hunks", path: "Svc.java", hunks: [0] },
      { type: "finish_review" },
    ];
    for (const cmd of refused) await expect(h.engine.request(cmd), cmd.type).rejects.toThrow("session_running");
    await h.engine.request({ type: "reject", paths: ["Svc.java"] });
    expect(h.engine.state.changedFiles.find((f) => f.path === "Svc.java")).toMatchObject({ state: "accepted" });
    expect(h.engine.state.changedFiles.some((f) => f.rejectScheduled)).toBe(false);

    write(dir, "new.txt", "brand new\nappended\n");
    await collect(h, dir, ["new.txt"]);
    s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.state, f.changedSinceAccepted ?? false])).toEqual([
      ["Svc.java", "accepted", false],
      ["new.txt", "pending", true],
    ]);
    // The file the turn changed after the accept leaves the next message's accepted list.
    expect(s.gate.lastReviewSummary).toBe("[Review gate] Accepted: Svc.java.");
    const since = await h.engine.request({ type: "select_file", path: "new.txt", since: "accepted" });
    expect(since).toMatchObject({ since: "accepted", baseTree: b1, endTree: s.gate.turnEndTree });
    expect(adds(since.diff)).toEqual(["appended"]);
    expect(dels(since.diff)).toEqual([]);
    const history = await h.engine.request({ type: "review_history" });
    expect(history.current?.files.map((f) => [f.path, f.verdict])).toEqual([["Svc.java", "accepted"], ["new.txt", "pending"]]);

    await h.engine.request({ type: "accept", paths: ["new.txt"] });
    expect(h.engine.state.changedFiles.find((f) => f.path === "new.txt")?.changedSinceAccepted).toBeUndefined();
  });

  it("a collection that fails on this turn's delta leaves the merge to the retry (nothing of the review is touched)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await firstTurn(h, dir);
    await h.engine.request({ type: "accept", paths: ["new.txt"] });
    await h.engine.request({ type: "send", text: "and l15" });
    const gate = gateOf(h) as unknown as { runningTurnBase: string | null };
    gate.runningTurnBase = "0123456789012345678901234567890123456789"; // a start tree git cannot read
    write(dir, "Svc.java", svcWith({ 2: "l2 changed", 15: "l15 again" }));
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e2"] }] });
    let s = await h.waitFor((x) => x.gate.phase === "collect_failed", "collect failure");
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["Svc.java", "pending"], ["new.txt", "accepted"]]);
    expect(s.gate.reviewEndTree).not.toBeNull(); // still the held B, readable
    gate.runningTurnBase = null; // the retry falls back to the held B
    await h.engine.request({ type: "retry_collect" });
    s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.gate.turnEndTree !== null, "retried");
    expect(s.changedFiles.map((f) => [f.path, f.state, f.changedThisTurn ?? false])).toEqual([["Svc.java", "pending", true], ["new.txt", "accepted", false]]);
    expect(h.ofType("turn_end").at(-1)).toMatchObject({ files: 1, merged: true, review: { files: 2 } });
  });

  it("accept is refused while the turn's changes are being collected", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await firstTurn(h, dir);
    await h.engine.request({ type: "send", text: "q" });
    const gate = gateOf(h);
    gate.collecting = true;
    await expect(h.engine.request({ type: "accept", paths: ["Svc.java"] })).rejects.toThrow("session_running");
    await expect(h.engine.request({ type: "accept_all" })).rejects.toThrow("session_running");
    gate.collecting = false;
    expect(h.engine.state.changedFiles.every((f) => f.state === "pending")).toBe(true);
    await collect(h, dir, []);
  });
});

describe("§34.3 this turn vs the whole review", () => {
  it("turn_end / turn_summary count this turn with the review totals; a question that changes nothing has no summary", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await firstTurn(h, dir);
    expect(h.ofType("turn_end").at(-1)).toMatchObject({ files: 2, added: 2, deleted: 1, external: 0, review: { files: 2, added: 2, deleted: 1 } });
    expect(h.ofType("turn_end").at(-1)!.merged).toBeUndefined();
    let sum = h.ofType("turn_summary").at(-1)!;
    expect(sum.files.map((f) => [f.path, f.adds, f.dels, f.reviewAdds, f.reviewDels])).toEqual([
      ["Svc.java", 1, 1, 1, 1],
      ["new.txt", 1, 0, 1, 0],
    ]);
    expect(sum.review).toEqual({ files: 2, added: 2, deleted: 1 });
    expect(sum.merged).toBeUndefined();
    let s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.changedThisTurn, f.turnAdded, f.turnDeleted])).toEqual([
      ["Svc.java", true, 1, 1],
      ["new.txt", true, 1, 0],
    ]);
    expect(s.gate.lastTurnChanges).toEqual({ turn: 1, files: 2, added: 2, deleted: 1 });
    expect(s.gate.reviewTurns).toEqual([1]);

    // Turn 2: a question that changes nothing.
    await h.engine.request({ type: "send", text: "explain" });
    await collect(h, dir, []);
    expect(h.ofType("turn_end").at(-1)).toMatchObject({ files: 0, added: 0, deleted: 0, external: 0, review: { files: 2, added: 2, deleted: 1 }, merged: true });
    expect(h.ofType("turn_summary")).toHaveLength(1);
    s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.changedThisTurn, f.turnAdded, f.turnDeleted])).toEqual([[undefined, undefined, undefined], [undefined, undefined, undefined]]);
    expect(s.gate.lastTurnChanges).toEqual({ turn: 2, files: 0, added: 0, deleted: 0 });
    expect(s.gate.reviewTurns).toEqual([1, 2]);

    // Turn 3: the answer rewrites l15 of Svc.java and adds third.txt; new.txt stays as it was.
    await h.engine.request({ type: "send", text: "and l15" });
    write(dir, "Svc.java", svcWith({ 2: "l2 changed", 15: "l15 by turn 3" }));
    write(dir, "third.txt", "3\n");
    await collect(h, dir, ["Svc.java", "third.txt"]);
    expect(h.ofType("turn_end").at(-1)).toMatchObject({ files: 2, added: 2, deleted: 1, external: 0, review: { files: 3, added: 4, deleted: 2 }, merged: true });
    sum = h.ofType("turn_summary").at(-1)!;
    expect(sum.turn).toBe(3);
    expect(sum.files.map((f) => [f.path, f.adds, f.dels, f.reviewAdds, f.reviewDels])).toEqual([
      ["Svc.java", 1, 1, 2, 2],
      ["third.txt", 1, 0, 1, 0],
    ]);
    expect(sum).toMatchObject({ review: { files: 3, added: 4, deleted: 2 }, merged: true });
    s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.changedThisTurn ?? false])).toEqual([["Svc.java", true], ["new.txt", false], ["third.txt", true]]);
    expect(s.gate.lastTurnChanges).toEqual({ turn: 3, files: 2, added: 2, deleted: 1 });
    const turnDiff = await h.engine.request({ type: "select_file", path: "Svc.java", since: "turn" });
    expect(turnDiff.since).toBe("turn");
    expect(turnDiff.baseTree).not.toBe(s.gate.turnStartTree);
    expect([adds(turnDiff.diff), dels(turnDiff.diff)]).toEqual([["l15 by turn 3"], ["l15"]]);
    const untouched = await h.engine.request({ type: "select_file", path: "new.txt", since: "turn" });
    expect(untouched.diff.hunks).toEqual([]);

    // Turn 4: the IDE saves other.txt while a question runs: the turn's only change, nothing of Claude's explains it.
    await h.engine.request({ type: "send", text: "anything else?" });
    write(dir, "other.txt", "saved by the IDE\n");
    await collect(h, dir, []);
    expect(h.ofType("turn_end").at(-1)).toMatchObject({ files: 1, added: 1, deleted: 1, external: 1, review: { files: 4 }, merged: true });
    expect(h.ofType("turn_summary").at(-1)!.files.map((f) => [f.path, f.origin])).toEqual([["other.txt", "external"]]);

    // The transcript rows carry the same fields.
    const rows = readFileSync(sessionTranscriptPath(join(dir, ".git"), h.engine.state.sessions.currentId!), "utf8").trim().split("\n").map((l) => JSON.parse(l) as TranscriptItem);
    const ends = rows.filter((r): r is Extract<TranscriptItem, { kind: "turn_end" }> => r.kind === "turn_end");
    expect(ends.map((r) => [r.files, r.review?.files, r.merged ?? false])).toEqual([[2, 2, false], [0, 2, true], [2, 3, true], [1, 4, true]]);
  });
});

describe("§34.1 diff ranges", () => {
  it("since turn / request / accepted with baseTree; refusals; reject_hunks only takes the hunk ids of A's diff", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await firstTurn(h, dir);
    const a = h.engine.state.gate.turnStartTree!;
    await expect(h.engine.request({ type: "select_file", path: "Svc.java", since: "last_turn" as never })).rejects.toThrow("invalid_since");
    await expect(h.engine.request({ type: "select_file", path: "Svc.java", since: "request" })).rejects.toThrow("range_unavailable:request");
    await expect(h.engine.request({ type: "full_file", path: "Svc.java", since: "accepted" })).rejects.toThrow("range_unavailable:accepted");
    await expect(h.engine.request({ type: "select_file", path: "nope.txt", since: "turn" })).rejects.toThrow("not_a_changed_file:nope.txt");
    const codes = h.ofType("result").filter((r) => !r.ok).map((r) => (r.ok ? "" : r.code));
    expect(codes).toEqual(["invalid_since", "range_unavailable", "range_unavailable", "not_a_changed_file"]);
    // The first collection's turn base is A itself.
    const t1 = await h.engine.request({ type: "select_file", path: "Svc.java", since: "turn" });
    expect(t1).toMatchObject({ since: "turn", baseTree: a });

    // Turn 2 rewrites l15: "this turn" shows only that; full_file follows the range.
    await h.engine.request({ type: "send", text: "l15 too" });
    write(dir, "Svc.java", svcWith({ 2: "l2 changed", 15: "l15 by turn 2" }));
    await collect(h, dir, ["Svc.java"]);
    const b2 = h.engine.state.gate.turnEndTree!;
    const t2 = await h.engine.request({ type: "select_file", path: "Svc.java", since: "turn" });
    expect([adds(t2.diff), dels(t2.diff)]).toEqual([["l15 by turn 2"], ["l15"]]);
    expect(t2.baseTree).not.toBe(a);
    expect(t2.endTree).toBe(b2);
    const ff = await h.engine.request({ type: "full_file", path: "Svc.java", since: "turn" });
    expect(ff).toMatchObject({ since: "turn", endTree: b2, changedNewLines: [15], deletedAfterNewLine: { "14": ["l15"] } });
    expect(ff.stale).toBeUndefined();
    expect(ff.oldText).toBe(svcWith({ 2: "l2 changed" }));
    const whole = await h.engine.request({ type: "select_file", path: "Svc.java" });
    expect(whole.diff.hunks).toHaveLength(2);

    // Hunk ids of another range are refused; A's are taken.
    await expect(h.engine.request({ type: "reject_hunks", path: "Svc.java", hunks: [0], expectedBaseTree: t2.baseTree! })).rejects.toThrow("stale_diff");
    await h.engine.request({ type: "reject_hunks", path: "Svc.java", hunks: [1], expectedEndTree: whole.endTree!, expectedBaseTree: whole.baseTree! });
    expect(read(dir, "Svc.java")).toBe(svcWith({ 2: "l2 changed" }));
    expect(h.engine.state.changedFiles.find((f) => f.path === "Svc.java")?.partial).toBe(true);
  });
});

describe("§34.4 notes after request_changes", () => {
  it("only unsent notes go; sent ones stay (moved / gone with the new B); changedSinceRequest and the history's current round", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await firstTurn(h, dir);
    const b1 = h.engine.state.gate.turnEndTree!;
    await h.engine.request({ type: "add_note", path: "Svc.java", line: 4, side: "new", excerpt: "l4", body: "keep l4" });
    await h.engine.request({ type: "add_note", path: "Svc.java", line: 2, side: "new", excerpt: "l2 changed", body: "redo l2" });
    await h.engine.request({ type: "request_changes" });
    expect(h.session().sends.at(-1)!.text).toBe(
      "[Review gate] Requested changes on this turn's diff. Keep the other changes as they are.\n- Svc.java:4 (new) `l4` — keep l4\n- Svc.java:2 (new) `l2 changed` — redo l2",
    );
    let s = h.engine.state;
    expect(s.reviewNotes.map((n) => [n.body, n.sent?.turn])).toEqual([["keep l4", 2], ["redo l2", 2]]);
    expect(s.gate.lastRequest).toMatchObject({ turn: 2, notes: 2 });
    expect(s.gate.canRequestChanges).toBe(false);
    expect(s.changedFiles.find((f) => f.path === "Svc.java")).toMatchObject({ noteCount: 0, sentNoteCount: 2, state: "changesRequested" });

    // The follow-up adds a header line and redoes l2.
    write(dir, "Svc.java", svcWith({ 2: "l2 redone" }, ["header"]));
    await collect(h, dir, ["Svc.java"]);
    s = h.engine.state;
    expect(s.reviewNotes.map((n) => [n.body, n.line, n.anchor ?? null, n.sent?.turn])).toEqual([
      ["keep l4", 5, "moved", 2],
      ["redo l2", 2, "gone", 2],
    ]);
    expect(s.changedFiles.map((f) => [f.path, f.state, f.changedSinceRequest ?? false, f.noteCount, f.sentNoteCount ?? 0])).toEqual([
      ["Svc.java", "pending", true, 0, 2],
      ["new.txt", "pending", false, 0, 0],
    ]);
    expect(s.gate.canRequestChanges).toBe(false);
    const since = await h.engine.request({ type: "select_file", path: "Svc.java", since: "request" });
    expect(since).toMatchObject({ since: "request", baseTree: b1 });
    expect([adds(since.diff), dels(since.diff)]).toEqual([["header", "l2 redone"], ["l2 changed"]]);

    // A new note goes with the next request — alone.
    await h.engine.request({ type: "add_note", path: "new.txt", line: 1, side: "new", excerpt: "brand new", body: "rename it" });
    expect(h.engine.state.gate.canRequestChanges).toBe(true);
    await h.engine.request({ type: "request_changes" });
    expect(h.session().sends.at(-1)!.text).toBe("[Review gate] Requested changes on this turn's diff. Keep the other changes as they are.\n- new.txt:1 (new) `brand new` — rename it");
    expect(h.engine.state.gate.lastRequest).toMatchObject({ turn: 3, notes: 1 });
    // The new request tree is the B it went out from: nothing has changed since it yet.
    expect(h.engine.state.changedFiles.map((f) => f.changedSinceRequest ?? false)).toEqual([false, false]);
    await collect(h, dir, []);
    s = h.engine.state;
    expect(s.reviewNotes.map((n) => [n.body, n.sent?.turn])).toEqual([["keep l4", 2], ["redo l2", 2], ["rename it", 3]]);
    expect(s.changedFiles.map((f) => f.changedSinceRequest ?? false)).toEqual([false, false]);

    // "반영 확인" is remove_note; the round in progress is the history's `current`.
    await h.engine.request({ type: "remove_note", noteId: s.reviewNotes[1]!.id });
    expect(h.engine.state.reviewNotes.map((n) => n.body)).toEqual(["keep l4", "rename it"]);
    const history = await h.engine.request({ type: "review_history" });
    expect(history.entries).toEqual([]);
    const cur = history.current!;
    expect(cur).toMatchObject({ inProgress: true, turns: [1, 2, 3], prompt: "change Svc", turnEndTree: h.engine.state.gate.reviewEndTree });
    expect(cur.notes.map((n) => n.body)).toEqual(["keep l4", "redo l2", "rename it"]);
    const d = await h.engine.request({ type: "history_diff", entryId: cur.id, path: "Svc.java" });
    expect(adds(d.diff)).toEqual(["header", "l2 redone"]);
  });

  it("a refused request_changes leaves its notes unsent and no lastRequest", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await firstTurn(h, dir);
    await h.engine.request({ type: "add_note", path: "Svc.java", line: 2, side: "new", excerpt: "l2 changed", body: "no" });
    h.session().refuseSends = new Error("session closed");
    await h.engine.handle({ type: "request_changes" });
    const s = h.engine.state;
    expect(s.reviewNotes.map((n) => n.sent ?? null)).toEqual([null]);
    expect(s.gate.lastRequest).toBeNull();
    expect(s.gate.reviewEndTree).toBe(s.gate.turnEndTree);
    expect(s.gate.canRequestChanges).toBe(true);
  });

  it("notes left during a question turn follow the answer's B; old-side notes never move", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await firstTurn(h, dir);
    await h.engine.request({ type: "send", text: "add a header" });
    await h.engine.request({ type: "add_note", path: "Svc.java", line: 10, side: "new", excerpt: "l10", body: "new side" });
    await h.engine.request({ type: "add_note", path: "Svc.java", line: 10, side: "old", excerpt: "l10", body: "old side" });
    write(dir, "Svc.java", svcWith({ 2: "l2 changed" }, ["header"]));
    await collect(h, dir, ["Svc.java"]);
    expect(h.engine.state.reviewNotes.map((n) => [n.body, n.line, n.anchor ?? null])).toEqual([
      ["new side", 11, "moved"],
      ["old side", 10, null],
    ]);
  });
});

describe("§34.5 blob", () => {
  it("is B's entry id of the path (absent for a deleted file) and stays put while other files move", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello({ budget: { maxFiles: 50, maxLines: 5000 } });
    await h.open(dir);
    await h.engine.request({ type: "send", text: "go" });
    write(dir, "Svc.java", svcWith({ 2: "l2 changed" }));
    write(dir, "new.txt", "brand new\n");
    rmSync(join(dir, "other.txt"));
    await collect(h, dir, ["Svc.java", "new.txt", "other.txt"]);
    let s = h.engine.state;
    const b = s.gate.turnEndTree!;
    const id = (tree: string, p: string) => sh(dir, "rev-parse", `${tree}:${p}`).trim();
    expect(s.changedFiles.map((f) => [f.path, f.status, f.blob ?? null])).toEqual([
      ["Svc.java", "M", id(b, "Svc.java")],
      ["new.txt", "A", id(b, "new.txt")],
      ["other.txt", "D", null],
    ]);
    const svcBlob = s.changedFiles[0]!.blob;
    await h.engine.request({ type: "reject", paths: ["new.txt"] });
    s = h.engine.state;
    expect(s.gate.turnEndTree).not.toBe(b);
    expect(s.changedFiles.find((f) => f.path === "Svc.java")?.blob).toBe(svcBlob);
    // While a question runs, the blobs are the held B's.
    await h.engine.request({ type: "send", text: "q" });
    write(dir, "Svc.java", svcWith({ 2: "l2 changed", 3: "l3 too" }));
    expect(h.engine.state.changedFiles.find((f) => f.path === "Svc.java")?.blob).toBe(svcBlob);
    await collect(h, dir, ["Svc.java"]);
    const after = h.engine.state;
    expect(after.changedFiles.find((f) => f.path === "Svc.java")?.blob).toBe(id(after.gate.turnEndTree!, "Svc.java"));
  });
});

describe("§34.1 range trees: pins and persistence", () => {
  it("are pinned while referenced, restored with the review (gone trees: unavailable) and unpinned when the review ends", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await firstTurn(h, dir);
    const b1 = h.engine.state.gate.turnEndTree!;
    await h.engine.request({ type: "accept", paths: ["new.txt"] });
    await h.engine.request({ type: "add_note", path: "Svc.java", line: 2, side: "new", excerpt: "l2 changed", body: "redo" });
    await h.engine.request({ type: "request_changes" });
    write(dir, "Svc.java", svcWith({ 2: "l2 redone" }));
    await collect(h, dir, ["Svc.java"]);
    const turnBase = (await h.engine.request({ type: "select_file", path: "Svc.java", since: "turn" })).baseTree!;
    await waitUntil(() => {
      const r = rangeRefs(dir);
      return r.includes(`refs/reviewgate/main/range/${b1}`) && r.includes(`refs/reviewgate/main/range/${turnBase}`);
    }, "range pins");
    await h.engine.dispose();

    // A new engine restores the review with its ranges.
    const h2 = harness();
    await h2.hello();
    await h2.open(dir);
    let s = h2.engine.state;
    expect(s.gate.restored).toBe(true);
    expect(s.gate.lastRequest).toMatchObject({ turn: 2, notes: 1 });
    expect(s.gate.lastTurnChanges).toMatchObject({ turn: 2, files: 1 });
    expect(s.reviewNotes.map((n) => n.sent?.turn)).toEqual([2]);
    expect(s.changedFiles.map((f) => [f.path, f.state, f.changedThisTurn ?? false, f.changedSinceRequest ?? false])).toEqual([
      ["Svc.java", "pending", true, true],
      ["new.txt", "accepted", false, false],
    ]);
    expect((await h2.engine.request({ type: "select_file", path: "Svc.java", since: "request" })).baseTree).toBe(b1);
    expect((await h2.engine.request({ type: "select_file", path: "new.txt", since: "accepted" })).baseTree).toBe(b1);
    expect((await h2.engine.request({ type: "select_file", path: "Svc.java", since: "turn" })).baseTree).toBe(turnBase);
    await h2.engine.dispose();

    // A range tree that is gone (pruned) is simply unavailable after a restore — and so are the marks that would offer it.
    const file = join(dir, ".git", REVIEW_FILE);
    const gone = "0123456789012345678901234567890123456789";
    const saved = JSON.parse(readFileSync(file, "utf8")) as { ranges: { requestTree: string; turnBaseTree: string }; changedFiles: { path: string; changedSinceAccepted?: true }[] };
    saved.ranges.requestTree = gone;
    saved.ranges.turnBaseTree = gone;
    saved.changedFiles.find((f) => f.path === "Svc.java")!.changedSinceAccepted = true; // no accepted tree behind it
    writeFileSync(file, JSON.stringify(saved));
    const h3 = harness();
    await h3.hello();
    await h3.open(dir);
    s = h3.engine.state;
    expect(s.gate.lastRequest).toBeNull();
    expect(s.gate.lastTurnChanges).toBeNull();
    expect(s.changedFiles.map((f) => [f.path, f.changedSinceRequest ?? false, f.changedThisTurn ?? false, f.changedSinceAccepted ?? false])).toEqual([
      ["Svc.java", false, false, false],
      ["new.txt", false, false, false],
    ]);
    await expect(h3.engine.request({ type: "select_file", path: "Svc.java", since: "request" })).rejects.toThrow("range_unavailable:request");
    await expect(h3.engine.request({ type: "select_file", path: "Svc.java", since: "turn" })).rejects.toThrow("range_unavailable:turn");
    expect((await h3.engine.request({ type: "select_file", path: "new.txt", since: "accepted" })).baseTree).toBe(b1);

    // The pins go with the review.
    await h3.engine.request({ type: "finish_review" });
    await waitUntil(() => !existsSync(file) && rangeRefs(dir).length === 0, "range pins dropped");
  });
});
