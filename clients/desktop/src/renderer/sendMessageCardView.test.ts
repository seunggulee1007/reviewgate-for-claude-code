import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PermissionRequest } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import type { ChatItem } from "./store";

// wave2 check-clients — the §33.2 SendMessage card rendered to static HTML (as permissionCards.test.ts does). The CLI's
// SendMessage also carries protocol messages as an object (`{"type": "shutdown_response", "approve": true, …}` — a
// teammate's shutdown or a plan approval, Claude Code 2.1.309): the card showed "(내용 없음)" for those, so the user
// approved a message without seeing it. It shows the object as JSON now.

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  const { useStore } = await import("./store");
  const { PermissionCard } = await import("./components/chat/PermissionCard");
  return { useStore, PermissionCard };
}
type Loaded = Awaited<ReturnType<typeof load>>;

const send = (requestId: string, message: unknown, extra: Record<string, unknown> = {}): PermissionRequest => ({ requestId, toolName: "SendMessage", input: { to: "team-lead", ...extra, message } });

function scene(m: Loaded, pending: PermissionRequest[]) {
  const init = m.useStore.getInitialState();
  const state = init.state;
  Object.assign(init, {
    transcript: pending.map((request, i): ChatItem => ({ kind: "permission", id: i + 1, request, allowed: null })),
    state: { ...state, project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null }, session: { ...state.session, open: true, pendingPermission: pending[0] ?? null, pendingPermissions: pending, peerTurn: null } },
  });
}

const body = (html: string): string => /<pre class="sm-body[^"]*" data-testid="SendMessage body">([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? "";

describe("SendMessage card (§33.2) — what is being sent", () => {
  let m: Loaded;
  beforeAll(async () => {
    initI18n("ko", "darwin");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => scene(m, []));

  it("a protocol message (an object) is shown as JSON, not as an empty message", () => {
    const req = send("S1", { type: "shutdown_response", request_id: "shutdown-7", approve: true });
    scene(m, [req]);
    const html = renderToStaticMarkup(createElement(m.PermissionCard, { request: req, decision: null }));
    const shown = body(html);
    expect(shown).not.toContain("(내용 없음)");
    expect(shown).toContain("&quot;type&quot;: &quot;shutdown_response&quot;");
    expect(shown).toContain("&quot;approve&quot;: true");
    expect(html).toContain('class="sm-body mono"');
  });

  it("plain text stays as written; no message at all still says so", () => {
    const text = send("S2", "MemberService 리뷰 부탁해요\n둘째 줄");
    scene(m, [text]);
    const plain = renderToStaticMarkup(createElement(m.PermissionCard, { request: text, decision: null }));
    expect(body(plain)).toBe("MemberService 리뷰 부탁해요\n둘째 줄");
    expect(plain).toContain('class="sm-body"');
    const none = send("S3", undefined);
    scene(m, [none]);
    expect(body(renderToStaticMarkup(createElement(m.PermissionCard, { request: none, decision: null })))).toBe("(내용 없음)");
  });
});
