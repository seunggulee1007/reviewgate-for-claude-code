// docs/PROTOCOL.md §70.4 on Windows: Alt+T and the composer bar's thinking chip — the key, the command sent, a model that
// always thinks, the blockers and the chip as markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand } from "@reviewgate/engine";
import { initI18n } from "./i18n";

const sent: EngineCommand[] = [];
let answer: (c: EngineCommand) => { ok: true; reply: unknown } | { ok: false; error: string; code?: string } = () => ({ ok: true, reply: { type: "result", ok: true } });

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return answer(c);
      },
      onEvent: () => () => undefined,
      platform: "win32",
      sep: "\\",
    },
  };
  return { mod: await import("./thinking"), chip: await import("./components/chat/ThinkingChip") };
}

const k = (over: object) => ({ key: "t", code: "KeyT", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...over });

describe("§70.4 Alt+T on Windows", () => {
  beforeAll(() => initI18n("en", "win32"));
  afterAll(() => initI18n("en", "darwin"));
  let m: Awaited<ReturnType<typeof load>>;

  beforeEach(async () => {
    sent.length = 0;
    answer = () => ({ ok: true, reply: { type: "result", ok: true } });
    m = await load();
  });

  it("is the physical T with Alt alone", () => {
    expect(m.mod.isThinkingKey(k({}))).toBe(true);
    expect(m.mod.isThinkingKey(k({ key: "†" }))).toBe(true); // macOS types † with ⌥
    expect(m.mod.isThinkingKey(k({ key: "ㅅ" }))).toBe(true);
    expect(m.mod.isThinkingKey(k({ ctrlKey: true }))).toBe(false); // Ctrl+Alt+T is New Terminal Chat
    expect(m.mod.isThinkingKey(k({ shiftKey: true }))).toBe(false);
    expect(m.mod.isThinkingKey(k({ altKey: false }))).toBe(false);
    expect(m.mod.isThinkingKey(k({ isComposing: true }))).toBe(false);
  });

  it("toggles the chat's choice; a model that always thinks keeps it", async () => {
    const off = await m.mod.toggleThinking({ enabled: true, alwaysOn: false }, null);
    expect(sent).toEqual([{ type: "set_thinking", enabled: false }]);
    expect(off).toEqual({ notice: "Thinking off — from Claude's next request", warning: false });
    const always = await m.mod.toggleThinking({ enabled: true, alwaysOn: true }, null);
    expect(sent).toHaveLength(1);
    expect(always.notice).toContain("Alt+T has no effect");
    answer = () => ({ ok: false, error: "set_thinking_failed:boom", code: "set_thinking_failed" });
    expect(await m.mod.toggleThinking({ enabled: false, alwaysOn: false }, null)).toEqual({ notice: "Claude Code could not change thinking: boom", warning: true });
    expect(await m.mod.toggleThinking({ enabled: true, alwaysOn: false }, "why")).toEqual({ notice: "why", warning: true });
  });

  it("says why it is off", () => {
    const base = { projectOpen: true, thinking: { enabled: true, alwaysOn: false }, terminalChat: false, viewing: false };
    expect(m.mod.thinkingBlocker(base)).toBeNull();
    expect(m.mod.thinkingBlocker({ ...base, thinking: null })).toContain("update ReviewGate");
    expect(m.mod.thinkingBlocker({ ...base, viewing: true })).toContain("running chat");
    expect(m.mod.thinkingBlocker({ ...base, projectOpen: false })).not.toBeNull();
  });

  it("the chip: the mark, struck through when off, the tooltip, disabled with the reason", () => {
    const on = renderToStaticMarkup(createElement(m.chip.ThinkingChip, { thinking: { enabled: true, alwaysOn: false }, blocker: null, onToggle: () => undefined }));
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("click or press Alt+T to turn it off");
    expect(on).toContain("✻");
    const off = renderToStaticMarkup(createElement(m.chip.ThinkingChip, { thinking: { enabled: false, alwaysOn: false }, blocker: null, onToggle: () => undefined }));
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('aria-label="Thinking off — ');
    const blocked = renderToStaticMarkup(createElement(m.chip.ThinkingChip, { thinking: { enabled: true, alwaysOn: false }, blocker: "Go back", onToggle: () => undefined }));
    expect(blocked).toContain("disabled");
    expect(blocked).toContain('title="Go back"');
  });
});
