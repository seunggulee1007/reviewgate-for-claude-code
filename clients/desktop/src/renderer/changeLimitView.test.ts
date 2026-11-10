import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppSettings } from "../shared/ipc";
import { initI18n } from "./i18n";

// docs/PROTOCOL.md §54: the change limit is an option, off by default — Settings, the HUD and the empty chat rendered to
// static HTML with the store's initial state as the scene (as in permissionSettings.test.ts).

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin", toolchainInfo: async () => null },
  };
  const { useStore } = await import("./store");
  const { GeneralTab } = await import("./components/settings/GeneralTab");
  const { HUDStrip } = await import("./components/chat/HUDStrip");
  const { EmptyTranscript } = await import("./components/chat/Transcript");
  return { useStore, GeneralTab, HUDStrip, EmptyTranscript };
}

/** The opening tag of the element with `testId` (the attribute order is React's, not ours). */
const tag = (out: string, testId: string): string => {
  const at = out.indexOf(`data-testid="${testId}"`);
  if (at < 0) return "";
  return out.slice(out.lastIndexOf("<", at), out.indexOf(">", at) + 1);
};

const settings = (over: Partial<AppSettings> = {}) =>
  ({ appearance: "system", budgetMaxFiles: 10, budgetMaxLines: 400, systemPromptAppend: "", checkpointIgnorePatterns: "", worktreeRoot: "", ...over }) as AppSettings;

describe("the change limit is an option, off by default (§54)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("en", "darwin");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));

  it("Settings: the switch is off, the numbers greyed out, the note says what off means; the append box shows the built-in text", () => {
    const off = renderToStaticMarkup(createElement(m.GeneralTab, { settings: settings() }));
    expect(tag(off, "Limit changes per reply")).not.toContain('checked=""');
    expect(tag(off, "Max files")).toContain('disabled=""');
    expect(tag(off, "Max changed lines")).toContain('disabled=""');
    expect(off).toContain("Off (the default): no limit on the files or lines one reply changes");
    expect(tag(off, "System prompt append")).toContain('placeholder="You are working inside a review gate. Run git commands');
    const on = renderToStaticMarkup(createElement(m.GeneralTab, { settings: settings({ budgetEnabled: true }) }));
    expect(tag(on, "Limit changes per reply")).toContain('checked=""');
    expect(tag(on, "Max files")).not.toContain('disabled=""');
    expect(on).toContain("Hard stop at ×2.0");
  });

  it("the HUD has no budget chip and the empty chat names no limit until a limit is set", () => {
    // A server render reads the store's initial state: the scene is set on that object.
    const init = m.useStore.getInitialState();
    const initialState = init.state;
    expect(initialState.budget).toEqual({ maxFiles: 0, maxLines: 0 });
    expect(renderToStaticMarkup(createElement(m.HUDStrip))).not.toContain('data-testid="Budget badge"');
    const empty = renderToStaticMarkup(createElement(m.EmptyTranscript));
    expect(empty).toContain("You&#x27;ll review what Claude changed before you continue.");
    expect(empty).not.toContain("Each reply is limited");

    Object.assign(init, { state: { ...initialState, budget: { maxFiles: 10, maxLines: 400, hardMultiplier: 2 } } });
    try {
      expect(renderToStaticMarkup(createElement(m.HUDStrip))).toContain('data-testid="Budget badge"');
      expect(renderToStaticMarkup(createElement(m.EmptyTranscript))).toContain("Each reply is limited to 10 files / 400 lines");
    } finally {
      Object.assign(init, { state: initialState });
    }
  });
});
