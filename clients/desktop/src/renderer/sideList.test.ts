/**
 * MARK: r2-skills-side — P3-transcript-26: the side panel's list says why a question failed (the row's tooltip and its red
 * dot), as the Mac's "실패" label does; an answered one says nothing more. Rendered to static markup, the bridge mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SideThread } from "@reviewgate/engine";
import { initI18n, t } from "./i18n";

// DOMPurify needs a DOM: markdown is shown as its source text here (the sanitizer has its own tests).
vi.mock("./components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => createElement("div", { className: "markdown" }, text) }));

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), onEvent: () => () => undefined, platform: "darwin", sep: "/" },
  };
  return (await import("./store")).useStore;
}

/** Server rendering reads the store's initial state: it is made the current one first. */
async function render(component: unknown): Promise<string> {
  const useStore = (await import("./store")).useStore;
  Object.assign(useStore.getInitialState(), useStore.getState());
  return renderToStaticMarkup(createElement(component as never));
}

const thread = (id: string, p: Partial<SideThread>): SideThread => ({
  id,
  mainSessionId: "s1",
  anchor: null,
  createdAt: "2026-10-23T03:00:00.000Z",
  updatedAt: "2026-10-23T03:00:00.000Z",
  title: id,
  messages: [],
  status: "idle",
  error: null,
  sessionId: "x",
  fork: null,
  costUSD: 0,
  ...p,
});

describe("the side list", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("a failed thread says why on its row and its dot; an answered one does not", async () => {
    const useStore = await loadStore();
    const failed = thread("왜 gradle?", { status: "error", error: "API 오류 529 — 서버가 붐벼요" });
    const answered = thread("락은 왜?", { anchor: { path: "src/a.ts", line: 12, side: "new" } });
    useStore.setState({ sidePanelOpen: true, sideView: { kind: "list" }, side: { mainSessionId: "s1", threads: { a: failed, b: answered }, live: {} } });
    const { SidePanel } = await import("./components/side/SidePanel");
    const html = await render(SidePanel);
    expect(html).toContain('title="실패: API 오류 529 — 서버가 붐벼요"'); // the dot
    expect(html).toMatch(/title="왜 gradle\?\n[^"]+\n실패: API 오류 529 — 서버가 붐벼요"/); // the row: title, anchor, why
    expect(html).toMatch(/title="락은 왜\?\nsrc\/a\.ts:\+12[^"]*"/);
    expect(html).not.toMatch(/title="락은 왜\?[^"]*실패/);
    // A failure without words still says it failed.
    useStore.setState({ side: { mainSessionId: "s1", threads: { a: thread("왜 gradle?", { status: "error" }) }, live: {} } });
    expect(await render(SidePanel)).toMatch(/title="왜 gradle\?\n[^"]+\n실패"/);
  });

  it("MARK: r2-skills-side (M18): an answer that tried a skill offers the question as typed — a button named apart from the footer's", async () => {
    const useStore = await loadStore();
    const skill = thread("s1", {
      messages: [
        { role: "user", text: "PR 12 리뷰 답변해 줘", at: "2026-10-23T03:00:00.000Z" },
        { role: "assistant", text: "스킬은 메인 대화에서 실행돼요.", at: "2026-10-23T03:00:05.000Z", toolCalls: [{ id: "k1", name: "Skill", input: { skill: "acme-tools:review-reply" }, isError: true, denied: true }] },
      ],
    });
    useStore.setState({ sidePanelOpen: true, sideView: { kind: "thread", threadId: "s1" }, side: { mainSessionId: "s1", threads: { s1: skill }, live: {} } });
    const { SidePanel } = await import("./components/side/SidePanel");
    const html = await render(SidePanel);
    const asTyped = t("Send the question to the main conversation as typed");
    const promote = t("Send to the main conversation");
    expect(asTyped).not.toBe(promote);
    expect(html).toMatch(new RegExp(`data-testid="Side send to main"[^>]*>(?:<!-- -->)?↗ (?:<!-- -->)?${asTyped}<`));
    expect(html).toMatch(new RegExp(`data-testid="Promote message"[^>]*>(?:<!-- -->)?↗ (?:<!-- -->)?${promote}<`));
  });
});
