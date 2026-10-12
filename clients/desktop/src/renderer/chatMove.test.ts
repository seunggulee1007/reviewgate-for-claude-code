/** wave4b w4b-follow — docs/PROTOCOL.md §39.4 in Electron (as the Mac's ChatMoveTests): the words, the decisions and the requests. */
import { afterEach, describe, expect, it } from "vitest";
import type { EngineCommand, PermissionRequest, ReviewState } from "@reviewgate/engine";

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });

function stubWindow(): void {
  (globalThis as unknown as { window: unknown }).window = {
    rg: {
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return respond(c);
      },
      platform: "darwin",
      sep: "/",
    },
  };
}

afterEach(() => {
  sent.length = 0;
  respond = () => ({ ok: true, reply: { type: "result", ok: true } });
});

const state = (p: { phase?: string; pending?: number; plan?: boolean; starting?: boolean; movedTo?: { path: string; name: string; at: string } } = {}): ReviewState =>
  ({
    gate: { phase: p.phase ?? "idle" },
    session: {
      starting: p.starting === true,
      pendingPermission: null,
      pendingPermissions: Array.from({ length: p.pending ?? 0 }, (_, i) => ({ requestId: `r${i}` })),
      pendingPlan: p.plan ? { path: null, plan: "x", at: "" } : null,
    },
    sessions: { list: [{ id: "s1", title: "t", createdAt: "", updatedAt: "", turns: 1, costUSD: 0, lastUserText: null, ...(p.movedTo ? { movedTo: p.movedTo } : {}) }], currentId: "s1", openTabIds: ["s1"] },
  }) as unknown as ReviewState;

describe("chat move (§39.4)", () => {
  it("asks before a move while Claude works or waits; reads the moved chat", async () => {
    stubWindow();
    const { chatMoveNeedsStop, movedChat } = await import("./chatMove");
    expect(chatMoveNeedsStop(state())).toBe(false);
    expect(chatMoveNeedsStop(state({ phase: "running" }))).toBe(true);
    expect(chatMoveNeedsStop(state({ pending: 1 }))).toBe(true);
    expect(chatMoveNeedsStop(state({ plan: true }))).toBe(true);
    expect(chatMoveNeedsStop(state({ starting: true }))).toBe(true);
    expect(movedChat(state())).toBeNull();
    expect(movedChat(state({ movedTo: { path: "/w/wt2", name: "wt2", at: "" } }))).toMatchObject({ name: "wt2" });
  });

  it("wave4b integration (§39.4 × §39.2): the moved bar reads the chat on screen, by id", async () => {
    stubWindow();
    const { movedChatOf } = await import("./chatMove");
    const moved = state({ movedTo: { path: "/w/wt2", name: "wt2", at: "" } });
    expect(movedChatOf(moved, "s1")).toMatchObject({ name: "wt2" });
    expect(movedChatOf(moved, "s2")).toBeNull(); // another chat shown read-only over the moved record
    expect(movedChatOf(moved, null)).toBeNull();
    expect(movedChatOf(state(), "s1")).toBeNull();
  });

  it("a worktree-creating card with a target can follow; others cannot", async () => {
    stubWindow();
    const { canFollow } = await import("./chatMove");
    const card = (reason: PermissionRequest["reason"], toolUseId: string | null = "t1") =>
      ({ requestId: "r1", toolName: "Bash", input: {}, ...(toolUseId ? { toolUseId } : {}), ...(reason ? { reason } : {}) }) as PermissionRequest;
    expect(canFollow(card({ code: "worktree_command", message: "m", path: "/w/wt2" }))).toBe(true);
    expect(canFollow(card({ code: "worktree_command", message: "m" }))).toBe(false);
    expect(canFollow(card({ code: "other_worktree", message: "m", path: "/w/wt2" }))).toBe(false);
    expect(canFollow(card({ code: "worktree_command", message: "m", path: "/w/wt2" }, null))).toBe(false);
    expect(canFollow(card(undefined))).toBe(false);
  });

  it("chat_move carries interrupt and the follow-up only when a turn is stopped; a refusal reads in words", async () => {
    stubWindow();
    const { moveChat, followUpText, moveRefusalText, useChatMoveNotice } = await import("./chatMove");
    expect(await moveChat("/w/acme-4176-17", true, true)).toBeNull();
    expect(await moveChat("/w/wt2", false, true)).toBeNull();
    expect(sent).toEqual([
      { type: "chat_move", path: "/w/acme-4176-17", interrupt: true, followUp: followUpText("acme-4176-17") },
      { type: "chat_move", path: "/w/wt2" },
    ]);
    respond = () => ({ ok: false, error: "notes_pending", code: "notes_pending" });
    const why = await moveChat("/w/wt2", false, false);
    expect(why).toBe(moveRefusalText("notes_pending"));
    expect(useChatMoveNotice.getState().text).toBe(why);
    expect(moveRefusalText("session_busy")).not.toBe(moveRefusalText("not_a_worktree"));
  });

  it("chat_receive: a refusal is said here, nothing waiting says nothing", async () => {
    stubWindow();
    const { receiveMovedChat, moveRefusalText, useChatMoveNotice } = await import("./chatMove");
    useChatMoveNotice.getState().set(null);
    await receiveMovedChat();
    expect(sent).toEqual([{ type: "chat_receive" }]);
    expect(useChatMoveNotice.getState().text).toBeNull();
    respond = () => ({ ok: false, error: "nothing_to_receive", code: "nothing_to_receive" });
    await receiveMovedChat();
    expect(useChatMoveNotice.getState().text).toBeNull();
    respond = () => ({ ok: false, error: "notes_pending", code: "notes_pending" });
    await receiveMovedChat();
    expect(useChatMoveNotice.getState().text).toBe(moveRefusalText("notes_pending"));
    useChatMoveNotice.getState().set(null);
  });

  it("the notices are worded and styled, the banner leads with the move", async () => {
    stubWindow();
    const { chatMoveNoticeText } = await import("./chatMove");
    const { presentationOf } = await import("./errorCodes");
    const { sessionActions } = await import("./sessionErrors");
    expect(chatMoveNoticeText("chat_moved_in", "/Users/me/acme")).toContain("/Users/me/acme");
    expect(chatMoveNoticeText("chat_moved_in_disk", "/a")).not.toBe(chatMoveNoticeText("chat_moved_in", "/a"));
    expect(chatMoveNoticeText("chat_move_failed", "/w/acme-4176-17")).toContain("acme-4176-17");
    expect(chatMoveNoticeText("other", "/a")).toBeNull();
    expect(presentationOf("chat_moved_in")).toBe("info");
    expect(presentationOf("chat_moved_in_disk")).toBe("info");
    expect(presentationOf("chat_move_failed")).toBe("warning");
    expect(sessionActions("worktree_outside_review", { count: 1, facts: { path: "/w/wt2" }, isWorkbench: () => true })[0]).toBe("moveChat");
  });
});
