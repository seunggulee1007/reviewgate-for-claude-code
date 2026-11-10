/**
 * MARK: wave2 desktop-diff — the turn summary card's "왜" and test line, and the diff's cause section, as they render
 * (react-dom/server; the store loads with the window mocked as in the other store tests). §34.8 / §34.9, comp-01 / comp-09.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangedFileState, TurnSummaryEvent, TurnSummaryFile } from "@reviewgate/engine";

type Store = typeof import("../../store").useStore;
let useStore: Store;
let TurnSummaryCard: FunctionComponent<{ id: number; summary: TurnSummaryEvent }>;
let ChangeCause: FunctionComponent<{ file: ChangedFileState }>;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }),
      setSettings: async () => ({}),
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  useStore = (await import("../../store")).useStore;
  TurnSummaryCard = (await import("./TurnSummaryCard")).TurnSummaryCard;
  ChangeCause = (await import("../diff/ChangeCause")).ChangeCause;
});

const file = (path: string, more: Partial<TurnSummaryFile> = {}): TurnSummaryFile => ({
  path, status: "M", state: "pending", adds: 2, dels: 1, why: null, whyToolUseId: null, tools: ["Edit"], toolUseIds: ["e1"], ...more,
});
const summary = (files: TurnSummaryFile[], more: Partial<TurnSummaryEvent> = {}): TurnSummaryEvent => ({ type: "turn_summary", turn: 3, files, commands: [], plan: null, ...more });
const render = (id: number, s: TurnSummaryEvent) => renderToStaticMarkup(createElement(TurnSummaryCard, { id, summary: s }));
/** The newest summary row of the transcript starts open (the store's first snapshot is what a server render reads). */
const openCard = (id: number, s: TurnSummaryEvent) => {
  useStore.getInitialState().transcript = [{ kind: "turnSummary", id, summary: s }];
  return render(id, s);
};
const run = { command: "./mvn-ci.sh -q -o test", toolUseId: "b1", at: "2026-10-23T01:00:00.000Z", runs: 1 };

describe("turn summary card — test line (§34.9)", () => {
  it("reads lastTest: passed after the last edit / failed / no test after the last edit", () => {
    expect(render(1, summary([file("a")], { lastTest: { ...run, verdict: "pass", afterLastEdit: true } }))).toContain("· ✓ Tests passed · ran after the last edit");
    expect(render(1, summary([file("a")], { lastTest: { ...run, verdict: "fail", afterLastEdit: true } }))).toContain("· ✕ Tests failed");
    expect(render(1, summary([file("a")], { lastTest: null }))).toContain("· No tests after the last edit");
  });

  it("an engine before §34 (no lastTest) keeps the count-based badge, and nothing when no test ran", () => {
    const legacy = summary([file("a")], { commands: [{ toolUseId: "b1", command: "npm test", isError: false, testOutcome: "pass" }] });
    expect(render(1, legacy)).toContain("· ✓ Tests passed");
    expect(render(1, legacy)).not.toContain("ran after the last edit");
    expect(render(1, summary([file("a")]))).not.toContain("Tests");
  });
});

describe("turn summary card — why (§34.8)", () => {
  const shared = "Redis 컨테이너가 떠 있는 것까지 확인했다";

  it("a sentence two files share is shown once at the top with its files; those rows carry its number", () => {
    const html = openCard(
      2,
      summary([
        file("api/A.java", { whyDetail: { text: shared, source: "earlier", age: 6, toolUseId: "e0" } }),
        file("api/B.java", { whyDetail: { text: shared, source: "earlier", age: 8, toolUseId: "e0" } }),
        file("api/C.java", { whyDetail: { text: "C의 시그니처에 cartId 추가", source: "reported" } }),
        file("api/D.java", { whyDetail: { text: null, source: "none" }, tools: ["Bash"] }),
      ]),
    );
    expect(html).toContain('data-testid="Turn summary shared why"');
    expect((html.match(/data-testid="Why ref 1"/g) ?? []).length).toBe(3); // the list item + A + B
    expect(html).toContain(`Earlier note: ${shared}`);
    expect((html.match(/Earlier note: /g) ?? []).length).toBe(1);
    expect(html).toContain(">A.java</button>");
    expect(html).toContain("Reported by Claude");
    expect(html).toContain("No recorded reason");
    // "Bash로 변경" is how, "원인 기록 없음" is why: the Bash-only file has both, never one instead of the other
    expect(html).toContain("Changed by Bash");
  });

  it("a subagent's own reason comes first with its agent; the delegation sentence is its own line", () => {
    const html = openCard(
      3,
      summary([
        file("x.java", { whyDetail: { text: "DTO 필드를 맞춘다", source: "same_message", toolUseId: "s1", agent: { toolUseId: "a1", subagentType: "oh-my-claudecode:executor" }, delegation: "executor에게 DTO 정리를 맡긴다" } }),
      ]),
    );
    expect(html).toMatch(/◆ executor<\/span>.*“DTO 필드를 맞춘다”/s);
    expect(html).toContain("Delegated: executor에게 DTO 정리를 맡긴다");
    expect(html.indexOf("DTO 필드를 맞춘다")).toBeLessThan(html.indexOf("Delegated: "));
  });

  it("an engine before §34: the plain why as before, and its old words when there is none", () => {
    const html = openCard(4, summary([file("a.ts", { why: "fix the null check", whyToolUseId: "e1" }), file("b.ts")]));
    expect(html).toContain("“fix the null check”");
    expect(html).toContain("No explanation preceded the change");
    expect(html).not.toContain("No recorded reason");
  });
});

describe("diff cause section (§34.8 changedFiles[].why)", () => {
  const changed = (more: Partial<ChangedFileState>): ChangedFileState =>
    ({ path: "api/A.java", oldPath: null, status: "M", state: "pending", added: 1, deleted: 1, isBinary: false, tools: ["Edit"], toolUseIds: ["e1"], noteCount: 0, origin: "tool", ...more }) as ChangedFileState;

  it("shows the file's why above its calls, with the delegation apart", () => {
    const html = renderToStaticMarkup(createElement(ChangeCause, { file: changed({ why: { text: "cartId 필터 추가", source: "reported", agent: { toolUseId: "a1", subagentType: "executor" }, delegation: "필터 작업 위임" } }) }));
    expect(html).toContain('data-testid="Cause why"');
    expect(html).toContain("Reported by Claude");
    expect(html).toContain("Delegated: 필터 작업 위임");
  });

  it("an engine before §34 (no why) renders the section as before", () => {
    const html = renderToStaticMarkup(createElement(ChangeCause, { file: changed({}) }));
    expect(html).not.toContain("Cause why");
    expect(html).toContain("Why it changed");
  });

  it("no recorded call: the 'no recorded cause' row stays; a reported why is shown under it", () => {
    const html = renderToStaticMarkup(createElement(ChangeCause, { file: changed({ tools: [], toolUseIds: [], why: { text: "README 오타 수정", source: "reported" } }) }));
    expect(html).toContain('data-testid="Cause none"');
    expect(html).toContain("README 오타 수정");
  });
});

// MARK: wave4d w4d-agents2
describe("turn summary card — cost by model (§42.4)", () => {
  const m = (model: string, costUsd: number) => ({ model, costUsd, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 });

  it("ends with the turn's split by model, as the Mac; an engine before §42.4 shows none", () => {
    const html = openCard(5, summary([file("a")], { models: [m("claude-opus-4-1", 0.38), m("claude-sonnet-4-5", 0.06), m("claude-haiku-4-5", 0.012)] }));
    expect(html).toContain("Cost this turn (estimate)");
    expect(html).toContain('aria-label="opus $0.38 · sonnet $0.06 · haiku $0.01"');
    expect(html).toContain("mc-seg opus");
    expect(openCard(6, summary([file("a")]))).not.toContain("Cost this turn");
  });
});
