import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n } from "./i18n";
import { middleTruncate } from "./toast";

// polish p-foundation — the shared pieces the screens adopt: "복사됨: …", a relative time that keeps up, a path cut in the
// middle, a button off for a reason.

beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = { rg: { copyText: async () => undefined, platform: "win32" } };
  initI18n("ko", "win32");
});
afterAll(() => initI18n("en", "darwin"));
afterEach(() => vi.useRealTimers());

describe("copy", () => {
  it("one line names what was copied, cut in the middle past 80 characters; several lines just say copied", async () => {
    const { copiedText } = await import("./components/common/CopyButton");
    expect(copiedText("src/main/Svc.java")).toBe("복사함: src/main/Svc.java");
    const long = "/work/acme/" + "very-long-folder/".repeat(8) + "Svc.java";
    const shown = copiedText(long);
    expect(shown.endsWith("Svc.java")).toBe(true);
    expect(Array.from(shown.slice("복사함: ".length)).length).toBe(80);
    expect(copiedText("line one\nline two")).toBe("복사됨");
    expect(middleTruncate("abcdefghij", 5)).toBe("ab…ij");
    expect(middleTruncate("abc", 5)).toBe("abc");
  });

  it("a copy button reads 복사, or is an icon named by its title", async () => {
    const { CopyButton } = await import("./components/common/CopyButton");
    expect(renderToStaticMarkup(createElement(CopyButton, { text: "x", title: "메시지 복사" }))).toContain(">복사</button>");
    const icon = renderToStaticMarkup(createElement(CopyButton, { text: "x", title: "출력 복사", iconOnly: true }));
    expect(icon).toContain('aria-label="출력 복사"');
    expect(icon).toContain("<svg");
  });
});

describe("relative time", () => {
  it("a <time> with the exact time on hover; nothing without a time", async () => {
    const { RelTime } = await import("./components/common/RelTime");
    const iso = new Date(Date.now() - 3 * 60_000).toISOString();
    const out = renderToStaticMarkup(createElement(RelTime, { iso }));
    expect(out).toContain(`dateTime="${iso}"`);
    expect(out).toContain("3분 전");
    expect(out).toMatch(/title="[^"]*20\d\d[^"]*"/);
    expect(renderToStaticMarkup(createElement(RelTime, { iso: null }))).toBe("");
  });

  it("one shared timer per interval wakes its components and stops with the last one", async () => {
    vi.useFakeTimers();
    const { nowTicker } = await import("./components/common/RelTime");
    const ticker = nowTicker(1000);
    let a = 0;
    let b = 0;
    const offA = ticker.subscribe(() => a++);
    const offB = ticker.subscribe(() => b++);
    const start = ticker.snapshot();
    vi.advanceTimersByTime(2500);
    expect([a, b]).toEqual([2, 2]);
    expect(ticker.snapshot()).toBeGreaterThan(start);
    offA();
    offB();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a path cut in the middle", () => {
  it("keeps the file name whole, with the whole path on hover — Windows paths too", async () => {
    const { MiddlePath } = await import("./components/common/MiddlePath");
    const out = renderToStaticMarkup(createElement(MiddlePath, { path: "src/main/java/Svc.java" }));
    expect(out).toContain('title="src/main/java/Svc.java"');
    expect(out).toContain('<span class="head truncate">src/main/java/</span><span class="tail">Svc.java</span>');
    const win = renderToStaticMarkup(createElement(MiddlePath, { path: "C:\\work\\acme\\Svc.java", prefix: "from" }));
    expect(win).toContain('<span class="tail">Svc.java</span>');
    expect(win).toContain("from");
  });
});

describe("a button off for a reason", () => {
  it("is dimmed, not disabled, and its tooltip is the reason; on, it keeps its own", async () => {
    const { ReasonButton } = await import("./components/common/ReasonButton");
    const off = renderToStaticMarkup(createElement(ReasonButton, { reason: "Claude가 턴을 마치면 할 수 있어요", title: "Claude로 작성", children: "작성" }));
    expect(off).toContain('aria-disabled="true"');
    expect(off).toContain('title="Claude가 턴을 마치면 할 수 있어요"');
    expect(off).not.toContain("disabled=\"\"");
    const on = renderToStaticMarkup(createElement(ReasonButton, { reason: null, title: "Claude로 작성", children: "작성" }));
    expect(on).not.toContain("aria-disabled");
    expect(on).toContain('title="Claude로 작성"');
  });
});
