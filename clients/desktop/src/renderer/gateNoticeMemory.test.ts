import { describe, expect, it } from "vitest";
import { carryGateNotices, dismissGateNotice, EMPTY_GATE_NOTICES, isGateNoticeShown } from "./reviewGate";

// wave2 check-clients — the same unreadable files are left out of every turn's snapshot until they are ignored: the engine
// clears `gate.snapshotSkipped` when a turn starts (gate.beginTurn) and fills it again with snapshot A. The banner the user
// closed came back at every turn ("같은 알림을 반복해 띄우지 않는다"); the Mac keeps it closed for the same files
// (2258d5e). Another set of files is another notice.

const skipped = (...paths: string[]) => paths.map((path) => ({ path, reason: "unreadable" as const }));

describe("gate notice memory — skipped files", () => {
  it("closed once stays closed while the same files are skipped turn after turn", () => {
    const reviewing = { phase: "reviewing" as const, snapshotSkipped: skipped("logs/root-owned.log") };
    let mem = dismissGateNotice(EMPTY_GATE_NOTICES, "skipped", reviewing);
    expect(isGateNoticeShown("skipped", reviewing, mem)).toBe(false);
    // The next turn starts (the list is cleared), snapshot A skips the same file again, the turn ends.
    const started = { phase: "running" as const, snapshotSkipped: [] };
    mem = carryGateNotices(mem, reviewing, started);
    const afterA = { phase: "running" as const, snapshotSkipped: skipped("logs/root-owned.log") };
    mem = carryGateNotices(mem, started, afterA);
    const done = { phase: "reviewing" as const, snapshotSkipped: skipped("logs/root-owned.log") };
    mem = carryGateNotices(mem, afterA, done);
    expect(isGateNoticeShown("skipped", done, mem)).toBe(false);
  });

  it("another set of unreadable files shows again; the per-turn banners still come back with the next turn", () => {
    const one = { phase: "reviewing" as const, snapshotSkipped: skipped("a.log") };
    let mem = dismissGateNotice(EMPTY_GATE_NOTICES, "skipped", one);
    const two = { phase: "reviewing" as const, snapshotSkipped: skipped("a.log", "b.log") };
    mem = carryGateNotices(mem, one, two);
    expect(isGateNoticeShown("skipped", two, mem)).toBe(true);
    // HEAD moved is about one turn: closed, then the next turn's move shows (unchanged behaviour).
    const head = { from: { sha: "a", branch: "x" }, to: { sha: "b", branch: "x" } };
    const moved = { phase: "reviewing" as const, headMoved: head };
    let m2 = dismissGateNotice(EMPTY_GATE_NOTICES, "headMoved", moved);
    m2 = carryGateNotices(m2, moved, { phase: "running" as const, headMoved: null });
    expect(isGateNoticeShown("headMoved", { phase: "reviewing", headMoved: head }, m2)).toBe(true);
  });
});
