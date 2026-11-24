import { describe, expect, it } from "vitest";
import type { ChangedFileState, ReviewState } from "@reviewgate/engine";
import { errorEventText, presentationOf } from "./errorCodes";
import {
  allowReviewFirstTurn,
  firstWaitingPath,
  holdTitle,
  REVIEW_FIRST_ROW,
  reviewFirstAcceptBlocker,
  reviewFirstAllowTurnBlocker,
  reviewFirstBlockedHelp,
  reviewFirstBlockedText,
  reviewFirstHolds,
  reviewFirstModeLabel,
  reviewFirstModeOf,
} from "./reviewFirst";
import { EMPTY_QUEUE, enqueue, nextToSend } from "./sendQueue";
import { errorSubline, errorTone, queueStopOf } from "./sessionErrors";
import { settingApplies, settingEntry, searchSettings } from "./settingsIndex";

// §64 review first, as on the Mac (Core ReviewFirstTests.swift).

const file = (path: string, state: ChangedFileState["state"] = "pending"): ChangedFileState =>
  ({ path, oldPath: null, status: "M", added: 1, deleted: 0, isBinary: false, tools: ["Edit"], toolUseIds: ["e1"], state, noteCount: 0, origin: "tool" }) as ChangedFileState;

const state = (o: { pending?: number; changesRequested?: number; canSend?: boolean; files?: ChangedFileState[] } = {}): ReviewState =>
  ({ gate: { canSend: o.canSend ?? true, pendingCount: o.pending ?? 1, changesRequestedCount: o.changesRequested ?? 0 }, changedFiles: o.files ?? [] }) as unknown as ReviewState;

describe("review first (§64)", () => {
  it("the setting: edits by default, its three choices in the Mac's words", () => {
    expect(reviewFirstModeOf(undefined)).toBe("edits");
    expect(reviewFirstModeOf("bogus")).toBe("edits");
    expect(reviewFirstModeOf("prompts")).toBe("prompts");
    expect(["edits", "prompts", "off"].map((m) => reviewFirstModeLabel(m as never))).toEqual(["Only files under review (default)", "Block prompts too", "Turn off"]);
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

  it("the default lets the files under review be fixed: the ⓘ and the chip's tooltip say so", () => {
    const info = settingEntry("reviewFirst")?.info ?? "";
    expect(info).toContain("may fix the files under review");
    expect(info).toContain("Bash commands run");
    expect(reviewFirstBlockedHelp()).toContain("may fix them but not change other files");
    expect(reviewFirstBlockedHelp("edits")).toBe(reviewFirstBlockedHelp());
    expect(reviewFirstBlockedHelp("prompts")).toContain("it may not change files");
  });

  it("[이번 턴만 허용] goes only while a turn runs and not twice; a no_turn refusal says nothing", async () => {
    const gate = (phase: string, allowedThisTurn?: true) => ({ gate: { phase, reviewFirst: { mode: "edits" as const, waiting: 1, blocked: 1, ...(allowedThisTurn ? { allowedThisTurn } : {}) } } }) as never;
    expect(reviewFirstAllowTurnBlocker(gate("reviewing"))).toBe("Claude isn't working on a turn right now");
    expect(reviewFirstAllowTurnBlocker(gate("running"))).toBeNull();
    expect(reviewFirstAllowTurnBlocker(gate("running", true))).toBe("This turn is already allowed");
    const sent: unknown[] = [];
    const bridge = (answer: { ok: true; reply: unknown } | { ok: false; error: string; code?: string }) => ({
      request: async () => undefined as never,
      requestDetailed: async (cmd: unknown) => {
        sent.push(cmd);
        return answer as never;
      },
    });
    expect(await allowReviewFirstTurn(bridge({ ok: true, reply: undefined }))).toBeNull();
    expect(sent).toEqual([{ type: "review_first_allow_turn" }]);
    expect(await allowReviewFirstTurn(bridge({ ok: false, error: "no_turn", code: "no_turn" }))).toBeNull();
    expect(await allowReviewFirstTurn(bridge({ ok: false, error: "engine_gone: the engine stopped", code: "engine_gone" }))).toBe("engine_gone: the engine stopped");
  });

  it("a denied call is a gray row with its words — never a banner, a second line or a stopped queue", () => {
    expect(presentationOf(REVIEW_FIRST_ROW)).toBe("row");
    expect(errorTone(REVIEW_FIRST_ROW, false)).toBe("info");
    expect(queueStopOf({ fatal: false, code: REVIEW_FIRST_ROW })).toBe("none");
    expect(errorSubline({ code: REVIEW_FIRST_ROW, cliDetail: "3" })).toBe("");
    expect(errorEventText({ message: "engine words", fatal: false, scope: "session", code: REVIEW_FIRST_ROW, detail: "3" } as never)).toBe(reviewFirstBlockedText());
  });
});
