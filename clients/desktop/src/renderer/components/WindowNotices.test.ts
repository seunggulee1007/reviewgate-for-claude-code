/**
 * r2-review-flow M27 (§49.2): the window's information banners — the new CLI, a notification the OS did not show, a new
 * workbench's failed setup — one is its banner; two or more fold into one "알림 N개" chip whose popover holds them
 * (react-dom/server, props only).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n } from "../i18n";
import type { WindowNotice } from "./WindowNotices";

type ChipProps = { count: number; children: ReactNode; initiallyOpen?: boolean };
let Chip: FunctionComponent<ChipProps>;
let noticesOf: (p: { cliVersion: boolean; notifications: boolean; setupReport: boolean }) => WindowNotice[];
let folds: (notices: readonly WindowNotice[]) => boolean;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }), setSettings: async () => ({}), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  const mod = await import("./WindowNotices");
  Chip = mod.WindowNoticesChip;
  noticesOf = mod.windowNoticesOf;
  folds = mod.foldsWindowNotices;
  initI18n("ko", "darwin");
});
afterAll(() => initI18n("en", "darwin"));

const chip = (props: ChipProps) => renderToStaticMarkup(createElement(Chip, props));

describe("window notices (M27, §49.2)", () => {
  it("lists the banners that stand in the order they are drawn", () => {
    expect(noticesOf({ cliVersion: true, notifications: true, setupReport: true })).toEqual(["cliVersion", "notifications", "setupReport"]);
    expect(noticesOf({ cliVersion: false, notifications: true, setupReport: true })).toEqual(["notifications", "setupReport"]);
    expect(noticesOf({ cliVersion: false, notifications: false, setupReport: false })).toEqual([]);
  });

  it("one notice stays its banner; two or more fold into the chip", () => {
    expect(folds([])).toBe(false);
    expect(folds(["cliVersion"])).toBe(false);
    expect(folds(["cliVersion", "setupReport"])).toBe(true);
    expect(folds(["cliVersion", "notifications", "setupReport"])).toBe(true);
  });

  it("the folded row says how many, what a click shows, and keeps the banners out of the way until it is opened", () => {
    const html = chip({ count: 2, children: createElement("div", { className: "banner orange" }, "새 CLI 2.1.308") });
    expect(html).toContain("알림 2개");
    const button = /<button[^>]*data-testid="Window notices chip"[^>]*>/.exec(html)?.[0];
    expect(button).toContain('title="이 창의 알림 — CLI 버전, 알림 설정, 워크벤치 준비 — 클릭해서 보기"'); // what the popover holds
    expect(button).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="Window notices popover"');
    expect(html).not.toContain("새 CLI 2.1.308");
  });

  it("opened, its popover holds the banners as they are, named for VoiceOver", () => {
    const html = chip({ count: 3, initiallyOpen: true, children: createElement("div", { className: "banner orange" }, "새 CLI 2.1.308") });
    expect(/<button[^>]*data-testid="Window notices chip"[^>]*>/.exec(html)?.[0]).toContain('aria-expanded="true"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="알림 3개"');
    expect(html).toContain("새 CLI 2.1.308");
  });
});
