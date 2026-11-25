// docs/PROTOCOL.md §67.3 on Windows, the composer as markup: a draft starting with ! is shell mode (the badge, the box's
// shell class, its key hint, "실행" for Send), the caption while results wait for the next message, the stop for a running
// command, and §67.3's "디렉터리 N" chip in the chip row. Nothing of it while a draft is a message.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

const ROOT = "C:\\work\\acme";
const storage = new Map<string, string>();

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    innerHeight: 800,
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "win32", sep: "\\" },
  };
  const store = await import("./store");
  const { projectRootHash } = await import("./sessions");
  const { Composer } = await import("./components/chat/Composer");
  return { store, projectRootHash, Composer };
}

describe("§67.3 the composer's ! shell mode and /add-dir chip", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("ko", "win32");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => storage.clear());

  const render = (draft: string, session: Record<string, unknown> = {}, gate: Record<string, unknown> = {}) => {
    storage.set(`rg.draft.${m.projectRootHash(ROOT)}:chat-1`, draft);
    const s = m.store.useStore.getInitialState().state;
    const state = {
      ...s,
      project: { path: ROOT, root: ROOT, name: "acme", branch: "main", remoteURL: null },
      sessions: { ...(s.sessions ?? {}), currentId: "chat-1", openTabIds: ["chat-1"], list: [] },
      session: { ...s.session, open: true, ready: true, ...session },
      gate: { ...s.gate, canSend: true, phase: "idle", blockedReason: null, ...gate },
    } as ReviewState;
    m.store.useStore.setState({ state, settings: null });
    Object.assign(m.store.useStore.getInitialState(), m.store.useStore.getState());
    return renderToStaticMarkup(createElement(m.Composer));
  };

  it("a draft starting with ! shows the badge, the shell look, its key hint and 실행", () => {
    const html = render("!npm test");
    expect(html).toContain('data-testid="Shell badge"');
    expect(html).toContain("셸");
    expect(html).toContain("composer-input shell-mode");
    expect(html).toContain('aria-label="셸 명령"');
    expect(html).toContain("Enter 셸 명령 실행 · 출력은 다음 메시지와 함께 Claude에게 가요");
    expect(html).toMatch(/data-testid="Send"[^>]*>실행</);
  });

  it("a message has none of it", () => {
    const html = render("run the tests");
    expect(html).not.toContain("Shell badge");
    expect(html).not.toContain("shell-mode");
    expect(html).toMatch(/data-testid="Send"[^>]*>보내기</);
  });

  it("while a command runs: its stop, and a message waits for it", () => {
    const html = render("", { shell: { id: "s1", command: "npm test", cwd: ROOT, startedAt: new Date().toISOString() } }, { canSend: false, blockedReason: "shell_running" });
    expect(html).toContain('data-testid="Stop shell command"');
    expect(html).toContain('title="셸 명령 중지 (esc)"');
    expect(html).toContain('data-testid="Add to queue"');
  });

  it("the caption over the box while results go with the next message", () => {
    expect(render("", { shellPending: 2 })).toContain("셸 결과 2개가 다음 메시지와 함께 Claude에게 가요");
    expect(render("", { shellPending: 0 })).not.toContain("Shell results pending");
  });

  it("the chip row shows the chat's added directories", () => {
    const html = render("", { addedDirs: ["C:\\work\\shared", "D:\\libs"] });
    expect(html).toContain('data-testid="Added directories"');
    expect(html).toContain("디렉터리 2");
    expect(render("", { addedDirs: [] }).includes("Added directories")).toBe(false);
  });
});
