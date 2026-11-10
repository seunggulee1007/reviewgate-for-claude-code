import { describe, expect, it } from "vitest";
import type { GatePhase, PendingPlan } from "@reviewgate/engine";
import { isPlanLocked, isReviewLocked, planAfterFollowupFailure } from "./planLock";

const gate = (phase: GatePhase) => ({ gate: { phase } }) as never;

describe("plan card lock", () => {
  it.each(["running", "collecting", "reverting"] as GatePhase[])("is locked while %s", (phase) => {
    expect(isReviewLocked(gate(phase))).toBe(true);
    expect(isPlanLocked(gate(phase), false)).toBe(true);
  });

  it("is open when idle, locked while the answer waits for its result", () => {
    expect(isPlanLocked(gate("idle"), false)).toBe(false);
    expect(isPlanLocked(gate("idle"), true)).toBe(true);
  });

  it("brings the plan back after plan_followup_failed", () => {
    const answered: PendingPlan = { path: null, plan: "1. do it", at: "2026-10-20T00:00:00Z" };
    const restored: PendingPlan = { ...answered, at: "2026-10-20T00:00:05Z" };
    expect(planAfterFollowupFailure(null, answered)).toBe(answered);
    expect(planAfterFollowupFailure(restored, answered)).toBe(restored);
    expect(planAfterFollowupFailure(null, null)).toBeNull();
  });
});
