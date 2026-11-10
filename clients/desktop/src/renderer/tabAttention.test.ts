import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PeerMessage, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { changesStatus, changesStatusLabel, waitingText } from "./tabAttention";

const msg = (id: string, extra: Partial<PeerMessage> = {}): PeerMessage => ({ id, from: "uds:/tmp/cc-socks/4242.sock", fromName: "acme-b4", verifiedPeerPid: null, cause: "explicit-setting", receivedAt: "2026-10-22T08:00:00Z", state: "held", ...extra });

describe("daily-03: the Changes tab says what Claude is doing", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  const st = (session: Partial<ReviewState["session"]>, g: Partial<ReviewState["gate"]> = {}) =>
    ({ session: { pendingPermission: null, pendingPlan: null, peerInbox: [], externalTurn: null, ...session }, gate: { phase: "idle", pendingCount: 0, ...g } }) as unknown as Pick<ReviewState, "session" | "gate">;
  const perm = (toolName: string) => ({ requestId: "r", toolName, input: {} });

  it("waiting beats running beats files to review", () => {
    expect(changesStatus(st({ pendingPermissions: [perm("Bash")] }, { phase: "running" }))).toEqual({ kind: "waiting", reason: "permission" });
    expect(changesStatus(st({ pendingPermissions: [perm("Bash"), perm("AskUserQuestion")] }))).toEqual({ kind: "waiting", reason: "question" });
    expect(changesStatus(st({ pendingPermission: perm("Edit") }))).toEqual({ kind: "waiting", reason: "permission" });
    expect(changesStatus(st({ pendingPlan: { path: null, plan: "x", at: "t" } }))).toEqual({ kind: "waiting", reason: "plan" });
    expect(changesStatus(st({ peerInbox: [msg("a")] }))).toEqual({ kind: "waiting", reason: "peer" });
    // r2-peers: auto runs a message from a live session of the user's by itself; one the registry does not vouch for waits.
    const sender = { address: "uds:/tmp/cc-socks/4242.sock", pid: 4242, name: "acme-b4", cwd: null, status: "idle" as const, entrypoint: "cli" };
    expect(changesStatus(st({ peerInbox: [msg("a", { sender })], peerInbound: "auto" }))).toBeNull();
    expect(changesStatus(st({ peerInbox: [msg("a")], peerInbound: "auto" }))).toEqual({ kind: "waiting", reason: "peer" });
    expect(changesStatus(st({}, { phase: "running" }))).toEqual({ kind: "running" });
    expect(changesStatus(st({ externalTurn: { commandUuid: null, since: "x", peer: null } }))).toEqual({ kind: "running" });
    expect(changesStatus(st({}, { phase: "reviewing", pendingCount: 3 }))).toEqual({ kind: "review", count: 3 });
    expect(changesStatus(st({}))).toBeNull();
  });

  it("in words", () => {
    expect(waitingText("permission")).toBe("Claude가 권한 확인을 기다려요");
    expect(waitingText("question")).toBe("Claude가 질문의 답을 기다려요");
    expect(waitingText("plan")).toBe("Claude가 계획 승인을 기다려요");
    expect(waitingText("peer")).toBe("다른 세션 메시지가 확인을 기다려요");
    expect(changesStatusLabel({ kind: "review", count: 2 })).toBe("2개 파일 리뷰 대기");
  });
});
