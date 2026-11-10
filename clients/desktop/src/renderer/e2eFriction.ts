/**
 * `--e2e` steps for docs/M16-FRICTION.md (called from src/renderer/e2e.ts between the chat steps and
 * the editing turn): read-only Bash never asks; a writing Bash command asks and "Allow for session"
 * (`permission_response{remember:true}`) lands in `session.rememberedAllows`; the file that command
 * created is the 1-file review that `send(text, {acceptPending:true})` accepts before the turn proceeds.
 */
import { canAcceptAndSend, rememberedAllowsOf } from "./friction";
import { useStore } from "./store";

export type E2EContext = {
  waitFor(label: string, pred: () => boolean, timeoutMs?: number, autoAllow?: boolean): Promise<void>;
  assert(cond: unknown, msg: string): void;
  /** `turn_end` events seen so far. */
  turns(): number;
  /** `permission_request` events seen so far. */
  permissionRequests(): number;
};

export async function frictionScenario(ctx: E2EContext): Promise<void> {
  const store = useStore.getState;
  const state = () => store().state;
  const file = (path: string) => state().changedFiles.find((f) => f.path === path);
  const settled = () => state().gate.phase === "idle" || state().gate.phase === "reviewing";

  // a. read-only Bash (engine `autoAllowReadOnlyBash`, default on): no permission card at all.
  await ctx.waitFor("canSend before git status", () => state().gate.canSend);
  let before = ctx.turns();
  const permsBefore = ctx.permissionRequests();
  store().send("Run exactly this shell command with the Bash tool: git status\nThen reply with the word done only.");
  await ctx.waitFor("turn_end (or a permission) after git status", () => ctx.turns() > before || state().session.pendingPermission !== null, undefined, false);
  ctx.assert(state().session.pendingPermission === null && ctx.permissionRequests() === permsBefore, "git status ran without a permission request");
  await ctx.waitFor("gate settled after git status", settled);

  // b. a writing command asks; Allow for session → rememberedAllows.
  await ctx.waitFor("canSend before echo", () => state().gate.canSend);
  before = ctx.turns();
  store().send("Run exactly this shell command with the Bash tool: echo hi > a.txt\nThen reply with the word done only. Do not read or edit any file.");
  await ctx.waitFor("Bash permission pending for echo", () => state().session.pendingPermission?.toolName === "Bash", undefined, false);
  const command = String(state().session.pendingPermission!.input["command"] ?? "");
  ctx.assert(command.includes("a.txt"), `permission card shows the echo command (${command})`);
  store().respondPermission(state().session.pendingPermission!.requestId, true, undefined, undefined, true);
  await ctx.waitFor("rememberedAllows has one entry", () => rememberedAllowsOf(state()).length === 1, 30_000, false);
  ctx.assert(rememberedAllowsOf(state()).length === 1, `rememberedAllows.length === 1 (${JSON.stringify(rememberedAllowsOf(state()))})`);
  await ctx.waitFor("turn_end after echo", () => ctx.turns() > before);

  // c. a.txt is the 1-file review → Accept 1 & Send accepts it and the turn proceeds.
  await ctx.waitFor("a.txt pending (reviewing)", () => state().gate.phase === "reviewing" && file("a.txt")?.state === "pending");
  ctx.assert(canAcceptAndSend(state()) && state().gate.canSend, "composer offers both Send and Accept 1 & Send while reviewing");
  before = ctx.turns();
  store().send("Reply with the word pong only", { acceptPending: true });
  await ctx.waitFor("a.txt accepted by accept-and-send", () => file("a.txt")?.state === "accepted", 30_000);
  await ctx.waitFor("turn_end after accept-and-send", () => ctx.turns() > before);
  ctx.assert(state().gate.pendingCount === 0 && file("a.txt")?.state !== "pending", `a.txt accepted (${file("a.txt")?.state ?? "gone"}) and the turn proceeded`);
  await ctx.waitFor("gate settled after accept-and-send", settled);
}
