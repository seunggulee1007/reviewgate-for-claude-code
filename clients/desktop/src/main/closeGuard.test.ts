import { describe, expect, it } from "vitest";
import type { ReviewState } from "@reviewgate/engine";
import { closeGuardReason, closePrompt, projectChangePrompt, quitLine, quitPrompt, quitReasons, validExtras, windowQuitState, NO_EXTRAS, type WindowQuitState } from "../shared/closeGuard";

// MARK: wave4 w4-safety / polish p-lifecycle — the Mac's QuitGuardTests, on the Windows client's words (docs/PROTOCOL.md §55.7).

type Slice = Parameters<typeof quitReasons>[0];

const request = { requestId: "r1", toolName: "AskUserQuestion", input: {} } as unknown as NonNullable<ReviewState["session"]["pendingPermission"]>;

function slice(phase: string, o: { session?: Partial<ReviewState["session"]>; pending?: number; notes?: boolean[]; prDrafts?: number; agents?: string[] } = {}): Slice {
  return {
    gate: { phase } as ReviewState["gate"],
    session: { pendingPermission: null, pendingPermissions: [], pendingPlan: null, ...o.session } as unknown as ReviewState["session"],
    changedFiles: Array.from({ length: o.pending ?? 0 }, (_, i) => ({ path: `f${i}.txt`, state: "pending" })) as unknown as ReviewState["changedFiles"],
    reviewNotes: (o.notes ?? []).map((sent, i) => ({ id: `n${i}`, ...(sent ? { sent: { at: "2026-11-01T00:00:00Z", turn: 1 } } : {}) })) as unknown as ReviewState["reviewNotes"],
    hud: { agents: (o.agents ?? []).map((status, i) => ({ id: `a${i}`, status })) } as unknown as ReviewState["hud"],
    pr: { draftComments: Array.from({ length: o.prDrafts ?? 0 }, (_, i) => ({ id: `d${i}` })) } as unknown as ReviewState["pr"],
    project: { path: "/work/acme-api", root: "/work/acme-api", name: "acme-api" } as unknown as ReviewState["project"],
    workbenches: { list: [] } as unknown as ReviewState["workbenches"],
  };
}

const on = { confirmQuit: true, confirmCloseWhileWorking: true };

describe("close guard (wave4 w4-safety, daily-12)", () => {
  it("a turn running or Claude waiting for the user", () => {
    expect(closeGuardReason(slice("idle"))).toBeNull();
    expect(closeGuardReason(slice("reviewing"))).toBeNull();
    expect(closeGuardReason(slice("running"))).toBe("working");
    expect(closeGuardReason(slice("running", { session: { pendingPermission: request, pendingPermissions: [request] } }))).toBe("waiting");
    // A plan proposed at the turn's end still waits; an older engine without the queue field too.
    expect(closeGuardReason(slice("reviewing", { session: { pendingPlan: { path: null, plan: "# Plan" } as ReviewState["session"]["pendingPlan"] } }))).toBe("waiting");
    expect(closeGuardReason(slice("running", { session: { pendingPermissions: undefined } }))).toBe("working");
  });
});

describe("what closing stops, loses and keeps (polish P1-chrome-01, §55.7)", () => {
  it("lists a window's things in the Mac's order", () => {
    expect(quitReasons(slice("idle"))).toEqual([]);
    const s = slice("running", { session: { backgroundTasks: [{ taskId: "b1", description: "npm run dev" }] as ReviewState["session"]["backgroundTasks"] }, pending: 2, notes: [false, true], prDrafts: 1, agents: ["running"] });
    const extras = { ...NO_EXTRAS, draft: true, draftImages: 1, queued: 2, queuedImages: 1, sideAnswering: 1 };
    expect(quitReasons(s, extras).map((r) => r.kind)).toEqual(["working", "backgroundTasks", "sideQuestions", "images", "prDrafts", "queued", "pendingReview", "unsentNotes", "draft"]);
    // After the turn, a live subagent is a background agent.
    expect(quitReasons(slice("reviewing", { agents: ["running", "completed"] }))).toEqual([{ kind: "backgroundAgents", count: 1 }]);
    expect(windowQuitState(slice("idle")).name).toBe("acme-api");
  });

  it("quitting asks while the setting is on; the working switch decides while work would stop", () => {
    const idle: WindowQuitState[] = [{ name: "acme-api", reasons: [], unsavedLines: [] }];
    const asked = quitPrompt(idle, "quit", on, 1)!;
    expect(asked.title).toBe("Quit ReviewGate?");
    expect(asked.message).toBe("The Claude sessions of 1 open projects end.\n1 projects reopen next time");
    expect(asked.offersSuppression).toBe(true);
    expect(asked.cancelIsDefault).toBe(false);
    expect(asked.confirm).toBe("Quit");
    expect(quitPrompt(idle, "quit", { confirmQuit: false }, 1)).toBeNull();
    const busy: WindowQuitState[] = [{ name: "acme-api", reasons: [{ kind: "working" }, { kind: "backgroundTasks", count: 2 }], unsavedLines: [] }, { name: "acme-web", reasons: [], unsavedLines: [] }];
    const stop = quitPrompt(busy, "quit", { confirmQuit: false }, null)!;
    expect(stop.message).toBe("acme-api: Claude is working — quitting stops this turn\nacme-api: 2 background commands stop");
    expect(stop.offersSuppression).toBe(false);
    expect(quitPrompt(busy, "quit", { confirmQuit: true, confirmCloseWhileWorking: false }, null)).toBeNull();
  });

  it("the last window says it quits, what is lost (Cancel the default) and what comes back", () => {
    const w: WindowQuitState = { name: "acme-api", reasons: [{ kind: "images", count: 1 }, { kind: "queued", count: 2 }, { kind: "pendingReview", count: 3 }, { kind: "unsentNotes", count: 1 }], unsavedLines: ["You are writing a review note."] };
    const p = quitPrompt([w], "lastWindow", on, 1)!;
    expect(p.message.split("\n\n")).toEqual([
      "Closing the last window quits ReviewGate.",
      "acme-api: You are writing a review note.\nacme-api: 1 attached images are not kept",
      [
        "The Claude sessions of 1 open projects end.",
        "acme-api: 1 unsent notes and 3 pending files stay — they are here when you reopen",
        "acme-api: 2 queued messages come back paused when you reopen it",
        "Unsent notes and the message you were typing are kept",
        "1 projects reopen next time",
      ].join("\n"),
    ]);
    expect(p.cancelIsDefault).toBe(true);
    expect(p.offersSuppression).toBe(false);
  });

  it("one window that is not the last asks only for work, titled by the reason", () => {
    expect(closePrompt({ name: "a", reasons: [{ kind: "pendingReview", count: 2 }, { kind: "draft" }], unsavedLines: [] }, on)).toBeNull();
    const waiting = closePrompt({ name: "a", reasons: [{ kind: "waiting" }, { kind: "sideQuestions", count: 1 }], unsavedLines: [] }, on)!;
    expect(waiting.title).toBe("Claude is waiting for your answer");
    expect(waiting.message).toBe("Claude is waiting for your answer. Closing stops this turn.\n\n1 side questions stop\n\nPending reviews, notes and drafts come back when you reopen.");
    expect(waiting.confirm).toBe("Close");
    expect(closePrompt({ name: "a", reasons: [{ kind: "working" }], unsavedLines: [] }, on)!.title).toBe("Claude is working right now");
    expect(closePrompt({ name: "a", reasons: [{ kind: "backgroundAgents", count: 2 }], unsavedLines: [] }, on)!.title).toBe("Close this window?");
    expect(closePrompt({ name: "a", reasons: [{ kind: "working" }], unsavedLines: [] }, { confirmCloseWhileWorking: false })).toBeNull();
  });

  it("switching or closing the project stops the turn and says so (P1-chrome-03)", () => {
    const w: WindowQuitState = { name: "acme-api", reasons: [{ kind: "working" }, { kind: "pendingReview", count: 1 }], unsavedLines: [] };
    const sw = projectChangePrompt(w, "switch", on)!;
    expect(sw.message).toBe("Switching projects stops this turn.\n\nPending reviews, notes and drafts come back when you reopen.");
    expect(sw.confirm).toBe("Switch");
    expect(projectChangePrompt({ ...w, reasons: [{ kind: "waiting" }] }, "close", on)!.confirm).toBe("Close Project");
    expect(projectChangePrompt({ ...w, reasons: [{ kind: "pendingReview", count: 1 }] }, "switch", on)).toBeNull();
    expect(projectChangePrompt(w, "switch", { confirmCloseWhileWorking: false })).toBeNull();
  });

  it("a line names its window; a page's report is bounded", () => {
    expect(quitLine({ kind: "backgroundTasks", count: 2 }, "acme-api")).toBe("acme-api: " + quitLine({ kind: "backgroundTasks", count: 2 }, null));
    const v = validExtras({ lines: ["a", 3, "", "x".repeat(400)], draft: "yes", draftImages: -2, queued: 2.6, sideAnswering: Infinity, creatingWorkbench: true });
    expect(v).toEqual({ lines: ["a", "x".repeat(300)], draft: false, draftImages: 0, queued: 3, queuedImages: 0, sideAnswering: 0, creatingWorkbench: true });
    expect(validExtras(null)).toEqual(NO_EXTRAS);
  });
});
