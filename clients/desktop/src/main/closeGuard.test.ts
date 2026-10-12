import { describe, expect, it } from "vitest";
import type { ReviewState } from "@reviewgate/engine";
import { closeConfirmationReason, closeDialogText, closeGuardReason } from "./closeGuard";

type Slice = Pick<ReviewState, "gate" | "session">;

const slice = (phase: string, extra: Partial<ReviewState["session"]> = {}): Slice =>
  ({
    gate: { phase } as ReviewState["gate"],
    session: { pendingPermission: null, pendingPermissions: [], pendingPlan: null, ...extra } as unknown as ReviewState["session"],
  }) as Slice;

const request = { requestId: "r1", toolName: "AskUserQuestion", input: {} } as unknown as NonNullable<ReviewState["session"]["pendingPermission"]>;

describe("close guard (wave4 w4-safety, daily-12)", () => {
  it("asks only while a turn runs or Claude waits for the user", () => {
    expect(closeGuardReason(slice("idle"))).toBeNull();
    expect(closeGuardReason(slice("reviewing"))).toBeNull();
    expect(closeGuardReason(slice("running"))).toBe("working");
    expect(closeGuardReason(slice("running", { pendingPermission: request, pendingPermissions: [request] }))).toBe("waiting");
    // A plan proposed at the turn's end still waits; an older engine without the queue field too.
    expect(closeGuardReason(slice("reviewing", { pendingPlan: { path: null, plan: "# Plan" } as ReviewState["session"]["pendingPlan"] }))).toBe("waiting");
    expect(closeGuardReason(slice("running", { pendingPermissions: undefined }))).toBe("working");
  });

  it("'Don't ask again' turns it off; unset is on", () => {
    expect(closeConfirmationReason(slice("running"), {})).toBe("working");
    expect(closeConfirmationReason(slice("running"), { confirmCloseWhileWorking: true })).toBe("working");
    expect(closeConfirmationReason(slice("running"), { confirmCloseWhileWorking: false })).toBeNull();
  });

  it("quit says how many windows would stop", () => {
    const one = closeDialogText(["working"], "close");
    expect(one.title).toBe("Claude is working right now");
    expect(one.message).toBe("Closing stops this turn.");
    expect(one.confirm).toBe("Close");
    expect(closeDialogText(["waiting"], "close").message).toBe("Claude is waiting for your answer. Closing stops this turn.");
    const quit = closeDialogText(["working", "waiting", "working"], "quit");
    expect(quit.message).toContain("3");
    expect(quit.confirm).toBe("Quit");
    expect(closeDialogText(["waiting"], "quit").message).toBe("Claude is waiting for your answer. Closing stops this turn.");
  });
});
