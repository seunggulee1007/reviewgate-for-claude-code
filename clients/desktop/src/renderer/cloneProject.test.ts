/**
 * docs/PROTOCOL.md §74 on Windows (the Mac's Core CloneProjectTests): the preview request, each refusal in the user's words,
 * the clone through the store (opened, cancelled, refused — nothing opened), its progress store and the task's clone link.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCommand } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { EngineRefusal } from "./engineRequest";

vi.mock("./composerBridge", () => ({
  insertIntoComposer: () => true,
  composerTextWaiting: () => false,
  joinDraft: (d: string, text: string) => (d ? `${d}\n\n${text}` : text),
  useComposerInsert: () => undefined,
  taskLeftComposer: () => undefined,
  useTaskLeftComposer: () => undefined,
}));

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string };
const asked: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });
const bridge = {
  request: async () => ({}),
  requestDetailed: async (c: EngineCommand) => {
    asked.push(c);
    return respond(c);
  },
} as never;

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true, addEventListener: () => undefined, removeEventListener: () => undefined, activeElement: null };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rgInitialProject: null,
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        asked.push(c);
        return respond(c);
      },
      notify: async () => true,
      onEvent: () => () => undefined,
      setUI: async () => undefined,
      platform: "win32",
      sep: "\\",
    },
  };
  const { useStore } = await import("./store");
  const clone = await import("./cloneProject");
  return { useStore, ...clone };
}

const refused = (code: string, error = code) => new EngineRefusal(error, code);

describe("clone from git (§74)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("en", "win32");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    asked.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  it("project_clone_preview: the name and the parent only when set; the reply as the engine gives it", async () => {
    const reply = { type: "project_clone_preview", url: "https://github.com/acme/widgets.git", repo: "acme/widgets", host: "github.com", branch: null, name: "widgets", parent: "C:\\Users\\dev\\ReviewGate", path: "C:\\Users\\dev\\ReviewGate\\widgets", matches: ["D:\\work\\widgets"] };
    respond = () => ({ ok: true, reply });
    expect(await m.previewClone("acme/widgets", null, "  ", ["D:\\work\\widgets"], bridge)).toEqual(reply);
    await m.previewClone("acme/widgets", "copy", "D:\\work", [], bridge);
    expect(asked).toEqual([
      { type: "project_clone_preview", url: "acme/widgets", paths: ["D:\\work\\widgets"] },
      { type: "project_clone_preview", url: "acme/widgets", name: "copy", parent: "D:\\work", paths: [] },
    ]);
    respond = () => ({ ok: false, error: "url_has_credentials", code: "url_has_credentials" });
    expect(await m.previewClone("https://a:b@github.com/acme/w.git", null, undefined, [], bridge)).toEqual({ unavailable: "Take the password or token out of the link — git signs in with your saved sign-in" });
    respond = () => ({ ok: false, error: "unknown command: project_clone_preview", code: "unknown_command" });
    expect(await m.previewClone("acme/widgets", null, undefined, [], bridge)).toEqual({ unavailable: "This engine cannot clone yet — update ReviewGate" });
  });

  it("each refusal in the user's words", () => {
    expect(m.cloneRefusal(refused("clone_auth_failed", "clone_auth_failed:Authentication failed"))).toContain("gh auth login");
    expect(m.cloneRefusal(refused("clone_not_found"))).toBe("Repository not found — check the link, and that your account can see it");
    expect(m.cloneRefusal(refused("clone_network"))).toBe("Could not reach the server — check the network or VPN, then try again");
    expect(m.cloneRefusal(refused("clone_folder_exists"))).toBe("That folder already exists — choose another folder name");
    expect(m.cloneRefusal(refused("git_missing"))).toBe("git was not found — install Git for Windows, then try again");
    expect(m.cloneRefusal(refused("clone_timeout"))).toContain("2 minutes");
    expect(m.cloneRefusal(refused("clone_branch_not_found"))).toContain("branch");
    expect(m.cloneRefusal(refused("bad_url", "bad_url:spaces"))).toContain("owner/repo");
    expect(m.cloneRefusal(refused("clone_failed", "clone_failed:odd"))).toBe("git clone failed: odd");
    expect(m.clonePhaseLabel("receiving")).toBe("Receiving objects…");
  });

  it("the clone through the store: opened, cancelled, refused — the progress store cleared after each", async () => {
    respond = () => ({ ok: true, reply: { type: "project_cloned", path: "C:\\Users\\dev\\ReviewGate\\widgets" } });
    expect(await m.useStore.getState().cloneProject({ url: "acme/widgets", parent: undefined, expected: "C:\\Users\\dev\\ReviewGate\\widgets" })).toEqual({ path: "C:\\Users\\dev\\ReviewGate\\widgets" });
    expect(asked[0]).toEqual({ type: "project_clone", url: "acme/widgets" });
    await m.useStore.getState().cloneProject({ url: "acme/widgets", name: "w2", branch: "dev", parent: "D:\\work", expected: "D:\\work\\w2" });
    expect(asked[1]).toEqual({ type: "project_clone", url: "acme/widgets", name: "w2", branch: "dev", parent: "D:\\work" });
    respond = () => ({ ok: false, error: "clone_cancelled", code: "clone_cancelled" });
    expect(await m.useStore.getState().cloneProject({ url: "acme/widgets", parent: undefined, expected: "x" })).toEqual({ cancelled: true });
    respond = () => ({ ok: false, error: "clone_not_found:Repository not found.", code: "clone_not_found" });
    expect(await m.useStore.getState().cloneProject({ url: "acme/nope", parent: undefined, expected: "x" })).toEqual({ error: "Repository not found — check the link, and that your account can see it" });
    expect(m.useStore.getState().openingPath).toBeNull();
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    await m.useStore.getState().cancelClone();
    expect(asked[asked.length - 1]).toEqual({ type: "project_clone_cancel" });
  });

  it("project_clone_progress goes to the clone's own store", () => {
    expect(m.applyCloneEvent({ type: "project_clone_progress", path: "C:\\w", phase: "resolving", percent: 90, phasePercent: 50, detail: null })).toBe(true);
    expect(m.useCloneProgress.getState().progress).toMatchObject({ phase: "resolving", percent: 90 });
    expect(m.applyCloneEvent({ type: "result", ok: true } as never)).toBe(false);
  });

  it("the task's clone link: on the issue link's host, else the shorthand", () => {
    expect(m.cloneURLForTask("https://ghe.example.com/team/app/issues/9", "team/app")).toBe("https://ghe.example.com/team/app.git");
    expect(m.cloneURLForTask("fix https://github.com/acme/widgets/issues/42 today", "acme/widgets")).toBe("https://github.com/acme/widgets.git");
    expect(m.cloneURLForTask("acme/widgets#7", "acme/widgets")).toBe("acme/widgets");
  });
});
