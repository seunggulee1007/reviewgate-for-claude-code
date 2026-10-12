import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineEvent, PeerMessage, ReviewState } from "@reviewgate/engine";
import { notificationFor } from "./attention";
import { initI18n } from "./i18n";
import { droppedText, peerCardModel, peerModeLabel, peerRefusalNotice, peerRowOf, peerSenderName, unpromptedSendText, visiblePeerInbox } from "./peer";

const msg = (id: string, extra: Partial<PeerMessage> = {}): PeerMessage => ({ id, from: "uds:/tmp/cc-socks/4242.sock", fromName: "acme-b4", verifiedPeerPid: null, cause: "explicit-setting", receivedAt: "2026-10-22T08:00:00Z", state: "held", ...extra });
const gate = (patch: Partial<ReviewState["gate"]> = {}) => ({ canSend: true, phase: "idle" as const, blockedReason: null, ...patch });

describe("§29 peer messages (pure)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("names the sender as it claims, else by its socket's pid", () => {
    expect(peerSenderName(msg("a"))).toBe("acme-b4");
    expect(peerSenderName(msg("a", { fromName: null }))).toBe("pid 4242");
    expect(peerSenderName(msg("a", { fromName: "  ", from: "uds:/elsewhere/x.sock" }))).toBe("/elsewhere/x.sock");
  });

  it("the card lists held and delivering messages, oldest first, and accepts every held id", () => {
    const session = { peerInbox: [msg("a"), msg("b", { fromName: "term-2", cause: "mode-mismatch" }), msg("c", { state: "delivered" })], externalTurn: null };
    const card = peerCardModel(session, gate())!;
    expect(card.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(card.heldIds).toEqual(["a", "b"]);
    expect(card.senders).toEqual(["acme-b4", "term-2"]);
    expect(card.modeMismatch).toBe(true);
    expect(card.acceptBlocked).toBeNull();
    expect(card.joinsReview).toBe(false);
    expect(peerCardModel({ peerInbox: [], externalTurn: null }, gate())).toBeNull();
    expect(visiblePeerInbox(session, ["a"]).map((m) => m.id)).toEqual(["b"]);
  });

  it("explains a disabled “Claude가 처리”; a review in progress only gets a hint", () => {
    const one = { peerInbox: [msg("a")], externalTurn: null };
    expect(peerCardModel(one, gate({ canSend: false, phase: "running", blockedReason: "running" }))!.acceptBlocked).toBe("진행 중인 작업이 끝나면 처리할 수 있어요");
    expect(peerCardModel(one, gate({ canSend: false, phase: "idle", blockedReason: "awaiting_permission" }))!.acceptBlocked).toBe("진행 중인 작업이 끝나면 처리할 수 있어요");
    const ext = { peerInbox: [msg("a")], externalTurn: { commandUuid: null, since: "x", peer: null } };
    expect(peerCardModel(ext, gate({ canSend: false, blockedReason: "running" }))!.acceptBlocked).toBe("다른 작업이 끝나면 처리할 수 있어요");
    expect(peerCardModel(one, gate({ canSend: false, blockedReason: "no_session" }), [], "세션이 종료되었습니다")!.acceptBlocked).toBe("세션이 종료되었습니다");
    const reviewing = peerCardModel(one, gate({ phase: "reviewing" }))!;
    expect(reviewing.acceptBlocked).toBeNull();
    expect(reviewing.joinsReview).toBe(true);
    expect(peerCardModel({ peerInbox: [msg("a", { state: "delivering" })], externalTurn: null }, gate())!.delivering).toBe(true);
  });

  it("rows: delivered and dropped only; dropped in words by outcome", () => {
    expect(peerRowOf(msg("a"), 1)).toBeNull();
    const row = peerRowOf({ ...msg("a", { state: "delivered", body: "hi", verifiedPeerPid: 7, turn: 3 }) }, 1)!;
    expect(row).toMatchObject({ kind: "peer", messageId: "a", state: "delivered", body: "hi", verifiedPeerPid: 7, turn: 3 });
    expect(droppedText({ from: "x", fromName: "b4", outcome: "refused" })).toBe("b4 세션의 메시지를 거절했어요");
    expect(droppedText({ from: "x", fromName: "b4", outcome: "expired" })).toBe("b4 세션의 메시지가 만료됐어요 — 보낸 세션에 다시 보내 달라고 하세요");
    expect(droppedText({ from: "x", fromName: "b4", outcome: "discarded" })).toBe("세션이 끝나 b4 세션의 메시지가 전달되지 않았어요");
    expect(droppedText({ from: "x", fromName: "b4", outcome: "buffer_full" })).toBe("b4 세션의 메시지가 전달되지 않았어요 (buffer_full)");
  });

  it("the fallback's send text, the refusal notices and the mode labels", () => {
    expect(unpromptedSendText({ from: "x", fromName: "b4", body: "do it" })).toBe("다른 세션(b4)이 보낸 메시지:\ndo it");
    expect(peerRefusalNotice({ code: "peer_none", error: "peer_none", detail: "" })).toEqual({ notice: null, hide: true });
    expect(peerRefusalNotice({ code: "gate_closed", error: "gate_closed:external_turn", detail: "external_turn" }).notice).toBe("다른 작업이 끝나면 보낼게요");
    expect(peerModeLabel("ask")).toBe("물어보기(기본)");
    expect(peerModeLabel("auto")).toBe("쉴 때 자동 처리");
    expect(peerModeLabel("off")).toBe("받지 않기");
  });

  it("a held message notifies a background window (not in auto mode, not for later states)", () => {
    const ev = (m: PeerMessage) => ({ type: "peer_message", message: m }) as EngineEvent;
    const n = notificationFor(ev(msg("a")), { project: "proj", peerInbound: "ask" })!;
    expect(n).toEqual({ kind: "peer_message", title: "ReviewGate — proj", body: "acme-b4 세션이 메시지를 보냈어요", key: "peer:a" });
    expect(notificationFor(ev(msg("a")), { project: null, peerInbound: "auto" })).toBeNull();
    expect(notificationFor(ev(msg("a", { state: "delivered" })), { project: null })).toBeNull();
    // §29 fallback: no unprompted_blocked "needs you" notification any more.
    expect(notificationFor({ type: "error", message: "x", fatal: false, scope: "session", code: "unprompted_blocked" } as EngineEvent, { project: null })).toBeNull();
    expect(notificationFor({ type: "error", message: "x", fatal: false, scope: "session", code: "resume_not_found" } as EngineEvent, { project: null })).toBeNull();
  });
});
