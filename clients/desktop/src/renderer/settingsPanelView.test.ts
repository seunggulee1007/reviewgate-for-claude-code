import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppSettings } from "../shared/ipc";
import { initI18n } from "./i18n";

// docs/PROTOCOL.md §55.11 on Windows: Settings' tabs, its search field, the badge of a row that waits for the next session
// and the one restart banner — rendered to static HTML with the store's initial state as the scene.

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "win32", toolchainInfo: async () => null },
  };
  const { useStore } = await import("./store");
  const { useSessionStart } = await import("./settingsRestart");
  const { sessionStartValues } = await import("./settingsIndex");
  const { SettingsPanel } = await import("./components/settings/SettingsPanel");
  return { useStore, useSessionStart, sessionStartValues, SettingsPanel };
}

const settings = (over: Partial<AppSettings> = {}) =>
  ({
    appearance: "system",
    autoAllowBash: false,
    autoAllowReadOnlyBash: true,
    loadUserSettings: true,
    budgetMaxFiles: 10,
    budgetMaxLines: 400,
    systemPromptAppend: "",
    checkpointIgnorePatterns: "",
    worktreeRoot: "",
    bashAllowPatterns: "",
    projectBashAllowPatterns: {},
    permissionMode: "default",
    claudePath: "",
    ...over,
  }) as unknown as AppSettings;

describe("Settings: tabs, search, when a change applies (§55.11)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("en", "win32");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));

  const scene = (s: AppSettings, session: { open: boolean; starting: boolean; canRestart: boolean }) => {
    const init = m.useStore.getInitialState();
    Object.assign(init, { settings: s, state: { ...init.state, session: { ...init.state.session, ...session } } });
  };

  /** A server render reads the stores' initial state objects: the session's start is set on that one too. */
  const startedWith = (start: Record<string, string> | null) => {
    Object.assign(m.useSessionStart.getInitialState(), { start });
  };

  it("the search field and every tab; a highlighted setting opens its tab", () => {
    scene(settings(), { open: false, starting: false, canRestart: false });
    startedWith(null);
    const out = renderToStaticMarkup(createElement(m.SettingsPanel, { highlight: "autoAllowBash" }));
    expect(out).toContain('placeholder="Search settings"');
    for (const tab of ["General", "Permissions", "Session", "Review", "Git", "Project", "Accounts", "Advanced"]) {
      expect(out).toContain(`data-testid="Settings ${tab}"`);
    }
    // "Auto-allow Bash" lives in Permissions now (it was on General) and carries its badge.
    expect(out).toContain('class="active" data-testid="Settings Permissions"');
    expect(out).toContain('data-setting="autoAllowBash"');
    expect(out).toMatch(/Auto-allow Bash<span class="applies-badge"[^>]*>.*Next session/);
    expect(out).not.toContain('data-testid="Settings restart banner"');
    expect(out).toContain("Settings without a badge apply right away.");
  });

  it("one banner on every tab names what waits for a restart, with Restart now", () => {
    const before = settings();
    startedWith(m.sessionStartValues(before));
    scene(settings({ autoAllowBash: true, systemPromptAppend: "Be brief." }), { open: true, starting: false, canRestart: true });
    for (const tab of ["general", "review", "advanced"] as const) {
      const out = renderToStaticMarkup(createElement(m.SettingsPanel, { initialTab: tab }));
      expect(out).toContain('data-testid="Settings restart banner"');
      expect(out).toContain("Changes apply from the next session");
      expect(out).toContain("Changed: Auto-allow Bash · System prompt append");
      expect(out).not.toMatch(/data-testid="Settings restart now"[^>]*disabled/);
    }
    // Starting: the button says why it waits.
    scene(settings({ autoAllowBash: true }), { open: true, starting: true, canRestart: false });
    const busy = renderToStaticMarkup(createElement(m.SettingsPanel, { initialTab: "general" }));
    expect(busy).toMatch(/disabled=""[^>]*title="This window&#x27;s session cannot restart right now"/);
  });
});
