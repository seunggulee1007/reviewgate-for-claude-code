import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PermissionRequest } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import type { ChatItem } from "./store";

// wave3 check-clients — the permission cards as the Mac draws them (rendered to static HTML, the store's initial state
// holds the scene, as in permissionCards.test.ts): a chained Bash command keeps "항상 허용" disabled with its reason, and
// when the oldest request is a question the next ordinary card owns the shortcuts.

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  const { useStore } = await import("./store");
  const { PermissionCard } = await import("./components/chat/PermissionCard");
  const { PermissionHudChip } = await import("./components/chat/PermissionBits");
  const { ReviewNoteBubble } = await import("./components/diff/NoteCards");
  return { useStore, PermissionCard, PermissionHudChip, ReviewNoteBubble };
}
type Loaded = Awaited<ReturnType<typeof load>>;

const req = (requestId: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ requestId, toolName: "Bash", input: { command: "npm test" }, ...extra });
const question = (requestId: string): PermissionRequest => ({ requestId, toolName: "AskUserQuestion", input: { questions: [] } });

function scene(m: Loaded, pending: PermissionRequest[]) {
  const init = m.useStore.getInitialState();
  const state = init.state;
  Object.assign(init, {
    transcript: pending.map((request, i): ChatItem => ({ kind: "permission", id: i + 1, request, allowed: null })),
    state: {
      ...state,
      project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null },
      session: { ...state.session, open: true, pendingPermission: pending[0] ?? null, pendingPermissions: pending, peerTurn: null },
    },
  });
}

const html = (el: ReactElement) => renderToStaticMarkup(el);

describe("permission cards as on the Mac (wave3 check-clients)", () => {
  let m: Loaded;
  beforeAll(async () => {
    initI18n("ko", "darwin");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => scene(m, []));

  it("a chained Bash command keeps '항상 허용', disabled with why; a simple one can use it", () => {
    const chained = req("c", { input: { command: "npm test && git push" } });
    scene(m, [chained]);
    const out = html(createElement(m.PermissionCard, { request: chained, decision: null }));
    expect(out).toMatch(/<button type="button" disabled="" title="이 명령에는 안전한 패턴을 만들 수 없습니다 \(체인, 리디렉션, sudo·sh -c 같은 래퍼, 따옴표\)"[^>]*data-testid="Always allow"/);
    const simple = req("s");
    scene(m, [simple]);
    const ok = html(createElement(m.PermissionCard, { request: simple, decision: null }));
    expect(ok).toContain('data-testid="Always allow"');
    expect(ok).not.toMatch(/disabled=""[^>]*data-testid="Always allow"/);
  });

  it("a question at the head of the queue: the next ordinary card carries the ring and the keys; the HUD jumps to the question", () => {
    scene(m, [question("q"), req("a"), req("b")]);
    const a = html(createElement(m.PermissionCard, { request: req("a"), decision: null }));
    const b = html(createElement(m.PermissionCard, { request: req("b"), decision: null }));
    expect(a).toContain('class="perm target"');
    expect(a).toContain("<kbd>⌘↩</kbd>");
    expect(b).not.toContain("target");
    expect(html(createElement(m.PermissionHudChip))).toContain("권한 요청 3개 대기");
  });

  it("a sent note whose line is gone shows the line it was written on (the Mac's SentNoteCard)", () => {
    const note = { id: "n1", path: "a.ts", line: 12, side: "new" as const, excerpt: "int b = 2;", body: "b는 2 그대로 둬", sent: { at: "t", turn: 4 } };
    const gone = html(createElement(m.ReviewNoteBubble, { note: { ...note, anchor: "gone" as const }, onRemove: () => undefined }));
    expect(gone).toContain("위치 사라짐");
    expect(gone).toMatch(/data-testid="Note gone excerpt"[^>]*>int b = 2;</);
    const moved = html(createElement(m.ReviewNoteBubble, { note: { ...note, anchor: "moved" as const }, onRemove: () => undefined }));
    expect(moved).not.toContain("Note gone excerpt");
  });
});
