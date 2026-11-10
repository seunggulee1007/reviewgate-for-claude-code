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
  const { PeerMessageRow, peerCopyItems } = await import("./components/chat/PeerMessageRow"); // r2-peers
  return { useStore, PeerCard, PeerMessageRow, peerCopyItems };
}
type Loaded = Awaited<ReturnType<typeof load>>;

const msg = (id: string, extra: Partial<PeerMessage> = {}): PeerMessage => ({ id, from: "uds:/tmp/cc-socks/4242.sock", fromName: "acme-b4", verifiedPeerPid: null, cause: "explicit-setting", receivedAt: "2026-10-22T08:00:00Z", state: "held", ...extra });

function scene(m: Loaded, inbox: PeerMessage[], gate: Partial<ReviewState["gate"]>, extra: { peerBusy?: "accept" | "dismiss" | null; mode?: "ask" | "auto" | "off" } = {}) {
  const init = m.useStore.getInitialState();
  const state = init.state;
  Object.assign(init, {
    peerBusy: extra.peerBusy ?? null,
    peerNotice: null,
    peerHidden: [],
    state: {
      ...state,
      project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null },
      session: { ...state.session, open: true, ready: true, peerInbox: inbox, externalTurn: null, ...(extra.mode ? { peerInbound: extra.mode } : {}) },
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

// MARK: r2-peers — §29: what auto runs by itself is one line, not a card.
describe("peer card (§29) — auto, the default", () => {
  let m: Loaded;
  const sender = { address: "uds:/tmp/cc-socks/4242.sock", pid: 4242, name: "acme-terminal", cwd: "/work/acme", status: "idle" as const, entrypoint: "cli" };
  beforeAll(async () => {
    initI18n("en", "darwin");
    m = await load();
  });

  it("a message from a live session of the user's is one line — who sent it, [Decline] and ⋯, no [Let Claude handle it]", () => {
    scene(m, [msg("a", { sender })], { canSend: false, phase: "running", blockedReason: "running" }, { mode: "auto" });
    const out = renderToStaticMarkup(createElement(m.PeerCard));
    expect(out).toContain('data-testid="Peer runs by itself"');
    expect(out).toContain("Message from acme-terminal — Claude handles it once the current work is done");
    expect(out).toContain('data-testid="Peer dismiss"');
    expect(out).not.toContain('data-testid="Peer accept"');
  });

  it("one the registry does not vouch for — or ask mode — keeps the card", () => {
    scene(m, [msg("a", { sender }), msg("b")], { canSend: true, phase: "idle", blockedReason: null }, { mode: "auto" });
    expect(renderToStaticMarkup(createElement(m.PeerCard))).toContain('data-testid="Peer accept"');
    scene(m, [msg("a", { sender })], { canSend: true, phase: "idle", blockedReason: null }, { mode: "ask" });
    expect(renderToStaticMarkup(createElement(m.PeerCard))).toContain('data-testid="Peer accept"');
  });

  it("the row of a turn a message started says so; a row without its turn does not", () => {
    // No body: its Markdown needs a DOM to sanitize, which a static render has not.
    const row = { kind: "peer" as const, id: 1, messageId: "a", from: "uds:/tmp/cc-socks/4242.sock", fromName: "acme-b4", verifiedPeerPid: 4242, state: "delivered" as const };
    expect(renderToStaticMarkup(createElement(m.PeerMessageRow, { item: { ...row, turn: 3 } }))).toContain("A turn a message from another session started");
    expect(renderToStaticMarkup(createElement(m.PeerMessageRow, { item: row }))).not.toContain('data-testid="Peer started turn"');
  });
});

// MARK: r2-peers — polish P4-composer-36: ⋯ says what it holds, a disabled [Decline] says why, a row copies on right-click.
describe("peer card and rows (§29) — the details", () => {
  let m: Loaded;
  beforeAll(async () => {
    initI18n("en", "darwin");
    m = await load();
  });

  it("⋯ has a name and a tooltip; while the messages are handed over [Decline] and ⋯ say so", () => {
    scene(m, [msg("a")], { canSend: true, phase: "idle", blockedReason: null });
    const idle = renderToStaticMarkup(createElement(m.PeerCard));
    expect(idle).toContain('aria-label="Options for messages from other sessions"');
    expect(idle).toContain("Options for messages from other sessions — don&#x27;t accept them in this project");
    scene(m, [msg("a")], { canSend: false, phase: "running", blockedReason: "running" }, { peerBusy: "accept" });
    const busy = renderToStaticMarkup(createElement(m.PeerCard));
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*title="The messages are being handed over"[^>]*data-testid="Peer dismiss"/);
    expect(busy).toMatch(/<button[^>]*title="The messages are being handed over"[^>]*aria-label="Options for messages from other sessions"[^>]*disabled=""/);
  });

  it("right-click copies the message and the sender's address; the sender's name shows the address on hover", () => {
    const from = "uds:/tmp/cc-socks/4242.sock";
    expect(m.peerCopyItems({ body: "#42 done", from }).map((i) => [i.label, i.testId])).toEqual([
      ["Copy message", "Copy peer message"],
      ["Copy sender address", "Copy peer sender address"],
    ]);
    expect(m.peerCopyItems({ from }).map((i) => i.testId)).toEqual(["Copy peer sender address"]);
    const row = { kind: "peer" as const, id: 1, messageId: "a", from, fromName: "acme-b4", verifiedPeerPid: 4242, state: "delivered" as const };
    expect(renderToStaticMarkup(createElement(m.PeerMessageRow, { item: row }))).toContain(`title="${from}"`);
    expect(renderToStaticMarkup(createElement(m.PeerMessageRow, { item: { ...row, state: "dropped" as const, outcome: "declined" } }))).toContain(`title="${from}"`);
  });
});
