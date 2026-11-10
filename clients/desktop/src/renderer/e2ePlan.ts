/**
 * `--e2e` steps for docs/M20-MODES.md (called from src/renderer/e2e.ts before the editing turn):
 * plan mode → a real plan proposal (never an `ExitPlanMode` permission card — the engine answers that
 * tool itself) → Approve & run → the follow-up turn writes CONTRIBUTING.md into the review, which the
 * scenario rejects again so the repo stays clean.
 */
import { permissionMode, pendingPlan, useStore } from "./store";
import type { E2EContext } from "./e2eFriction";

export type PlanReport = {
  proposedAt: string;
  path: string | null;
  planBytes: number;
  planHead: string;
  exitPlanModeCards: number;
  modeAfterApprove: string;
  followUpFiles: string[];
};

export async function planScenario(ctx: E2EContext): Promise<PlanReport> {
  const store = useStore.getState;
  const state = () => store().state;
  const settled = () => state().gate.phase === "idle" || state().gate.phase === "reviewing";
  const exitPlanCards = () => store().transcript.filter((i) => i.kind === "permission" && i.request.toolName === "ExitPlanMode").length;

  // a. set_permission_mode → the live session is in plan mode (HUD badge + composer dropdown read this).
  await ctx.waitFor("canSend before plan mode", () => state().gate.canSend);
  ctx.assert((await store().setPermissionMode("plan")) === null, "set_permission_mode(plan) accepted");
  await ctx.waitFor("session in plan mode", () => permissionMode(state()) === "plan");

  // b. a planning turn: read-only work, then the plan proposal (ExitPlanMode or the plan file).
  const before = ctx.turns();
  store().send("Plan how to add a CONTRIBUTING.md to this repo; do not write anything yet");
  // Auto-allow stays on: a plan-mode turn should not ask at all, and `ExitPlanMode` is answered by the
  // engine — the assertion below reads the transcript, which keeps auto-allowed cards too.
  await ctx.waitFor("pendingPlan (plan_proposed)", () => pendingPlan(state()) !== null || ctx.turns() > before + 1);
  const plan = pendingPlan(state());
  ctx.assert(plan !== null, "a plan was proposed");
  ctx.assert(plan!.plan.trim().length > 40, `the proposed plan carries text (${plan!.plan.length} bytes)`);
  ctx.assert(exitPlanCards() === 0, `no ExitPlanMode permission card was shown (${exitPlanCards()})`);
  ctx.assert(
    store().transcript.some((i) => i.kind === "planProposed"),
    "the transcript kept a plan-proposed row",
  );
  await ctx.waitFor("planning turn settled", () => settled() && state().gate.canSend);

  // c. Approve & run → back to default mode and the engine sends the follow-up instruction itself.
  const beforeApprove = ctx.turns();
  ctx.assert((await store().approvePlan("default")) === null, "plan_response(approve, default) accepted");
  await ctx.waitFor("plan card cleared + default mode", () => pendingPlan(state()) === null && permissionMode(state()) === "default");
  ctx.assert(
    store().transcript.some((i) => i.kind === "planApproved"),
    "the transcript kept a plan-approved row",
  );
  await ctx.waitFor("turn_end of the follow-up turn", () => ctx.turns() > beforeApprove);

  // d. the follow-up turn's work lands in the review; reject it so the repo is clean again.
  await ctx.waitFor("CONTRIBUTING.md pending in the review", () => state().changedFiles.some((f) => f.path === "CONTRIBUTING.md" && f.state === "pending"));
  const followUpFiles = state().changedFiles.map((f) => f.path);
  const report: PlanReport = {
    proposedAt: plan!.at,
    path: plan!.path,
    planBytes: plan!.plan.length,
    planHead: plan!.plan.slice(0, 400),
    exitPlanModeCards: exitPlanCards(),
    modeAfterApprove: permissionMode(state()),
    followUpFiles,
  };
  for (const f of followUpFiles) store().reject(f);
  await ctx.waitFor("plan files reverted", () => state().changedFiles.length === 0 && state().gate.phase !== "reverting");
  await ctx.waitFor("gate settled after the plan scenario", () => settled() && state().gate.canSend);
  return report;
}
