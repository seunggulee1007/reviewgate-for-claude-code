// MARK: wave4b w4-notify — where a clicked notification lands (§39.6), and what it says (Mac keys, one line).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineEvent } from "@reviewgate/engine";
import { notificationFor } from "./attention";
import { initI18n } from "./i18n";
import { notificationClickPlan } from "./notifyClick";

describe("a clicked notification", () => {
  const here = { tab: "changes" as const, currentChatId: "c1", openTabIds: ["c1", "c2"] };

  it("scrolls to the card it was about, back on the review tab", () => {
    expect(notificationClickPlan({ kind: "permission", target: { chatId: "c1", requestId: "r1" } }, { ...here, tab: "prs" })).toEqual({
      tab: "changes",
      showChat: "c1",
      reveal: { kind: "card", requestId: "r1" },
    });
    expect(notificationClickPlan({ kind: "question", target: { requestId: "q1" } }, here).reveal).toEqual({ kind: "card", requestId: "q1" });
    expect(notificationClickPlan({ kind: "plan" }, here).reveal).toEqual({ kind: "plan" });
    expect(notificationClickPlan({ kind: "turn_done", target: { chatId: "c1" } }, { ...here, tab: "history" })).toEqual({ tab: null, showChat: "c1", reveal: { kind: "turn" } });
    expect(notificationClickPlan({ kind: "error" }, here).reveal).toBeNull();
    // A card without its request id (an older build): the window only comes forward.
    expect(notificationClickPlan({ kind: "permission" }, here).reveal).toBeNull();
  });

  it("shows its chat without switching the session (§39.2)", () => {
    // The running chat's notification shows the running chat (also when another chat is shown read-only): its card is there.
    expect(notificationClickPlan({ kind: "permission", target: { chatId: "c1", requestId: "r1" } }, here).showChat).toBe("c1");
    expect(notificationClickPlan({ kind: "question", target: { requestId: "q1" } }, here).showChat).toBe("c1");
    // A chat the session has left since: that chat read-only (a tab click), whatever the running chat is doing.
    expect(notificationClickPlan({ kind: "turn_done", target: { chatId: "c2" } }, here)).toMatchObject({ showChat: "c2", reveal: { kind: "turn" } });
    // A chat that is not open as a tab any more is not reopened, and nothing else is scrolled to.
    expect(notificationClickPlan({ kind: "turn_done", target: { chatId: "gone" } }, here)).toMatchObject({ showChat: null, reveal: null });
    // No session yet: nothing to show.
    expect(notificationClickPlan({ kind: "error" }, { ...here, currentChatId: null }).showChat).toBeNull();
  });
});

describe("what it says (the Mac's keys, as one line)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  const usage = { costUsd: 0, durationMs: 1, inputTokens: 0, outputTokens: 0 } as never;

  it("permission: 허용이 필요해요 — Bash: <command>, with the agent that asks", () => {
    const perm = notificationFor({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: "git status\nmore" } } as EngineEvent, { project: "repo", chatId: "c1" })!;
    expect(perm.body).toBe("허용이 필요해요 — Bash: git status");
    expect(perm.target).toEqual({ chatId: "c1", requestId: "r1" });
    const agent = notificationFor(
      { type: "permission_request", requestId: "r2", toolName: "Edit", input: {}, file: "src/Svc.java", agent: { agentId: "a", subagentType: "code-reviewer" } } as EngineEvent,
      { project: null },
    )!;
    expect(agent.body).toBe("허용이 필요해요 — code-reviewer 에이전트 · Edit: src/Svc.java");
  });

  it("question and plan say what they wait for", () => {
    const q = notificationFor({ type: "permission_request", requestId: "q1", toolName: "AskUserQuestion", input: { questions: [{ question: "Which DB?" }] } } as EngineEvent, { project: null })!;
    expect(q.body).toBe("Claude가 질문했어요 — Which DB?");
    expect(q.target).toEqual({ requestId: "q1" });
    expect(notificationFor({ type: "plan_proposed", path: null, plan: "# Add a cache\n1. step" } as EngineEvent, { project: null })?.body).toBe("계획을 승인해 주세요 — Add a cache");
  });

  it("turn end: 작업이 끝났어요 — 리뷰할 파일 N개", () => {
    const end = (files: number, external = 0) => ({ type: "turn_end", stopReason: "end_turn", usage, files, added: 1, deleted: 0, changedOutside: [], external }) as EngineEvent;
    expect(notificationFor(end(3), { project: null, chatId: "c1" })).toMatchObject({ body: "작업이 끝났어요 — 리뷰할 파일 3개", target: { chatId: "c1" } });
    expect(notificationFor(end(0), { project: null })?.body).toBe("작업이 끝났어요 — 리뷰할 파일 없음");
  });
});
