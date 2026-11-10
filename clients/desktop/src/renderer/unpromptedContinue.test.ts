import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n } from "./i18n";

/**
 * MARK: r2-peers — docs/PROTOCOL.md §18 in the Windows client: the unprompted-turn notice offers [Continue the work] — the
 * tool-call limit banner's action (§38.2) — so what Claude went on with by itself becomes a reviewed turn with one click.
 */

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin", openLog: async () => undefined },
  };
  const { useStore } = await import("./store");
  const { ErrorBanner } = await import("./components/ErrorBanner");
  return { useStore, ErrorBanner };
}

describe("the unprompted notice (§18)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("en", "darwin");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));

  const banner = (code: string) => {
    const init = m.useStore.getInitialState();
    Object.assign(init, {
      errorBanner: { message: "Claude tried to work without a request; it was blocked and nothing was modified.", scope: "session", fatal: false, code },
      state: { ...init.state, project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null }, session: { ...init.state.session, open: true } },
    });
    return renderToStaticMarkup(createElement(m.ErrorBanner));
  };

  it("offers [Continue the work], as the tool-call limit does; other notices do not", () => {
    expect(banner("unprompted_blocked")).toContain('data-testid="Continue from banner"');
    expect(banner("max_turns")).toContain('data-testid="Continue from banner"');
    expect(banner("worktree_blocked")).not.toContain('data-testid="Continue from banner"');
  });
});
