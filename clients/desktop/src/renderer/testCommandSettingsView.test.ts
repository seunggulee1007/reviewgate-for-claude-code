/** wave3 check-clients — Settings › General › "테스트 명령 패턴" as it renders (the Mac's TestCommandSettingsSection words). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppSettings } from "../shared/ipc";
import { initI18n } from "./i18n";

let Section: FunctionComponent<{ settings: AppSettings }>;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), setSettings: async () => ({}), notify: async () => true, onEvent: () => () => undefined, platform: "win32" },
  };
  Section = (await import("./components/settings/TestCommandPatterns")).TestCommandPatternsSection;
  initI18n("ko", "win32");
});
afterAll(() => initI18n("en", "darwin"));

describe("Settings › 테스트 명령 패턴", () => {
  it("shows the stored patterns, how they match and what is recognized without one", () => {
    const out = renderToStaticMarkup(createElement(Section, { settings: { testCommandPatterns: "./run-tests.sh*" } as AppSettings }));
    expect(out).toContain("테스트 명령 패턴");
    expect(out).toContain(">./run-tests.sh*</textarea>");
    expect(out).toContain("패턴 없이도 알아보는 명령: mvn · mvnw · *mvn*.sh · gradle · gradlew");
    expect(out).toContain("Maven·Gradle은 테스트를 실행하는 goal·task일 때만 셉니다");
  });

  it("an older settings file without the key shows an empty box", () => {
    const out = renderToStaticMarkup(createElement(Section, { settings: {} as AppSettings }));
    expect(out).toContain('placeholder="./run-tests.sh*"');
    expect(out).toMatch(/data-testid="Test command patterns"><\/textarea>/);
  });
});
