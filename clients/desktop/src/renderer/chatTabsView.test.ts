import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

/**
 * r2-chats-cards — polish P4-composer-33 / 34 / 08 (docs/PROTOCOL.md §55.6), rendered to static HTML as the card tests do and
 * in English so the words do not wait for ko.json: the tabs are reachable from the keyboard and named for screen readers,
 * × says its key and which tab it closes, a tab with an unsent draft shows ✎, and the strip's own buttons are named.
 */
async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true, addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  // The draft store (localStorage since p-lifecycle P4-composer-07): chat s2 holds an unsent draft.
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => (k.endsWith(":s2") ? "half a thought" : null), setItem: () => undefined, removeItem: () => undefined };
  const { useStore } = await import("./store");
  const { ChatTabs } = await import("./components/chat/ChatTabs");
  return { useStore, ChatTabs };
}

describe("chat tabs (§55.6)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("en", "darwin");
    m = await load();
    const init = m.useStore.getInitialState();
    Object.assign(init, {
      state: {
        ...init.state,
        project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: null },
        sessions: { list: [{ id: "s1", title: "Mapper fix" }, { id: "s2", title: "Pricing rules" }], currentId: "s1", openTabIds: ["s1", "s2"] },
      } as unknown as ReviewState,
    });
  });

  it("names the tabs and their buttons, says the keys, and marks a tab with an unsent draft", () => {
    const out = renderToStaticMarkup(createElement(m.ChatTabs));
    expect(out).toContain('role="tablist" aria-label="Chat tabs"');
    expect(out).toMatch(/role="tab" tabindex="0" aria-selected="true"[^>]*title="Mapper fix \(⌘1\)"/);
    expect(out).toContain('aria-label="Close the tab ‘Pricing rules’"');
    expect(out).toContain('title="Close tab (⌘⇧W) — the chat stays in History"');
    // The only live chat's tab cannot close while it is the only one … here two are open, so both can.
    expect(out).not.toContain("The only open chat cannot be closed");
    expect(out).toContain('data-testid="Chat tab draft"');
    expect((out.match(/data-testid="Chat tab draft"/g) ?? []).length).toBe(1);
    expect(out).toContain('aria-label="New chat"');
    expect(out).toContain('title="Chat History…');
  });
});
