import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PermissionRequest, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import type { ChatItem } from "./store";

// r1-composer M08 (docs/PROTOCOL.md §50 "An open question"), rendered to static HTML as the other card tests do: the card
// the message box answers sits above the composer with its options numbered; its transcript row is one line, and so is an
// answered one; a question open behind another card stays a card in the transcript.

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  const { useStore } = await import("./store");
  const { QuestionCard, QuestionSlot } = await import("./components/chat/QuestionCard");
  return { useStore, QuestionCard, QuestionSlot };
}
type Loaded = Awaited<ReturnType<typeof load>>;
type PermissionItem = Extract<ChatItem, { kind: "permission" }>;

const ask: PermissionRequest = {
  requestId: "Q1",
  toolName: "AskUserQuestion",
  input: { questions: [{ question: "Where should the discount codes live?", header: "Codes", multiSelect: false, options: [{ label: "src/pricing.ts", description: "Next to the rules" }, { label: "A JSON file", description: "Edited without a release" }] }] },
};
const bash: PermissionRequest = { requestId: "R1", toolName: "Bash", input: { command: "make" } };

function scene(m: Loaded, pending: PermissionRequest[]) {
  const init = m.useStore.getInitialState();
  Object.assign(init, {
    state: {
      ...init.state,
      project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: null },
      session: { ...init.state.session, open: true, pendingPermission: pending[0] ?? null, pendingPermissions: pending },
    } as ReviewState,
  });
}

const row = (request: PermissionRequest, allowed: boolean | null, answers?: Record<string, string>): PermissionItem => ({ kind: "permission", id: 1, request, allowed, ...(answers ? { answers } : {}) });

describe("Claude's question above the composer (M08)", () => {
  let m: Loaded;
  const html = (el: ReactElement) => renderToStaticMarkup(el);
  beforeAll(async () => {
    initI18n("ko", "darwin");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));

  it("the slot shows the card with the options of the question the box answers numbered", () => {
    scene(m, [ask]);
    const out = html(createElement(m.QuestionSlot));
    expect(out).toContain('data-testid="Question slot"');
    expect(out).toContain('data-testid="Question card"');
    expect(out).toContain('<kbd class="q-key">1</kbd>');
    expect(out).toContain('<kbd class="q-key">2</kbd>');
    expect(out).toContain('data-testid="Question card hint"');
    expect(out).toContain("1–2로 고르거나 아래에 쓰기 · ⌘↩ 답하기 · ⌥↩ 따로 보내기");
    // Its transcript row is one line pointing at it.
    const line = html(createElement(m.QuestionCard, { item: row(ask, null) }));
    expect(line).toContain('data-testid="Question line waiting"');
    expect(line).toContain("Claude의 질문: Where should the discount codes live? — 아래에서 답해 주세요");
    expect(line).not.toContain('data-testid="Question card"');
  });

  it("an answered question is one line with its answer", () => {
    scene(m, []);
    const out = html(createElement(m.QuestionCard, { item: row(ask, true, { "Where should the discount codes live?": "A JSON file" }) }));
    expect(out).toContain("답함: Where should the discount codes live? → A JSON file");
    expect(html(createElement(m.QuestionSlot))).toBe("");
  });

  it("a question open behind another card stays a card in the transcript, and the slot is empty", () => {
    scene(m, [bash, ask]);
    expect(html(createElement(m.QuestionSlot))).toBe("");
    const out = html(createElement(m.QuestionCard, { item: row(ask, null) }));
    expect(out).toContain('data-testid="Question card"');
    expect(out).not.toContain("q-key"); // the box answers the command's card first, so no numbers
  });
});
