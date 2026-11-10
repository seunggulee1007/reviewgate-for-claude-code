/**
 * wave3 check-clients — the turn summary card says the whole review's totals (turn_summary `review` / `merged`, §34.3)
 * apart from this turn's own numbers, as on the Mac: only for a turn merged into a standing review (a question, a change
 * request's follow-up) — a fresh turn's review is that turn, and an engine before §34 sends neither.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TurnSummaryEvent, TurnSummaryFile } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { summaryReviewTotals } from "./reviewRound";

let TurnSummaryCard: FunctionComponent<{ id: number; summary: TurnSummaryEvent }>;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }), setSettings: async () => ({}), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  TurnSummaryCard = (await import("./components/chat/TurnSummaryCard")).TurnSummaryCard;
});
afterAll(() => initI18n("en", "darwin"));

const file = (path: string): TurnSummaryFile => ({ path, status: "M", state: "pending", adds: 2, dels: 1, why: null, whyToolUseId: null, tools: ["Edit"], toolUseIds: ["e1"] });
const summary = (more: Partial<TurnSummaryEvent> = {}): TurnSummaryEvent => ({ type: "turn_summary", turn: 4, files: [file("a.ts")], commands: [], plan: null, ...more });
const render = (s: TurnSummaryEvent) => renderToStaticMarkup(createElement(TurnSummaryCard, { id: 1, summary: s }));

describe("turn summary — the whole review apart from this turn (§34.3)", () => {
  it("a merged turn carries the review's totals; a fresh turn or an engine before §34 none", () => {
    const review = { files: 5, added: 40, deleted: 7 };
    expect(summaryReviewTotals({ merged: true, review })).toEqual(review);
    expect(summaryReviewTotals({ review })).toBeNull();
    expect(summaryReviewTotals({ merged: true })).toBeNull();
    expect(summaryReviewTotals({})).toBeNull();
  });

  it("the card names this turn's numbers and shows the review's next to them", () => {
    initI18n("ko", "darwin");
    const merged = render(summary({ merged: true, review: { files: 5, added: 40, deleted: 7 } }));
    expect(merged).toContain("이번 턴");
    expect(merged).toMatch(/data-testid="Summary review totals"[^>]*>리뷰 전체: 파일 5개 · \+40 −7</);
    const fresh = render(summary({ review: { files: 1, added: 2, deleted: 1 } }));
    expect(fresh).not.toContain("Summary review totals");
    expect(fresh).not.toContain("이번 턴");
    initI18n("en", "darwin");
  });
});
