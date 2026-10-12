import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PeerMessage, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

// wave2 check-clients — the §29 card rendered to static HTML (as permissionCards.test.ts does): a blocked
// "Claude가 처리" says why in a line on the card, not only in its tooltip (handoff §2.7; the Mac shows it the same way).

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  const { useStore } = await import("./store");
  const { PeerCard } = await import("./components/chat/PeerCard");
  return { useStore, PeerCard };
}
type Loaded = Awaited<ReturnType<typeof load>>;

const msg = (id: string, extra: Partial<PeerMessage> = {}): PeerMessage => ({ id, from: "uds:/tmp/cc-socks/4242.sock", fromName: "acme-b4", verifiedPeerPid: null, cause: "explicit-setting", receivedAt: "2026-10-22T08:00:00Z", state: "held", ...extra });

function scene(m: Loaded, inbox: PeerMessage[], gate: Partial<ReviewState["gate"]>, extra: { peerBusy?: "accept" | "dismiss" | null } = {}) {
  const init = m.useStore.getInitialState();
  const state = init.state;
  Object.assign(init, {
    peerBusy: extra.peerBusy ?? null,
    peerNotice: null,
    peerHidden: [],
    state: {
      ...state,
      project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null },
      session: { ...state.session, open: true, ready: true, peerInbox: inbox, externalTurn: null },
      gate: { ...state.gate, ...gate },
    },
  });
}

describe("peer card (§29) — why Claude가 처리 waits", () => {
  let m: Loaded;
  beforeAll(async () => {
    initI18n("ko", "darwin");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => scene(m, [], { canSend: true, phase: "idle", blockedReason: null }));

  it("a closed gate puts the reason on the card next to the disabled button", () => {
    scene(m, [msg("a")], { canSend: false, phase: "running", blockedReason: "running" });
    const out = renderToStaticMarkup(createElement(m.PeerCard));
    expect(out).toContain('data-testid="Peer accept waits"');
    expect(out).toContain(">진행 중인 작업이 끝나면 처리할 수 있어요</span>");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*data-testid="Peer accept"/);
  });

  it("no line while it can run, or while the card hands messages over (the spinner says it)", () => {
    scene(m, [msg("a")], { canSend: true, phase: "idle", blockedReason: null });
    expect(renderToStaticMarkup(createElement(m.PeerCard))).not.toContain("Peer accept waits");
    scene(m, [msg("a")], { canSend: false, phase: "running", blockedReason: "running" }, { peerBusy: "accept" });
    const busy = renderToStaticMarkup(createElement(m.PeerCard));
    expect(busy).not.toContain("Peer accept waits");
    expect(busy).toContain('data-testid="Peer delivering"');
  });
});
