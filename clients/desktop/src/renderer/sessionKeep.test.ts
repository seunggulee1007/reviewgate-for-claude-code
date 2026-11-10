import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectRootHash } from "../shared/hash";
import { initI18n, t } from "./i18n";
import { EMPTY_QUEUE, enqueue, type QueueState } from "./sendQueue";
import { keepQueueAcrossReloads, keepQueueWhileLeaving, loadDraft, loadQueue, MAX_KEPT_DRAFTS, restoredQueue, saveDraft, saveQueue, type KeepStorage } from "./sessionKeep";

/** A Map-backed localStorage; `quota` makes writes longer than it throw like a full storage. */
function memoryStorage(quota = Infinity): KeepStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (v.length > quota) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
    removeItem: (k) => void data.delete(k),
  };
}

const img = { kind: "image" as const, mediaType: "image/png" as const, dataBase64: "A".repeat(400) };

describe("polish-03 / P4-composer-07: the draft and the queue survive a reload, the window's close and quitting", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("keeps the queue per project (ids and images are not kept; an empty queue removes it)", () => {
    const s = memoryStorage();
    const items = enqueue(enqueue([], "first", false, { mentions: ["a.ts"] }), "second", false, { attachments: [img] });
    saveQueue(s, "abcd1234", items);
    expect(loadQueue(s, "abcd1234")).toEqual([{ text: "first", mentions: ["a.ts"] }, { text: "second" }]);
    expect(loadQueue(s, "other000")).toEqual([]);
    saveQueue(s, "abcd1234", []);
    expect(s.data.size).toBe(0);
  });

  it("a full storage keeps what it had; garbage reads as nothing", () => {
    const s = memoryStorage(60);
    saveQueue(s, "h", enqueue([], "short"));
    saveQueue(s, "h", enqueue(enqueue([], "short"), "x".repeat(80)));
    expect(loadQueue(s, "h")).toEqual([{ text: "short" }]);
    s.data.set("rg.queue.h", "{not json");
    expect(loadQueue(s, "h")).toEqual([]);
    s.data.set("rg.queue.h", JSON.stringify([{ text: "" }, { nope: 1 }, { text: "ok", mentions: [1, "b"] }]));
    expect(loadQueue(s, "h")).toEqual([{ text: "ok", mentions: ["b"] }]);
  });

  it("a restored queue is paused until the user resumes", () => {
    const back = restoredQueue([{ text: "a" }, { text: "b", mentions: ["x"] }])!;
    expect(back.items.map((m) => m.text)).toEqual(["a", "b"]);
    expect(back.items[1]!.mentions).toEqual(["x"]);
    expect(back.paused).toBe(t("Kept from before — Resume to send"));
    expect(restoredQueue([])).toBeNull();
  });

  it("keeps the draft per project", () => {
    const s = memoryStorage();
    saveDraft(s, "h1", "half a thought");
    expect(loadDraft(s, "h1")).toBe("half a thought");
    expect(loadDraft(s, "h2")).toBe("");
    saveDraft(s, "h1", "");
    expect(loadDraft(s, "h1")).toBe("");
    saveDraft(null, "h1", "x");
    expect(loadDraft(null, "h1")).toBe("");
  });

  it("keeps at most MAX_KEPT_DRAFTS drafts — the least recently typed go first", () => {
    const s = memoryStorage();
    for (let i = 0; i <= MAX_KEPT_DRAFTS; i++) saveDraft(s, `h${i}`, `draft ${i}`);
    expect(loadDraft(s, "h0")).toBe("");
    expect(loadDraft(s, "h1")).toBe("draft 1");
    saveDraft(s, "h1", "typed again"); // h1 is now the most recent: h2 goes next
    saveDraft(s, "hNew", "another");
    expect(loadDraft(s, "h1")).toBe("typed again");
    expect(loadDraft(s, "h2")).toBe("");
    expect([...s.data.keys()].filter((k) => k.startsWith("rg.draft.")).length).toBe(MAX_KEPT_DRAFTS);
  });

  it("the store keeper: saves as the queue changes, restores when the project appears after a reload", () => {
    const storage = memoryStorage();
    type S = { state: { project: { root: string } | null }; queue: QueueState };
    const make = (initial: S) => {
      let state = initial;
      const listeners: ((s: S, p: S) => void)[] = [];
      const store = {
        getState: () => state,
        setState: (f: (s: S) => { queue: QueueState }) => {
          const prev = state;
          state = { ...state, ...f(state) };
          listeners.forEach((l) => l(state, prev));
        },
        set: (patch: Partial<S>) => {
          const prev = state;
          state = { ...state, ...patch };
          listeners.forEach((l) => l(state, prev));
        },
        subscribe: (l: (s: S, p: S) => void) => {
          listeners.push(l);
          return () => undefined;
        },
      };
      keepQueueAcrossReloads(store, storage);
      return store;
    };
    // Before the reload: a project with two queued messages.
    const before = make({ state: { project: { root: "/repo" } }, queue: EMPTY_QUEUE });
    before.set({ queue: { ...EMPTY_QUEUE, items: enqueue(enqueue([], "one"), "two") } });
    expect(loadQueue(storage, projectRootHash("/repo")).map((m) => m.text)).toEqual(["one", "two"]);
    // After the reload: an empty store; the engine's snapshot brings the project back.
    const after = make({ state: { project: null }, queue: EMPTY_QUEUE });
    after.set({ state: { project: { root: "/repo" } } });
    expect(after.getState().queue.items.map((m) => m.text)).toEqual(["one", "two"]);
    expect(after.getState().queue.paused).toBe(t("Kept from before — Resume to send"));
    // Leaving the project (switch, close): the view empties, the kept copy stays for its next open.
    keepQueueWhileLeaving("/repo");
    after.set({ queue: EMPTY_QUEUE });
    expect(loadQueue(storage, projectRootHash("/repo")).map((m) => m.text)).toEqual(["one", "two"]);
    after.set({ state: { project: { root: "/other" } } });
    expect(after.getState().queue.items).toEqual([]);
    after.set({ state: { project: { root: "/repo" } } });
    expect(after.getState().queue.items.map((m) => m.text)).toEqual(["one", "two"]);
    // Emptied by the user (sent, cleared): forgotten.
    after.set({ queue: EMPTY_QUEUE });
    expect(loadQueue(storage, projectRootHash("/repo"))).toEqual([]);
  });

  it("a switch that did not happen keeps nothing the user sends afterwards", () => {
    const storage = memoryStorage();
    type S = { state: { project: { root: string } | null }; queue: QueueState };
    let state: S = { state: { project: { root: "/repo" } }, queue: EMPTY_QUEUE };
    const listeners: ((s: S, p: S) => void)[] = [];
    const set = (patch: Partial<S>) => {
      const prev = state;
      state = { ...state, ...patch };
      listeners.forEach((l) => l(state, prev));
    };
    keepQueueAcrossReloads(
      { getState: () => state, setState: (f) => set(f(state)), subscribe: (l) => (listeners.push(l), () => undefined) },
      storage,
    );
    set({ queue: { ...EMPTY_QUEUE, items: enqueue([], "kept") } });
    keepQueueWhileLeaving("/repo");
    set({ queue: EMPTY_QUEUE }); // the view empties; the open is then refused and the window stays on /repo
    set({ queue: { ...EMPTY_QUEUE, items: enqueue([], "new one") } });
    set({ queue: EMPTY_QUEUE }); // sent
    expect(loadQueue(storage, projectRootHash("/repo"))).toEqual([]);
  });
});
