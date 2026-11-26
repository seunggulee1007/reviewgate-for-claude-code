/**
 * docs/PROTOCOL.md §69 on Windows (the Mac's Core NewProjectTests): the no-project window's keys, the folder name preview, the
 * create through the store (a refusal in the user's words, nothing opened), the preselected base project of a task, and the
 * start screen a task named before its project opened brings up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCommand, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

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
  const np = await import("./newProject");
  const screen = await import("./startScreen");
  return { useStore, ...np, ...screen };
}

describe("starting without a folder (§69)", () => {
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

  it("the keys: 1 / 2 / 3 act at once, the arrows move the mark and stop at either end, Enter takes it", () => {
    expect(m.noProjectKey("2", 1)).toEqual({ handled: true, mark: 2, act: 2 });
    expect(m.noProjectKey("ArrowRight", 1)).toEqual({ handled: true, mark: 2, act: null });
    expect(m.noProjectKey("ArrowDown", 3)).toEqual({ handled: true, mark: 3, act: null });
    expect(m.noProjectKey("ArrowLeft", 1)).toEqual({ handled: true, mark: 1, act: null });
    expect(m.noProjectKey("Enter", 3)).toEqual({ handled: true, mark: 3, act: 3 });
    expect(m.noProjectKey("a", 1).handled).toBe(false);
  });

  it("project_name: the parent only when set; the preview as the engine gives it", async () => {
    respond = () => ({ ok: true, reply: { type: "project_name", name: "build-a-todo-app", parent: "C:\\Users\\dev\\ReviewGate", path: "C:\\Users\\dev\\ReviewGate\\build-a-todo-app-2" } });
    expect(await m.previewProjectName("Build a todo app", "  ", bridge)).toMatchObject({ path: "C:\\Users\\dev\\ReviewGate\\build-a-todo-app-2" });
    await m.previewProjectName("x", "D:\\work", bridge);
    expect(asked).toEqual([{ type: "project_name", text: "Build a todo app" }, { type: "project_name", text: "x", parent: "D:\\work" }]);
    respond = () => ({ ok: false, error: "bad_parent:code", code: "bad_parent" });
    expect(await m.previewProjectName("x", "code", bridge)).toBeNull();
  });

  it("project_create through the store: the path once open; a refusal in the user's words", async () => {
    respond = () => ({ ok: true, reply: { type: "project_created", path: "C:\\Users\\dev\\ReviewGate\\todo" } });
    expect(await m.useStore.getState().createProject("todo", undefined, "C:\\Users\\dev\\ReviewGate\\todo")).toEqual({ path: "C:\\Users\\dev\\ReviewGate\\todo" });
    expect(asked[0]).toEqual({ type: "project_create", name: "todo" });
    respond = () => ({ ok: false, error: "parent_not_writable:EACCES: permission denied", code: "parent_not_writable" });
    expect(await m.useStore.getState().createProject("todo", "D:\\ro", "D:\\ro\\todo")).toEqual({ error: "Could not make the project folder: EACCES: permission denied" });
    respond = () => ({ ok: false, error: "bad_parent:code", code: "bad_parent" });
    expect(await m.useStore.getState().createProject("todo", "code", "code\\todo")).toEqual({ error: "The folder for new projects must be a full path — change it in Settings › General" });
    respond = () => ({ ok: false, error: "git_init_failed:git: not found", code: "git_init_failed" });
    expect(await m.useStore.getState().createProject("todo", undefined, "x")).toEqual({ error: "The git repository could not be initialized: git: not found" });
    expect(m.useStore.getState().openingPath).toBeNull();
  });

  it("project_match and the preselected project: the guess, else the most recent", async () => {
    respond = () => ({ ok: true, reply: { type: "project_matches", repo: "acme/widgets", matches: ["C:\\work\\widgets"], guess: "C:\\work\\widgets" } });
    const r = await m.matchProjects("https://github.com/acme/widgets/issues/42", ["C:\\work\\a", "C:\\work\\widgets"], bridge);
    expect(r).toEqual({ repo: "acme/widgets", matches: ["C:\\work\\widgets"], guess: "C:\\work\\widgets" });
    expect(m.preselectProject(r.guess, ["C:\\work\\a", "C:\\work\\widgets"])).toBe("C:\\work\\widgets");
    expect(m.preselectProject("C:\\elsewhere", ["C:\\work\\a"])).toBe("C:\\work\\a");
    expect(m.preselectProject(null, [])).toBeNull();
    respond = () => ({ ok: false, error: "unknown_command", code: "unknown_command" });
    expect(await m.matchProjects("ACME-1", [], bridge)).toEqual({ repo: null, matches: [], guess: null });
  });

  it("a task named before its project opened shows the start screen, even with start-straight-away on", () => {
    const state = { project: { path: "C:\\work\\acme", root: "C:\\work\\acme", name: "acme" }, gitInit: null, gate: { phase: "idle", pendingCount: 0, changesRequestedCount: 0 } } as unknown as Pick<ReviewState, "project" | "gitInit" | "gate">;
    const r = m.stepStartScreen({ checkedPath: null, suppressNext: true }, { state, settings: { skipStartScreen: true }, composerWaiting: false, pendingTask: true }, false);
    expect(r).toEqual({ watch: { checkedPath: "C:\\work\\acme", suppressNext: false }, show: true });
    expect(m.samePathLoose("C:\\Work\\Acme\\", "c:/work/acme")).toBe(true);
    expect(m.samePathLoose("C:\\work\\acme", "C:\\work\\acme-2")).toBe(false);
  });
});
