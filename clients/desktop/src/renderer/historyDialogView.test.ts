import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewState, SessionMeta } from "@reviewgate/engine";
import { initI18n } from "./i18n";

/**
 * r2-chats-cards — polish P4-composer-35, PX-21 / 08 (docs/PROTOCOL.md §55.6), in English so the words do not wait for
 * ko.json: a chat's time keeps up and reads exactly on hover, its cost reads as on the Mac (two decimals, "<$0.01"), the
 * list takes the keyboard (↑ / ↓ move, Enter opens, Ctrl/⌘+C copies the title) with the row it is on marked.
 */
async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true, addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  const { useStore } = await import("./store");
  const m = await import("./components/dialogs/HistoryDialog");
  return { useStore, ...m };
}

const meta = (id: string, title: string, costUSD: number): SessionMeta => ({ id, title, createdAt: "2026-11-02T01:00:00.000Z", updatedAt: "2026-11-02T03:42:00.000Z", turns: 3, costUSD, lastUserText: null });

describe("chat history (§55.6)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("en", "darwin");
    m = await load();
    const init = m.useStore.getInitialState();
    Object.assign(init, {
      state: {
        ...init.state,
        project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: null },
        sessions: { list: [meta("s1", "Mapper fix", 1.2345), meta("s2", "Pricing rules", 0.004)], currentId: "s1", openTabIds: ["s1"] },
      } as unknown as ReviewState,
    });
  });

  it("costs read as on the Mac", () => {
    expect(m.costText(1.2345)).toBe("$1.23");
    expect(m.costText(0.004)).toBe("<$0.01");
    expect(m.costText(0)).toBe("$0.00");
  });

  it("each row's time reads exactly on hover, and the list takes the keyboard with the row it is on marked", () => {
    const out = renderToStaticMarkup(createElement(m.HistoryDialog, { onClose: () => undefined, highlight: "s2" }));
    expect(out).toMatch(/<time dateTime="2026-11-02T03:42:00.000Z" title="[^"]+">/);
    expect(out).toContain("$1.23");
    expect(out).toContain("&lt;$0.01");
    expect(out).toContain('tabindex="0" aria-activedescendant="history-row-s2"');
    expect(out).toMatch(/id="history-row-s2" class="history-row\s+highlight"/);
  });
});
