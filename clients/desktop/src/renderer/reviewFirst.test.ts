import { describe, expect, it } from "vitest";
import type { ChangedFileState, ReviewState } from "@reviewgate/engine";
import { errorEventText, presentationOf } from "./errorCodes";
import { firstWaitingPath, holdTitle, REVIEW_FIRST_ROW, reviewFirstAcceptBlocker, reviewFirstBlockedText, reviewFirstHolds, reviewFirstModeLabel, reviewFirstModeOf } from "./reviewFirst";
import { EMPTY_QUEUE, enqueue, nextToSend } from "./sendQueue";
import { errorSubline, errorTone, queueStopOf } from "./sessionErrors";
import { settingApplies, settingEntry, searchSettings } from "./settingsIndex";

// §63 review first, as on the Mac (Core ReviewFirstTests.swift).

const file = (path: string, state: ChangedFileState["state"] = "pending"): ChangedFileState =>
  ({ path, oldPath: null, status: "M", added: 1, deleted: 0, isBinary: false, tools: ["Edit"], toolUseIds: ["e1"], state, noteCount: 0, origin: "tool" }) as ChangedFileState;

const state = (o: { pending?: number; changesRequested?: number; canSend?: boolean; files?: ChangedFileState[] } = {}): ReviewState =>
  ({ gate: { canSend: o.canSend ?? true, pendingCount: o.pending ?? 1, changesRequestedCount: o.changesRequested ?? 0 }, changedFiles: o.files ?? [] }) as unknown as ReviewState;

describe("review first (§63)", () => {
  it("the setting: edits by default, its three choices in the Mac's words", () => {
    expect(reviewFirstModeOf(undefined)).toBe("edits");
    expect(reviewFirstModeOf("bogus")).toBe("edits");
    expect(reviewFirstModeOf("prompts")).toBe("prompts");
    expect(["edits", "prompts", "off"].map((m) => reviewFirstModeLabel(m as never))).toEqual(["Block edits (default)", "Block prompts too", "Turn off"]);
    expect(settingEntry("reviewFirst")?.tab).toBe("review");
    expect(settingApplies("reviewFirst")).toBe("immediately");
    expect(searchSettings("waits for your review").map((e) => e.id)).toContain("reviewFirst");
  });

  it("prompts holds a plain message while files wait — never a slash command, never with edits or once nothing waits", () => {
    const prompts = { canSend: true, reviewFirst: { mode: "prompts" as const, waiting: 2, blocked: 0 } };
    expect(reviewFirstHolds(prompts, "go on")).toBe(true);
    expect(reviewFirstHolds(prompts, " /compact")).toBe(false);
    expect(reviewFirstHolds({ reviewFirst: { mode: "edits", waiting: 2, blocked: 1 } }, "go on")).toBe(false);
    expect(reviewFirstHolds({ reviewFirst: null }, "go on")).toBe(false);
    expect(reviewFirstHolds({}, "go on")).toBe(false); // an older engine
    const q = { ...EMPTY_QUEUE, items: enqueue([], "go on") };
    expect(nextToSend(q, prompts)).toBeNull();
    expect(nextToSend(q, { canSend: true, reviewFirst: null })?.text).toBe("go on");
    expect(holdTitle(2)).toBe("Finish the review first — 2 waiting");
  });

  it("[N개 수락 후 보내기] is off with a changes-requested file or a closed gate; [리뷰 열기] opens the first waiting file", () => {
    expect(reviewFirstAcceptBlocker(state())).toBeNull();
    expect(reviewFirstAcceptBlocker(state({ changesRequested: 1 }))).toContain("Request changes");
    expect(reviewFirstAcceptBlocker(state({ canSend: false }))).not.toBeNull();
    expect(firstWaitingPath(state({ files: [file("a.txt", "accepted"), file("b.txt", "changesRequested"), file("c.txt")] }))).toBe("b.txt");
    expect(firstWaitingPath(state({ files: [file("a.txt", "accepted")] }))).toBeNull();
  });

  it("a denied call is a gray row with its words — never a banner, a second line or a stopped queue", () => {
    expect(presentationOf(REVIEW_FIRST_ROW)).toBe("row");
    expect(errorTone(REVIEW_FIRST_ROW, false)).toBe("info");
    expect(queueStopOf({ fatal: false, code: REVIEW_FIRST_ROW })).toBe("none");
    expect(errorSubline({ code: REVIEW_FIRST_ROW, cliDetail: "3" })).toBe("");
    expect(errorEventText({ message: "engine words", fatal: false, scope: "session", code: REVIEW_FIRST_ROW, detail: "3" } as never)).toBe(reviewFirstBlockedText());
  });
});
