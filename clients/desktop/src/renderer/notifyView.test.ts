/** MARK: wave4b w4-notify — Settings › 알림 as it renders on Windows: one switch per group and where to look in the OS (§39.6). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppSettings } from "../shared/ipc";
import { initI18n } from "./i18n";

let Section: FunctionComponent<{ settings: AppSettings; patch: (p: Partial<AppSettings>) => void }>;
let Banner: FunctionComponent;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async () => ({ ok: true, reply: {} }),
      setSettings: async () => ({}),
      notify: async () => true,
      onEvent: () => () => undefined,
      openNotificationSettings: async () => true,
      platform: "win32",
    },
  };
  const m = await import("./components/NotificationNotices");
  Section = m.NotificationGroupsSection;
  Banner = m.NotificationTroubleBanner;
  initI18n("ko", "win32");
});
afterAll(() => initI18n("en", "darwin"));

describe("Settings › 알림 (Windows)", () => {
  it("three switches, on by default, and where Windows hides notifications", () => {
    const out = renderToStaticMarkup(createElement(Section, { settings: { notifications: true } as AppSettings, patch: () => undefined }));
    expect(out).toContain("허용 요청·질문·계획");
    expect(out).toContain("작업이 끝났을 때");
    expect(out).toContain("그 밖의 알림 (오류·곁질문·다른 세션·서브에이전트)");
    expect(out.match(/ checked=""/g)?.length).toBe(3);
    expect(out).toContain("알림이 안 보이면: Windows 설정 › 시스템 › 알림에서 ReviewGate와 방해 금지(집중 지원)를 확인하세요.");
    expect(out).toContain('data-testid="Open notification settings"');
  });

  it("a switch turned off stays off; with notifications off they are disabled", () => {
    const off = renderToStaticMarkup(createElement(Section, { settings: { notifications: true, notifyTurnEnd: false } as AppSettings, patch: () => undefined }));
    expect(off.match(/ checked=""/g)?.length).toBe(2);
    const all = renderToStaticMarkup(createElement(Section, { settings: { notifications: false } as AppSettings, patch: () => undefined }));
    expect(all.match(/disabled=""/g)?.length).toBe(3);
  });

  it("the window says nothing until the OS refused a notification", () => {
    expect(renderToStaticMarkup(createElement(Banner))).toBe("");
  });
});
