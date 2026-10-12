/**
 * MARK: wave3 desktop-session — §36.8 as it renders (react-dom/server, props only): the "새 CLI — 아직 검증 안 됨" banner
 * with "이전 버전으로 고정" only when the previous version is still installed, the pin's restart hint, and Settings
 * "CLI 버전 고정" (verified / current / pinned, an older engine off with the reason).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CliVersionsEvent } from "@reviewgate/engine";
import { initI18n } from "../i18n";
import type { CliBanner } from "../sessionTools";

type BannerProps = { banner: CliBanner; pinError: string | null; canRestart: boolean; onPin: (v: string) => void; onRestart: () => void; onDismiss: () => void };
type ListProps = { versions: CliVersionsEvent | null; loading: boolean; error: string | null; supported: boolean; pinned: string | null; running: string | null; onPin: (v: string | null) => void; onRefresh: () => void };
let Banner: FunctionComponent<BannerProps>;
let List: FunctionComponent<ListProps>;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }), setSettings: async () => ({}), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  Banner = (await import("./CliVersionBanner")).CliVersionBannerView;
  List = (await import("./settings/CliVersions")).CliVersionView;
  initI18n("ko", "darwin");
});
afterAll(() => initI18n("en", "darwin"));

const noop = () => undefined;
const banner = (b: CliBanner, more: Partial<BannerProps> = {}) => renderToStaticMarkup(createElement(Banner, { banner: b, pinError: null, canRestart: true, onPin: noop, onRestart: noop, onDismiss: noop, ...more }));
const list = (more: Partial<ListProps>) => renderToStaticMarkup(createElement(List, { versions: null, loading: false, error: null, supported: true, pinned: null, running: null, onPin: noop, onRefresh: noop, ...more }));

describe("CLI version banner (§36.8)", () => {
  const range = { min: "2.1.300", max: "2.1.307" };
  it("an unverified CLI with the previous one installed: the range and 'Pin previous version'", () => {
    const html = banner({ kind: "unverified", version: "2.1.308", range, previous: { version: "2.1.307", path: "/Users/me/.local/share/claude/versions/2.1.307" } });
    expect(html).toContain("새 CLI 2.1.308 — 아직 검증 안 됨");
    expect(html).toContain("ReviewGate는 Claude Code 2.1.300–2.1.307에서 확인했어요.");
    expect(html).toContain("이전 버전으로 고정");
    expect(html).toContain('data-testid="CLI banner dismiss"');
  });

  it("no pin button when the previous version is gone (or unknown); a refused pin says why", () => {
    const html = banner({ kind: "unverified", version: "2.1.308", range: null, previous: { version: "2.1.307", path: null } }, { pinError: "no such version" });
    expect(html).not.toContain('data-testid="CLI pin previous"');
    expect(html).toContain("사용하지 않음: no such version");
  });

  it("a pin waits for the next session start: 'Restart now' (off while Claude works)", () => {
    const html = banner({ kind: "pinned", version: "2.1.307" }, { canRestart: false });
    expect(html).toContain("2.1.307(으)로 고정했어요 — 다음 세션 시작부터 써요");
    expect(/<button[^>]*data-testid="CLI pinned restart"[^>]*>/.exec(html)?.[0]).toContain('disabled=""');
  });
});

describe("Settings › CLI 버전 고정 (§36.8)", () => {
  const versions: CliVersionsEvent = { type: "cli_versions", versions: [{ version: "2.1.308", path: "/v/2.1.308", verified: false }, { version: "2.1.307", path: "/v/2.1.307", verified: true }], current: "2.1.308", pinnedPath: "/Users/me/.local/share/claude/versions/2.1.307" };

  it("lists the versions newest first with verified / current / pinned; the pinned one cannot be pinned again", () => {
    const html = list({ versions, pinned: "2.1.307" });
    expect(html).toContain("CLI 버전 고정");
    expect(html.indexOf("2.1.308")).toBeLessThan(html.indexOf("2.1.307"));
    expect(html).toContain("검증 안 됨");
    expect(html).toContain("검증됨");
    expect(html).toContain("현재");
    expect(html).toContain("고정됨");
    expect(/<button[^>]*data-testid="CLI pin 2.1.307"[^>]*>/.exec(html)?.[0]).toContain('disabled=""');
    expect(/<button[^>]*data-testid="CLI pin 2.1.308"[^>]*>/.exec(html)?.[0]).not.toContain("disabled");
    expect(html).toContain("최신으로 되돌리기(자동 감지)");
  });

  it("an engine without cli_versions: off with the reason", () => {
    const html = list({ supported: false });
    expect(html).toContain('data-testid="CLI versions unavailable"');
    expect(html).toContain("이 엔진은 아직 지원하지 않습니다");
  });

  it("no native installer versions: says so", () => {
    expect(list({ versions: { ...versions, versions: [], pinnedPath: null } })).toContain("네이티브 설치본 버전이 없어요");
  });
});
