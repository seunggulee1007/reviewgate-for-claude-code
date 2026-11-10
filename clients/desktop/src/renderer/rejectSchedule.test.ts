import { describe, expect, it } from "vitest";
import type { ChangedFileState } from "@reviewgate/engine";
import { errorEventText, presentationOf } from "./errorCodes";
import { hunkRejectBlockedReason, rejectBlockedReason } from "./reviewRound";
import { asksStill, isReviewFlowRow, rejectAskedPath, reviewFlowNoticeText } from "./rejectSchedule";
import { errorSubline, errorTone, queueStopOf } from "./sessionErrors";

// MARK: r2-review-flow — M32, as on the Mac (Core ReviewFlowRejectTests.swift).

const file = (path: string, state: ChangedFileState["state"] = "pending", extra: Partial<ChangedFileState> = {}): ChangedFileState =>
  ({ path, oldPath: null, status: "M", added: 1, deleted: 0, isBinary: false, tools: ["Edit"], toolUseIds: ["e1"], state, noteCount: 0, origin: "tool", ...extra }) as ChangedFileState;

describe("a reject while Claude works (M32, §34.2)", () => {
  it("is taken on a standing review (a held B); a fresh turn and hunks still wait for the turn's end", () => {
    const running = (reviewEndTree: string | null) => ({ gate: { phase: "running", reviewEndTree, reviewTurns: [1], lastTurnChanges: null, lastRequest: null, collectError: null } }) as never;
    expect(rejectBlockedReason(running("b"))).toBeNull();
    expect(rejectBlockedReason(running(null))).toBe("Reject is available when this turn ends");
    expect(hunkRejectBlockedReason(running("b"))).toBe("Reject is available when this turn ends");
  });

  it("its rows are gray rows with their words, never a banner or a stopped queue; the changed-again row asks while the file is pending", () => {
    for (const code of ["reject_scheduled", "reject_applied", "reject_changed_again"]) {
      expect(isReviewFlowRow(code)).toBe(true);
      expect(presentationOf(code)).toBe("row");
      expect(errorTone(code, false)).toBe("info");
      expect(queueStopOf({ fatal: false, code })).toBe("none");
      expect(errorSubline({ code, cliDetail: "a.txt" })).toBe("");
    }
    expect(reviewFlowNoticeText({ code: "reject_scheduled", detail: "src/Svc.java, new.txt" })).toBe(
      "Rejected while Claude works: src/Svc.java, new.txt — reverted when the turn ends; Claude was told not to build on it",
    );
    expect(errorEventText({ message: "x", fatal: false, scope: "session", code: "reject_applied", detail: "new.txt" } as never)).toBe("Reverted as you asked while Claude worked: new.txt");
    expect(rejectAskedPath("reject_changed_again", " src/Svc.java ")).toBe("src/Svc.java");
    expect(rejectAskedPath("reject_applied", "src/Svc.java")).toBeNull();
    expect(asksStill("a.txt", [file("a.txt")])).toBe(true);
    expect(asksStill("a.txt", [file("a.txt", "accepted")])).toBe(false);
    expect(asksStill("a.txt", [file("a.txt", "pending", { rejectScheduled: true })])).toBe(false);
  });
});
