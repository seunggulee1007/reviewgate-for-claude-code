/**
 * MARK: wave4c w4c-trust — docs/PROTOCOL.md §41.2: the trust views as they render (react-dom/server, the window mocked as in
 * TurnSummaryCard.test.ts): the summary's line and its button, the reject banner, the settings switches, the file badge.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AutoAcceptedFile, ChangedFileState, ReviewState } from "@reviewgate/engine";

type Store = typeof import("../../store").useStore;
let useStore: Store;
let views: typeof import("./TrustViews");

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
  views = await import("./TrustViews");
  (await import("../../i18n")).initI18n("ko", "darwin");
});

const file = (path: string, over: Partial<ChangedFileState> = {}) => ({ path, oldPath: null, status: "M", added: 1, deleted: 0, isBinary: false, tools: ["Edit"], toolUseIds: ["e"], state: "pending", noteCount: 0, ...over }) as ChangedFileState;
/** A server render reads the store's initial snapshot: the patched state goes there too (as flowScreens.test.ts). */
const withState = (patch: (s: ReviewState) => ReviewState) => {
  useStore.setState((st) => ({ state: patch(st.state) }));
  Object.assign(useStore.getInitialState(), useStore.getState());
};

describe("trust views (§41.2)", () => {
  it("the summary line counts the rule's files; its button waits with a reason once none is held", () => {
    const files: AutoAcceptedFile[] = [{ path: "a.java", rule: "whitespace" }, { path: "SvcTest.java", rule: "tests" }];
    withState((s) => ({ ...s, gate: { ...s.gate, phase: "idle" }, changedFiles: [file("a.java", { state: "accepted", autoAccepted: "whitespace" }), file("SvcTest.java", { state: "accepted", autoAccepted: "tests" })] }));
    let html = renderToStaticMarkup(createElement(views.AutoAcceptedSummaryLine, { files }));
    expect(html).toContain("규칙으로 수락 2개 (공백만 바뀜 · 편집 뒤 테스트 통과)");
    expect(html).toContain("모두 대기로 되돌리기");
    expect(html).not.toContain("disabled");
    withState((s) => ({ ...s, changedFiles: [file("a.java"), file("SvcTest.java")] }));
    html = renderToStaticMarkup(createElement(views.AutoAcceptedSummaryLine, { files }));
    expect(html).toContain("disabled");
    expect(html).toContain("이미 대기로 돌아갔거나 리뷰에서 빠졌어요");
  });

  it("the reject banner: offered, then disabled with the engine's reason; nothing without an offer", () => {
    withState((s) => ({ ...s, gate: { ...s.gate, phase: "idle", rejectUndo: { path: "src/Svc.java", oldPath: null, status: "M", available: true } } }));
    let html = renderToStaticMarkup(createElement(views.RejectUndoBanner));
    expect(html).toContain("거절했어요 — src/Svc.java");
    expect(html).toContain(">거절 취소<");
    expect(html).not.toContain("disabled");
    withState((s) => ({ ...s, gate: { ...s.gate, rejectUndo: { path: "src/Svc.java", oldPath: null, status: "M", available: false, reason: "changed_on_disk" } } }));
    html = renderToStaticMarkup(createElement(views.RejectUndoBanner));
    expect(html).toContain("거절한 뒤 파일이 바뀌어서 되돌릴 수 없어요");
    expect(html).toContain("disabled");
    withState((s) => {
      const { rejectUndo: _gone, ...gate } = s.gate;
      return { ...s, gate };
    });
    expect(renderToStaticMarkup(createElement(views.RejectUndoBanner))).toBe("");
  });

  it("settings: one switch per rule (on as the engine says), what none accepts; the badge names its rule", () => {
    withState((s) => ({ ...s, project: { path: "/r", root: "/r", name: "r", branch: "main" } as ReviewState["project"], autoAcceptRules: { tests: true } }));
    const html = renderToStaticMarkup(createElement(views.AutoAcceptSettings));
    expect(html).toContain("자동 수락 규칙");
    expect(html.match(/type="checkbox"/g)?.length).toBe(3);
    expect(html).toMatch(/data-testid="Auto accept tests"[^>]*checked|checked=""[^>]*data-testid="Auto accept tests"/);
    expect(html).toContain("규칙으로 수락하지 않는 것");
    const badge = renderToStaticMarkup(createElement(views.AutoAcceptedBadge, { rule: "lockfile", path: "web/package-lock.json" }));
    expect(badge).toContain("규칙으로 수락 · 매니페스트와 함께 lockfile");
    expect(renderToStaticMarkup(createElement(views.AutoAcceptedBadge, { rule: undefined, path: "x" }))).toBe("");
  });
});
