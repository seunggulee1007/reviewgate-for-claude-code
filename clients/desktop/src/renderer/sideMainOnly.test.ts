import { describe, expect, it } from "vitest";
import type { SideThread } from "@reviewgate/engine";
import { deniedSkill, loadDrafts, mainOnlyRequest, saveDrafts, shownCommand, sideDraftKey, withDraft } from "./sideMainOnly";

/** MARK: r2-skills-side — §21 (M18) a skill asked in a side question goes to the main chat; P3-transcript-28 drafts per chat. */

const thread = (messages: SideThread["messages"], status: SideThread["status"] = "idle"): SideThread =>
  ({ id: "t1", mainSessionId: "chat-1", anchor: null, createdAt: "", updatedAt: "", title: "q", messages, status, error: null, sessionId: null, fork: null, costUSD: 0 }) as SideThread;

describe("a skill asked in a side question (M18)", () => {
  it("the denied Skill call names the skill; the thread's question is what goes to the main chat", () => {
    const t = thread([
      { role: "user", text: "PR 12 리뷰해 줘", at: "" },
      { role: "assistant", text: "메인 대화에서 실행돼요.", at: "", toolCalls: [{ id: "k1", name: "Skill", input: { skill: "acme-plugin:release-notes" }, isError: true, denied: true }] },
    ]);
    expect(deniedSkill(t.messages[1])).toBe("acme-plugin:release-notes");
    expect(mainOnlyRequest(undefined, t)).toEqual({ text: "PR 12 리뷰해 줘", name: "acme-plugin:release-notes" });
    // A refused question wins; a running thread or an answer without a denied skill offers nothing.
    expect(mainOnlyRequest({ text: "/acme-verify", name: "acme-verify" }, t)).toEqual({ text: "/acme-verify", name: "acme-verify" });
    expect(mainOnlyRequest(undefined, { ...t, status: "running" })).toBeNull();
    expect(mainOnlyRequest(undefined, thread([{ role: "user", text: "q", at: "" }, { role: "assistant", text: "a", at: "", toolCalls: [{ id: "r", name: "Read", input: {}, denied: true }] }]))).toBeNull();
    expect(mainOnlyRequest(undefined, undefined)).toBeNull();
    expect(shownCommand("acme-verify")).toBe("/acme-verify");
    expect(shownCommand("/compact")).toBe("/compact");
  });
});

describe("unsent side questions are kept per chat (P3-transcript-28)", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { m, store: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } };
  };

  it("every anchor has its own key; general is \"\"", () => {
    expect(sideDraftKey(null)).toBe("");
    expect(sideDraftKey({ path: "src/a.ts", line: 12 })).not.toBe(sideDraftKey({ path: "src/b.ts", line: 3 }));
    expect(sideDraftKey({ path: "src/a.ts", line: 12 })).toBe(sideDraftKey({ path: "src/a.ts", line: 12 }));
    expect(sideDraftKey({ pr: { number: 42, path: "a.ts", line: 3, side: "RIGHT", hunk: "" } })).toBe("pr:42:a.ts:3");
  });

  it("saved and loaded by chat; an empty set removes the entry; another chat has its own", () => {
    const { m, store } = memory();
    const d = { chatId: "chat-1", compose: withDraft({}, sideDraftKey({ path: "src/a.ts", line: 12 }), "왜 이 락이?"), followUps: { t1: "그럼 타임아웃은?" } };
    saveDrafts(d, store);
    expect(loadDrafts("chat-1", store)).toEqual(d);
    expect(loadDrafts("chat-2", store)).toEqual({ chatId: "chat-2", compose: {}, followUps: {} });
    saveDrafts({ chatId: "chat-1", compose: {}, followUps: {} }, store);
    expect(m.size).toBe(0);
    expect(withDraft({ a: "x", b: "y" }, "a", "")).toEqual({ b: "y" });
    expect(loadDrafts(null, store)).toEqual({ chatId: null, compose: {}, followUps: {} });
  });
});
