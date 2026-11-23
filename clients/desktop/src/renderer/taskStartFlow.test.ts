/**
 * MARK: task-start — docs/PROTOCOL.md §63 on Windows through the store with the engine bridge mocked (the Mac's AppState
 * cases in Core TaskStartTests): `task_fetch` and its refusals in the user's words, starting here (the branch, a fresh chat
 * when the current one holds a conversation, the prompt into the composer — never sent), a refused branch, a terminal chat's
 * paste retried while its Claude Code starts, a workbench's draft that waits for its chat, and when the start screen shows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCommand, ReviewState, SessionMeta } from "@reviewgate/engine";
import { initI18n } from "./i18n";

const inserted: string[] = [];
vi.mock("./composerBridge", () => ({
  insertIntoComposer: (text: string) => {
    inserted.push(text);
    return true;
  },
  composerTextWaiting: () => false,
  joinDraft: (d: string, text: string) => (d ? `${d}\n\n${text}` : text),
  useComposerInsert: () => undefined,
  taskLeftComposer: () => undefined,
  useTaskLeftComposer: () => undefined,
}));

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string };
const asked: EngineCommand[] = [];
const fired: EngineCommand[] = [];
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
      send: (c: EngineCommand) => fired.push(c),
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
  const flow = await import("./taskStartFlow");
  const screen = await import("./startScreen");
  return { useStore, ...flow, ...screen };
}

const meta = (id: string, over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, title: "Earlier", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, costUSD: 0, lastUserText: null, ...over }) as SessionMeta;

describe("starting from a task (§63.3)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  let seq = 100;
  let newChats = 0;
  beforeAll(async () => {
    initI18n("en", "win32");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    inserted.length = 0;
    asked.length = 0;
    fired.length = 0;
    newChats = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    m.useStore.setState({ newChat: async () => ((newChats += 1), true) });
  });

  const scene = (chat: SessionMeta | null, over: Partial<ReviewState> = {}) => {
    const s = m.useStore.getState().state;
    m.useStore.setState({
      state: {
        ...s,
        seq: ++seq,
        project: { path: "C:\\work\\acme", root: "C:\\work\\acme", name: "acme", branch: "main", remoteURL: null } as ReviewState["project"],
        sessions: { list: chat ? [chat] : [], currentId: chat?.id ?? null, openTabIds: chat ? [chat.id] : [] },
        ...over,
      },
    });
  };

  it("task_fetch: the issue as the engine read it", async () => {
    respond = () => ({ ok: true, reply: { type: "task_fetched", task: { id: "42", number: 42, title: "Cart total", body: "b", url: "https://github.com/acme/widgets/issues/42", labels: ["bug", 3] } } });
    const task = await m.fetchTask("#42", bridge);
    expect(asked).toEqual([{ type: "task_fetch", ref: "#42" }]);
    expect(task).toEqual({ id: "42", number: 42, title: "Cart total", body: "b", url: "https://github.com/acme/widgets/issues/42", labels: ["bug"] });
  });

  it("task_fetch refusals say why in the user's words (the task then starts with its id and link)", async () => {
    respond = () => ({ ok: false, error: "not_found", code: "not_found" });
    await expect(m.fetchTask("#404", bridge)).rejects.toThrow("No such issue in this repository");
    respond = () => ({ ok: false, error: "task_fetch_failed:HTTP 401: Bad credentials", code: "task_fetch_failed" });
    await expect(m.fetchTask("#1", bridge)).rejects.toThrow("Could not read the issue: HTTP 401: Bad credentials");
    respond = () => ({ ok: false, error: "gh_missing", code: "gh_missing" });
    await expect(m.fetchTask("#1", bridge)).rejects.toThrow("GitHub CLI (gh) was not found");
  });

  it("here: the branch, a fresh chat for a chat that holds a conversation, the prompt into the composer — never sent", async () => {
    scene(meta("s1", { turns: 3 }));
    const why = await m.startTaskHere("feature/ACME-1-cart", "Work on task ACME-1", bridge);
    expect(why).toBeNull();
    expect(asked[0]).toEqual({ type: "create_branch", name: "feature/ACME-1-cart" });
    expect(newChats).toBe(1);
    expect(inserted).toEqual(["Work on task ACME-1"]);
    expect([...asked, ...fired].some((c) => c.type === "send")).toBe(false);
  });

  it("an empty chat is used as it is; a refused branch says why and fills nothing", async () => {
    scene(meta("s1"));
    respond = () => ({ ok: false, error: "invalid_branch_name:bad..name", code: "invalid_branch_name" });
    const refused = await m.startTaskHere("bad..name", "x", bridge);
    expect(refused).toContain("bad..name");
    expect(inserted).toEqual([]);
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    // §59: a folder tracked without git starts here — no branch.
    expect(await m.startTaskHere(null, "Work on task 9", bridge)).toBeNull();
    expect(asked.filter((c) => c.type === "create_branch")).toHaveLength(1);
    expect(newChats).toBe(0);
    expect(inserted).toEqual(["Work on task 9"]);
  });

  it("a new chat that cannot open stops the start with its reason", async () => {
    scene(meta("s1", { turns: 1 }));
    m.useStore.setState({ newChat: async () => false, lastError: null });
    expect(await m.startTaskHere(null, "x", bridge)).toBe("Could not open a new chat");
    expect(inserted).toEqual([]);
  });

  it("§63.2: a workbench's draft (task_started {draft}) goes into this window's composer, never sent", async () => {
    scene(meta("s1"));
    m.useStore.getState().handleEvent({ type: "task_started", text: "Work on task 7", mode: "default", from: "C:\\work\\acme", sent: false, draft: true });
    for (let i = 0; i < 20 && inserted.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(inserted).toEqual(["Work on task 7"]);
    expect(fired.some((c) => c.type === "send")).toBe(false);
  });
});

describe("the first prompt into a terminal chat (§63.3)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("en", "win32");
    m = await load();
  });
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const io = (o: { known?: () => boolean; terminal?: () => boolean; ready?: () => boolean }) => {
    const out = { pasted: [] as string[], inserted: [] as string[], notes: [] as string[], logs: [] as string[] };
    const port = {
      chatKnown: o.known ?? (() => true),
      isTerminal: o.terminal ?? (() => true),
      paste: (text: string) => (o.ready?.() ?? true ? (out.pasted.push(text), null) : "not yet"),
      insert: (text: string) => void out.inserted.push(text),
      notify: (text: string) => void out.notes.push(text),
      log: (line: string) => void out.logs.push(line),
    };
    return { out, port };
  };

  it("one bracketed paste once its Claude Code takes one — retried meanwhile, never the composer", () => {
    let ready = false;
    const { out, port } = io({ ready: () => ready });
    m.deliverFirstPrompt("Work on task 9", true, port);
    vi.advanceTimersByTime(m.FIRST_PROMPT_STEP_MS * 5);
    expect(out.pasted).toEqual([]);
    ready = true;
    vi.advanceTimersByTime(m.FIRST_PROMPT_STEP_MS);
    expect(out.pasted).toEqual(["Work on task 9"]);
    expect(out.inserted).toEqual([]);
    expect(out.notes[0]).toContain("press Enter there");
  });

  it("after 30 s it waits in the message box instead, and says why", () => {
    const { out, port } = io({ ready: () => false });
    m.deliverFirstPrompt("Work on task 9", true, port);
    vi.advanceTimersByTime(m.FIRST_PROMPT_STEP_MS * m.FIRST_PROMPT_TRIES);
    expect(m.FIRST_PROMPT_STEP_MS * m.FIRST_PROMPT_TRIES).toBe(30_000);
    expect(out.pasted).toEqual([]);
    expect(out.inserted).toEqual(["Work on task 9"]);
    expect(out.notes).toEqual(["The task's first prompt could not go into the terminal — it is in the message box of a chat instead"]);
    expect(out.logs[0]).toMatch(/^\[warn\] task-start:/);
  });

  it("a draft waits for its chat's kind before it goes anywhere", () => {
    let known = false;
    const { out, port } = io({ known: () => known });
    m.deliverFirstPrompt("Work on task 7", undefined, port);
    vi.advanceTimersByTime(m.FIRST_PROMPT_STEP_MS * 3);
    expect(out.pasted).toEqual([]);
    expect(out.inserted).toEqual([]);
    known = true;
    vi.advanceTimersByTime(m.FIRST_PROMPT_STEP_MS);
    expect(out.pasted).toEqual(["Work on task 7"]);
  });

  it("a chat gets it in its composer at once; a later prompt replaces one still waiting", () => {
    const first = io({ ready: () => false });
    m.deliverFirstPrompt("old", true, first.port);
    const second = io({ terminal: () => false });
    m.deliverFirstPrompt("new", false, second.port);
    vi.advanceTimersByTime(m.FIRST_PROMPT_STEP_MS * m.FIRST_PROMPT_TRIES);
    expect(second.out.inserted).toEqual(["new"]);
    expect(first.out.inserted).toEqual([]); // the old one stopped retrying
  });
});

describe("when the start screen shows (§63.4)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    m = await load();
  });

  const state = (path: string | null, gate: Partial<ReviewState["gate"]> = {}, gitInit: ReviewState["gitInit"] = null) =>
    ({
      project: path ? ({ path, root: path, name: "acme" } as ReviewState["project"]) : null,
      gitInit,
      gate: { phase: "idle", pendingCount: 0, changesRequestedCount: 0, ...gate } as ReviewState["gate"],
    }) as Pick<ReviewState, "project" | "gitInit" | "gate">;
  const scene = (s: ReturnType<typeof state>, skip = false, composerWaiting = false) => ({ state: s, settings: { skipStartScreen: skip }, composerWaiting });

  it("decides once per project the window opens", () => {
    let r = m.stepStartScreen({ checkedPath: null, suppressNext: false }, scene(state("C:\\work\\acme")), false);
    expect(r.show).toBe(true);
    // The same project again (a reconnect, the next snapshot): nothing changes.
    r = m.stepStartScreen(r.watch, scene(state("C:\\work\\acme")), false);
    expect(r.show).toBeNull();
    // A switch to another project decides again; closing it puts the screen away.
    expect(m.stepStartScreen(r.watch, scene(state("C:\\work\\other")), false).show).toBe(true);
    expect(m.stepStartScreen(r.watch, scene(state(null)), true)).toEqual({ watch: { checkedPath: null, suppressNext: false }, show: false });
  });

  it("not for the window's first project when the app opened it with work of its own, nor when turned off or busy", () => {
    const first = m.stepStartScreen({ checkedPath: null, suppressNext: true }, scene(state("C:\\work\\acme-wb")), false);
    expect(first.show).toBe(false);
    expect(m.stepStartScreen(first.watch, scene(state("C:\\work\\acme")), false).show).toBe(true); // a switch later: the user's
    expect(m.stepStartScreen({ checkedPath: null, suppressNext: false }, scene(state("C:\\work\\acme"), true), false).show).toBe(false);
    expect(m.stepStartScreen({ checkedPath: null, suppressNext: false }, scene(state("C:\\work\\acme", { phase: "reviewing", pendingCount: 2 })), false).show).toBe(false);
    expect(m.stepStartScreen({ checkedPath: null, suppressNext: false }, scene(state("C:\\work\\acme"), false, true), false).show).toBe(false);
  });

  it("a git-init prompt comes first; a turn that starts meanwhile puts it away", () => {
    const waiting = m.stepStartScreen({ checkedPath: null, suppressNext: false }, scene(state("C:\\work\\new", {}, { path: "C:\\work\\new", candidates: [], looksUnsafe: false } as never)), false);
    expect(waiting).toEqual({ watch: { checkedPath: null, suppressNext: false }, show: false });
    const shown = m.stepStartScreen({ checkedPath: null, suppressNext: false }, scene(state("C:\\work\\acme")), false);
    expect(m.stepStartScreen(shown.watch, scene(state("C:\\work\\acme", { phase: "running" })), true).show).toBe(false);
    expect(m.stepStartScreen(shown.watch, scene(state("C:\\work\\acme", { phase: "running" })), false).show).toBeNull();
  });
});
