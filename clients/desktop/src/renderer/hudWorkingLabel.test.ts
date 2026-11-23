import { afterAll, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";

// The status line under the composer while a turn runs that the engine still reports idle (before its first event):
// "Working · 12s", never "Idle" (the Mac's HUDState.statusText).

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin", toolchainInfo: async () => null },
  };
  const { activityText } = await import("./components/chat/HUDStrip");
  return { activityText };
}

describe("the HUD's activity while a turn runs", () => {
  afterAll(() => initI18n("en", "darwin"));

  it("is the working label with the turn's time, never Idle", async () => {
    const { activityText } = await load();
    initI18n("en", "darwin");
    expect(activityText({ kind: "idle" }, true, undefined, 12.4)).toBe("Working · 12s");
    expect(activityText({ kind: "idle" }, true)).toBe("Working…");
    expect(activityText({ kind: "idle" }, false)).toBe("Idle");
    expect(activityText({ kind: "tool", toolName: "Bash", detail: "npm test" }, true, undefined, 30)).toBe("Running Bash: npm test");
    initI18n("ko", "win32");
    expect(activityText({ kind: "idle" }, true, undefined, 12.4)).toBe("작업 중 · 12초");
    expect(activityText({ kind: "idle" }, false)).toBe("쉬는 중");
  });
});
