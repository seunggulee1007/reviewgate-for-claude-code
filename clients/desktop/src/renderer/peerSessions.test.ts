import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PeerSessionInfo, PermissionRequest } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import type { ChatItem } from "./store";
import { recipientAddress, recipientDetail, recipientTitle, selfCopyText, tildePath, toSessionOf } from "./peerSessions";
import { cliSessionsOf, peerSelfOf } from "./sessionTools";

// MARK: wave4d w4d-peers — docs/PROTOCOL.md §42.2 on the desktop client (audit peer-05, peer-07): the SendMessage card names
// the session it reaches (`toSession`) instead of a socket path, and the "Other Claude sessions" section says how the
// user's other sessions see this window (`cli_sessions.self`). Older engines send neither: as before.

const B4: PeerSessionInfo = { address: "uds:/tmp/cc-socks/76616.sock", pid: 76616, name: "acme-b4", cwd: "/Users/me/acme", status: "waiting", entrypoint: "cli" };
const send = (requestId: string, to: string, toSession?: unknown): PermissionRequest =>
  ({ requestId, toolName: "SendMessage", input: { to, message: "#514 끝났어", summary: "done" }, ...(toSession ? { toSession } : {}) }) as PermissionRequest;

describe("whom a SendMessage reaches (§42.2)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("the registry name, where it runs (home as ~) and the address; an older engine keeps input.to", () => {
    const req = send("S1", B4.address, B4);
    expect(recipientTitle(req)).toBe("acme-b4");
    expect(recipientDetail(toSessionOf(req))).toBe("터미널 · ~/acme · 입력 대기");
    expect(recipientAddress(req)).toBe(B4.address);
    const old = send("S2", "uds:/tmp/cc-socks/1.sock");
    expect(recipientTitle(old)).toBe("uds:/tmp/cc-socks/1.sock");
    expect(recipientDetail(toSessionOf(old))).toBe("");
    expect(recipientAddress(old)).toBeNull();
    // A malformed toSession is ignored; an unnamed session's address is the title, not repeated below.
    expect(toSessionOf(send("S3", "a1b2", { name: "x" }))).toBeNull();
    const unnamed = send("S4", "uds:/tmp/cc-socks/9.sock", { address: "uds:/tmp/cc-socks/9.sock", pid: 9, status: "busy", entrypoint: "sdk-ts" });
    expect(recipientTitle(unnamed)).toBe("uds:/tmp/cc-socks/9.sock");
    expect(recipientAddress(unnamed)).toBeNull();
    expect(recipientDetail(toSessionOf(unnamed))).toBe("앱 · 작업 중");
  });

  it("home folders are written as ~ on macOS, Linux and Windows; other paths stay", () => {
    expect(tildePath("/Users/me/acme")).toBe("~/acme");
    expect(tildePath("/home/me")).toBe("~");
    expect(tildePath("C:\\Users\\me\\work\\acme")).toBe("~\\work\\acme");
    expect(tildePath("/opt/acme")).toBe("/opt/acme");
  });
});

describe("this window's name for other sessions (§42.2)", () => {
  it("cli_sessions.self is kept when the engine sends it; the copy is `name (address)`", () => {
    const view = cliSessionsOf({ running: [], resumable: [], self: { pid: 4321, name: "ReviewGate · acme", address: "uds:/tmp/cc-socks/4321.sock" } });
    expect(view.self).toEqual({ pid: 4321, name: "ReviewGate · acme", address: "uds:/tmp/cc-socks/4321.sock" });
    expect(selfCopyText(view.self!)).toBe("ReviewGate · acme (uds:/tmp/cc-socks/4321.sock)");
    expect(selfCopyText({ pid: 1, name: "ReviewGate · x", address: null })).toBe("ReviewGate · x");
    expect(selfCopyText({ pid: 1, name: null, address: null })).toBeNull();
    // An older engine: no key at all (the view stays as it was).
    expect(cliSessionsOf({ running: [], resumable: [] })).toEqual({ running: [], resumable: [] });
    expect(peerSelfOf({ name: "no pid" })).toBeNull();
  });
});

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin", copyText: async () => undefined },
  };
  const { useStore } = await import("./store");
  const { PermissionCard } = await import("./components/chat/PermissionCard");
  const { OtherSessionsView } = await import("./components/OtherSessions");
  return { useStore, PermissionCard, OtherSessionsView };
}

describe("rendered (§42.2)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("ko", "darwin");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));

  it("the card shows the session's name with where it runs, never only its socket path", () => {
    const req = send("S1", B4.address, B4);
    const init = m.useStore.getInitialState();
    Object.assign(init, {
      transcript: [{ kind: "permission", id: 1, request: req, allowed: null } as ChatItem],
      state: { ...init.state, project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null }, session: { ...init.state.session, open: true, pendingPermission: req, pendingPermissions: [req], peerTurn: null } },
    });
    const html = renderToStaticMarkup(createElement(m.PermissionCard, { request: req, decision: null }));
    expect(html).toContain("받는 세션: acme-b4");
    expect(html).toContain("터미널 · ~/acme · 입력 대기");
    expect(html).toContain(B4.address);
    expect(html).toContain("#514 끝났어");
  });

  it("the section's line: the name, and a copy button with an accessible label; nothing from an older engine", () => {
    const base = { running: [], loading: false, error: null, open: true, onToggle: () => undefined, onImport: () => undefined };
    const html = renderToStaticMarkup(createElement(m.OtherSessionsView, { ...base, self: { pid: 7, name: "ReviewGate · acme", address: "uds:/tmp/cc-socks/7.sock" } }));
    expect(html).toContain("다른 세션에 보이는 이 창 이름");
    expect(html).toContain("ReviewGate · acme");
    expect(html).toContain('aria-label="이 창 이름과 주소 복사"');
    expect(renderToStaticMarkup(createElement(m.OtherSessionsView, base))).not.toContain("Peer self");
  });
});
