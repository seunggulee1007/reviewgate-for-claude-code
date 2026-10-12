import { describe, expect, it } from "vitest";
import type { SideThread } from "@reviewgate/engine";
import { forkIsBehind, forkPointLabel, QUOTE_MAX, quoteAnchor, quoteLabel, quoteTitle, reforkQuestion, sideModelChoices, sideSwitchWarning, sideWebHelp, sideWebModeOf } from "./sideTrust";
import { anchorLabel, anchorTitle, lastPromotion, sameAnchor, EMPTY_SIDE } from "./sideThreads";

/** docs/PROTOCOL.md §40.3 (wave4b w4b-side) — the client rules, same as the Mac's Core `SideTrust`. */

const thread = (over: Partial<SideThread> = {}): SideThread => ({
  id: "th1", mainSessionId: "s1", anchor: null, createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z", title: "왜?",
  messages: [{ role: "user", text: "이 매퍼 왜 바꿨어?", at: "" }, { role: "assistant", text: "N+1 때문이에요.", at: "" }],
  status: "idle", error: null, sessionId: "side-1", fork: { mode: "fork_full", fromSessionId: "s1", at: null, atTurn: 3, runningTurn: null }, costUSD: 0, ...over,
});

describe("web setting (SME-08)", () => {
  it("absent, unknown or an old sideAllowWeb default reads off; the help warns that code can leave", () => {
    expect(sideWebModeOf(undefined)).toBe("off");
    expect(sideWebModeOf(true)).toBe("off");
    expect(sideWebModeOf("rules")).toBe("rules");
    expect(sideWebModeOf("on")).toBe("on");
    expect(sideWebHelp("on")).toMatch(/leave/);
    expect(sideWebHelp("rules")).toMatch(/WebFetch\(domain:…\)/);
  });
});

describe("fork point (SME-07)", () => {
  it("'As of turn N' while the fork knows a finished turn; behind once the main conversation went on", () => {
    expect(forkPointLabel(thread())).toContain("3");
    expect(forkPointLabel(thread({ fork: { mode: "fresh", fromSessionId: null, at: null, atTurn: null, runningTurn: 1 } }))).toBeNull();
    expect(forkPointLabel(thread({ fork: null }))).toBeNull();
    expect(forkIsBehind(thread(), 5)).toBe(true);
    expect(forkIsBehind(thread(), 3)).toBe(false);
    expect(forkIsBehind(thread({ fork: null }), 5)).toBe(false);
  });

  it("[최신 대화로 다시 묻기] asks what is typed, else the last question", () => {
    expect(reforkQuestion(thread(), "  지금은?  ")).toBe("지금은?");
    expect(reforkQuestion(thread(), "")).toBe("이 매퍼 왜 바꿨어?");
    expect(reforkQuestion(thread({ messages: [] }), " ")).toBeNull();
  });

  it("a chat switch warns while an answer is coming, not otherwise", () => {
    expect(sideSwitchWarning(EMPTY_SIDE)).toBeNull();
    expect(sideSwitchWarning({ ...EMPTY_SIDE, threads: { th1: thread() } })).toBeNull();
    expect(sideSwitchWarning({ ...EMPTY_SIDE, threads: { th1: thread({ status: "running" }) } })).toMatch(/1/);
  });
});

describe("quote anchors (SME-12)", () => {
  it("selected text of Claude's answer becomes {quote: {text, turn}}, trimmed and cut", () => {
    expect(quoteAnchor("  N+1 때문이에요.\n", 4)).toEqual({ quote: { text: "N+1 때문이에요.", turn: 4 } });
    expect(quoteAnchor("x", null)).toEqual({ quote: { text: "x", turn: null } });
    expect(quoteAnchor(" \n ", 2)).toBeNull();
    expect((quoteAnchor("y".repeat(QUOTE_MAX + 5), 1)!.quote!.text)).toHaveLength(QUOTE_MAX);
  });

  it("chips, titles and duplicate detection know quotes", () => {
    const a = quoteAnchor("매퍼를 바꿨어요", 4)!;
    expect(quoteLabel(a.quote!)).toContain("4");
    expect(quoteTitle(a.quote!)).toContain("“매퍼를 바꿨어요”");
    expect(anchorLabel(a)).toBe(quoteLabel(a.quote!));
    expect(anchorTitle(a)).toBe(quoteTitle(a.quote!));
    expect(sameAnchor(a, quoteAnchor("매퍼를 바꿨어요", 4))).toBe(true);
    expect(sameAnchor(a, quoteAnchor("다른 문단", 4))).toBe(false);
    expect(sameAnchor(a, null)).toBe(false);
  });
});

describe("input (SME-13)", () => {
  it("a queued conclusion is recorded as queued; the model picker lists the session's models and keeps a stored one", () => {
    expect(lastPromotion(thread({ promotions: [{ as: "message", at: "t", queued: true }] }))).toEqual({ as: "message", at: "t", queued: true });
    const c = sideModelChoices([{ value: "haiku", displayName: "Haiku" }, { value: "sonnet", displayName: "Sonnet" }], "claude-opus-5-5");
    expect(c.map((x) => x.value)).toEqual(["", "haiku", "sonnet", "claude-opus-5-5"]);
    expect(sideModelChoices([], "").map((x) => x.value)).toEqual([""]);
  });
});
