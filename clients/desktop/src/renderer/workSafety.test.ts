import { describe, expect, it } from "vitest";
import { chatDraftKey, defersNotification, draftAfterKeyChange, mergeStop, rejectConfirmMessage, stopFromError, TurnStopTracker } from "./workSafety";
import { notificationFor } from "./attention";
import type { EngineEvent } from "@reviewgate/engine";

// MARK: wave4 w4-safety

describe("reject shortcut confirm (daily-11)", () => {
  it("says what happens to the file in one line", () => {
    expect(rejectConfirmMessage({ path: "src/New.java", status: "A" })).toBe("New.java was created in this turn — it will be deleted.");
    expect(rejectConfirmMessage({ path: "src/Old.java", status: "M" })).toBe("Old.java goes back to how it was before this turn.");
    expect(rejectConfirmMessage({ path: "src/Gone.java", status: "D" })).toBe("Gone.java will be restored as it was before this turn.");
    expect(rejectConfirmMessage({ path: "src/B.java", oldPath: "src/A.java", status: "R" })).toBe("B.java goes back to A.java as it was before this turn.");
    expect(rejectConfirmMessage({ path: "a\\b\\Win.java", status: "M" })).toContain("Win.java");
  });
});

describe("stop reason of a turn (daily-14)", () => {
  const now = new Date("2023-11-14T22:13:00Z");
  it("comes from the error codes that stop a turn", () => {
    const limit = stopFromError({ code: "usage_limit", message: "", fatal: false, resetAt: "2023-11-14T23:00:00Z" }, { now, timeZone: "UTC" });
    expect(limit?.kind).toBe("usageLimit");
    expect(limit?.text).toMatch(/^Stopped at the usage limit — it resets at 11:00/);
    expect(stopFromError({ code: "usage_limit", message: "", fatal: false })?.text).toBe("Stopped at the usage limit");
    expect(stopFromError({ code: "auth_required", message: "", fatal: false })?.text).toBe("Login required");
    expect(stopFromError({ code: "rate_limited", message: "", fatal: false })?.kind).toBe("rateLimited");
    expect(stopFromError({ code: "api_error", message: "x", fatal: false, status: 529 })?.text).toContain("529");
    expect(stopFromError({ code: "session_crashed", message: "", fatal: true })?.alreadyNotified).toBe(true);
    for (const code of ["collect_failed", "side_failed", "api_retrying", undefined]) expect(stopFromError({ code, message: "x", fatal: false })).toBeNull();
    const login = stopFromError({ code: "auth_required", message: "", fatal: false });
    const api = stopFromError({ code: "api_error", message: "", fatal: false });
    expect(mergeStop(api, login)).toBe(login);
    expect(mergeStop(login, api)).toBe(login);
    expect(defersNotification({ code: "usage_limit", fatal: false })).toBe(true);
    expect(defersNotification({ code: "session_crashed", fatal: true })).toBe(false);
  });

  const turnEnd = { type: "turn_end", stopReason: "error", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1 }, files: 0, added: 0, deleted: 0, changedOutside: [] } as unknown as EngineEvent;
  const usage = { type: "error", message: "Your Claude usage limit is reached.", fatal: false, scope: "session", code: "usage_limit" } as unknown as EngineEvent;

  it("the turn's notification says why it stopped, and the error waits for it", () => {
    const tracker = new TurnStopTracker();
    const onError = tracker.observe(usage, true);
    expect(onError.suppress).toBe(true);
    expect(notificationFor(usage, { project: "repo", ...onError })).toBeNull();
    const onEnd = tracker.observe(turnEnd, false);
    const n = notificationFor(turnEnd, { project: "repo", ...onEnd });
    expect(n?.kind).toBe("turn_done");
    expect(n?.body).toMatch(/^Stopped at the usage limit/);
    // The next turn ends plainly.
    const plain = notificationFor(turnEnd, { project: "repo", ...tracker.observe(turnEnd, false) });
    expect(plain?.body).not.toMatch(/^Stopped/);
  });

  it("outside a turn an error notifies as before; a crash is posted once", () => {
    const tracker = new TurnStopTracker();
    const idle = tracker.observe(usage, false);
    expect(idle.suppress).toBe(false);
    expect(notificationFor(usage, { project: "repo", ...idle })?.kind).toBe("error");
    const crash = { type: "error", message: "ended", fatal: true, scope: "session", code: "session_crashed" } as unknown as EngineEvent;
    const onCrash = tracker.observe(crash, true);
    expect(onCrash.suppress).toBe(false);
    expect(notificationFor(crash, { project: "repo", ...onCrash })?.kind).toBe("error");
    const end = tracker.observe(turnEnd, false);
    expect(end.suppress).toBe(true);
    expect(notificationFor(turnEnd, { project: "repo", ...end })).toBeNull();
  });
});

describe("draft per chat (polish-12)", () => {
  it("keys drafts by project and chat", () => {
    expect(chatDraftKey(null, "c1")).toBeNull();
    expect(chatDraftKey("p", null)).toBe("p");
    expect(chatDraftKey("p", "c1")).toBe("p:c1");
  });
  it("another chat shows its own draft; the chat becoming known keeps what is typed", () => {
    expect(draftAfterKeyChange("p:c1", "p:c2", "typed in one", "kept for two")).toBe("kept for two");
    expect(draftAfterKeyChange("p:c1", "p:c2", "typed in one", "")).toBe("");
    expect(draftAfterKeyChange("p", "p:c1", "typed early", "kept")).toBe("typed early");
    expect(draftAfterKeyChange("p", "p:c1", "", "kept")).toBe("kept");
    expect(draftAfterKeyChange(null, "p:c1", "", "kept")).toBe("kept");
    expect(draftAfterKeyChange("p:c1", "q:c9", "typed", "other project")).toBe("other project");
  });
});
