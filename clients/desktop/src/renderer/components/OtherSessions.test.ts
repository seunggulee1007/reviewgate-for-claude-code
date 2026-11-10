/**
 * MARK: wave3 desktop-session — §36.9 as it renders (react-dom/server, props only): the sidebar's "이 저장소의 다른 Claude
 * 세션" (status words, this folder marked, waiting counted) and the "CLI 세션 가져오기" sheet (the gate notice, import /
 * "터미널에서 이어가기", import off with the reason while the window is busy).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CliResumableSession, CliRunningSession } from "@reviewgate/engine";
import { initI18n } from "../i18n";

type SectionProps = { running: CliRunningSession[] | null; loading: boolean; error: string | null; open: boolean; onToggle: () => void; onImport: () => void };
type SheetProps = { resumable: CliResumableSession[] | null; loading: boolean; importing: string | null; error: string | null; blocked: string | null; folder: string; platform: string; onImport: (id: string) => void; onCopy: (c: string) => void };
let Section: FunctionComponent<SectionProps>;
let Sheet: FunctionComponent<SheetProps>;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }), setSettings: async () => ({}), notify: async () => true, onEvent: () => () => undefined, platform: "darwin", copyText: async () => undefined },
  };
  const m = await import("./OtherSessions");
  Section = m.OtherSessionsView;
  Sheet = m.CliImportView;
  initI18n("ko", "darwin");
});
afterAll(() => initI18n("en", "darwin"));

const noop = () => undefined;
const running: CliRunningSession[] = [
  { pid: 82411, sessionId: "5d0c", name: "acme-b4", cwd: "/Users/me/acme", status: "waiting", entrypoint: "cli", sameWorktree: true },
  { pid: 82500, sessionId: null, name: null, cwd: "/Users/me/acme-1600", status: "busy", entrypoint: "cli", sameWorktree: false },
  { pid: 82600, sessionId: "aa11bb22cc", name: null, cwd: "/Users/me/acme", status: "idle", entrypoint: "sdk-ts", sameWorktree: false },
];
const section = (p: Partial<SectionProps>) => renderToStaticMarkup(createElement(Section, { running, loading: false, error: null, open: true, onToggle: noop, onImport: noop, ...p }));
const sheet = (p: Partial<SheetProps>) =>
  renderToStaticMarkup(createElement(Sheet, { resumable: [{ sessionId: "9f1e", title: "장바구니 합계 수정", updatedAt: "2026-10-23T02:10:00.000Z", cwd: "/Users/me/acme-1600" }], loading: false, importing: null, error: null, blocked: null, folder: "/Users/me/acme", platform: "darwin", onImport: noop, onCopy: noop, ...p }));

describe("이 저장소의 다른 Claude 세션 (§36.9)", () => {
  it("name, folder and status; one in this folder is marked", () => {
    const html = section({});
    expect(html).toContain("이 저장소의 다른 Claude 세션");
    expect(html).toContain("acme-b4");
    expect(html).toContain("acme-1600");
    expect(html).toContain("입력 대기");
    expect(html).toContain("작업 중");
    expect(html).toContain("쉬는 중");
    expect(html).toContain("이 폴더");
    // no name: the session id's start, else the pid
    expect(html).toContain("aa11bb22");
    expect(html).toContain("pid 82500");
    // expanded, the rows say who waits; the header keeps room for its title
    expect(html).not.toContain("입력 대기 1");
  });

  it("collapsed: only the header, which still counts the ones waiting for input; nothing running: says so", () => {
    const collapsed = section({ open: false });
    expect(collapsed).not.toContain("os-row");
    expect(collapsed).toContain("입력 대기 1");
    expect(section({ running: [] })).toContain("지금 이 저장소에서 도는 다른 Claude 세션이 없어요.");
  });
});

describe("CLI 세션 가져오기 (§36.9)", () => {
  it("says the review gate applies from then on, lists the conversations with import and 'Continue in terminal'", () => {
    const html = sheet({});
    expect(html).toContain("이 시점부터 리뷰 게이트가 적용돼요");
    expect(html).toContain("장바구니 합계 수정");
    expect(html).toContain("터미널에서 이어가기");
    expect(html).toContain("복사: cd /Users/me/acme-1600 &amp;&amp; claude --resume 9f1e");
    expect(/<button[^>]*data-testid="CLI import 9f1e"[^>]*>/.exec(html)?.[0]).not.toContain("disabled");
  });

  it("import is off with the reason while the window is busy; a refusal is shown", () => {
    const html = sheet({ blocked: "Claude가 작업 중…", error: "그 대화가 아직 터미널에서 실행 중이에요" });
    expect(/<button[^>]*data-testid="CLI import 9f1e"[^>]*>/.exec(html)?.[0]).toContain('disabled=""');
    expect(html).toContain('data-testid="CLI import blocked"');
    expect(html).toContain('data-testid="CLI import error"');
  });

  it("nothing to import: says so", () => {
    expect(sheet({ resumable: [] })).toContain("가져올 이 저장소의 터미널 대화가 없어요.");
  });
});
