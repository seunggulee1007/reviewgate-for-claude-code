/**
 * MARK: wave3 desktop-session — §36.7 the HUD's "확장 꺼짐" popover as it renders (react-dom/server, props only): why,
 * the engine's own retry note, a refusal, and "확장 켜고 다시 시도" off with the reason while Claude works.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n } from "../../i18n";

type DetailsProps = { timeoutMs: number; supported: boolean; error: string | null; retrying: boolean; blockedReason: string | null; onRetry: () => void; onDetails: () => void };
let ExtensionsOffDetails: FunctionComponent<DetailsProps>;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }), setSettings: async () => ({}), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  ExtensionsOffDetails = (await import("./ExtensionsChips")).ExtensionsOffDetails;
  initI18n("ko", "darwin");
});
afterAll(() => initI18n("en", "darwin"));

const render = (p: Partial<DetailsProps>) =>
  renderToStaticMarkup(createElement(ExtensionsOffDetails, { timeoutMs: 45000, supported: true, error: null, retrying: false, blockedReason: null, onRetry: () => undefined, onDetails: () => undefined, ...p }));
const button = (html: string) => /<button[^>]*data-testid="HUD retry with extensions"[^>]*>/.exec(html)?.[0] ?? "";

describe("확장 꺼짐 (§36.7)", () => {
  it("says why, that ReviewGate retries once by itself, and offers the retry", () => {
    const html = render({});
    expect(html).toContain("확장 꺼짐");
    expect(html).toContain("확장 로딩이 45초를 넘어 확장 없이 시작했습니다");
    expect(html).toContain("Claude가 한가해지면 ReviewGate가 한 번 더 스스로 다시 시도합니다.");
    expect(html).toContain("확장 켜고 다시 시도");
    expect(button(html)).not.toContain("disabled");
  });

  it("an engine before §36 does not retry by itself: no such note", () => {
    expect(render({ supported: false })).not.toContain("스스로 다시 시도");
  });

  it("the retry waits for the turn, with the reason; a refusal is shown", () => {
    const html = render({ blockedReason: "Claude가 턴을 마칠 때까지 기다리세요", error: "Claude가 작업 중…" });
    expect(button(html)).toContain('disabled=""');
    expect(html).toContain("Claude가 턴을 마칠 때까지 기다리세요");
    expect(html).toContain('data-testid="Extensions retry error"');
  });
});
