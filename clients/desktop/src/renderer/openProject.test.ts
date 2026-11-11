/**
 * Opening a project never ends in silence (docs/PROTOCOL.md §55.8, the Mac's fix/open-project): the folder already open says
 * so, an open on its way says "Opening acme-api…", and the engine's `project_open_failed` (its git did not answer within 20 s)
 * has Reopen. Through the store with the engine bridge mocked; English, so the words do not wait for ko.json.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineCommand, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

const sent: EngineCommand[] = [];
let answer: (cmd: EngineCommand) => Promise<unknown> = async () => ({ ok: true, reply: { type: "result", ok: true } });

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true, addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => void sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return answer(c);
      },
      focusProjectWindow: async () => false,
      confirmProjectChange: async () => ({ asked: false, ok: true }),
      notify: async () => true,
      onEvent: () => () => undefined,
      openLog: async () => undefined,
      platform: "darwin",
      sep: "/",
    },
  };
  const { useStore } = await import("./store");
  const { useToast } = await import("./toast");
  const { ErrorBanner } = await import("./components/ErrorBanner");
  return { useStore, useToast, ErrorBanner };
}
type Loaded = Awaited<ReturnType<typeof load>>;
let L: Loaded;

const project = { root: "/work/acme-api", path: "/work/acme-api", name: "acme-api", branch: "main" };

describe("opening a project never ends in silence", () => {
  beforeAll(async () => {
    initI18n("en", "darwin");
    L = await load();
  });
  beforeEach(() => {
    sent.length = 0;
    answer = async () => ({ ok: true, reply: { type: "result", ok: true } });
    L.useToast.getState().hide();
  });

  it("choosing the folder already open says so — no switch, no engine command", async () => {
    L.useStore.setState({ state: { ...L.useStore.getState().state, project } as unknown as ReviewState });
    L.useStore.getState().requestSwitch("/work/acme-api/");
    await new Promise((r) => setTimeout(r, 0));
    expect(L.useToast.getState().text).toBe("acme-api is already open in this window");
    expect(sent.filter((c) => c.type === "switch_project" || c.type === "open_project")).toEqual([]);
  });

  it("an open on its way names its folder until the engine answers", async () => {
    let release: () => void = () => undefined;
    answer = () => new Promise((r) => (release = () => r({ ok: true, reply: { type: "result", ok: true } })));
    const open = L.useStore.getState().openProject("/work/acme-web");
    await new Promise((r) => setTimeout(r, 0));
    expect(L.useStore.getState().openingPath).toBe("/work/acme-web");
    release();
    await open;
    expect(L.useStore.getState().openingPath).toBeNull();
  });

  it("project_open_failed has Reopen, which opens that folder again", async () => {
    await L.useStore.getState().openProject("/work/acme-web");
    L.useStore.getState().handleEvent({
      type: "error", message: "git rev-parse did not respond within 20 s", fatal: true, scope: "git", code: "project_open_failed",
    } as never);
    const { errorBanner, lastOpenPath } = L.useStore.getState();
    expect(errorBanner?.code).toBe("project_open_failed");
    // A static render reads the store's initial state: the banner as the store has it now.
    Object.assign(L.useStore.getInitialState(), { errorBanner, lastOpenPath });
    const html = renderToStaticMarkup(createElement(L.ErrorBanner));
    expect(html).toContain("Reopen project");
    sent.length = 0;
    await L.useStore.getState().reopenLastProject();
    expect(sent.find((c) => c.type === "open_project")).toMatchObject({ type: "open_project", path: "/work/acme-web" });
  });
});
