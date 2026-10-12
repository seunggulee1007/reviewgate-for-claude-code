import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectRootHash } from "../shared/hash";
import { initI18n } from "./i18n";
import { EMPTY_QUEUE, enqueue, type QueueState } from "./sendQueue";
import { keepQueueAcrossReloads, loadDraft, loadQueue, restoredQueue, saveDraft, saveQueue, type KeepStorage } from "./sessionKeep";

/** A Map-backed sessionStorage; `quota` makes writes longer than it throw like a full storage. */
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

describe("polish-03: the draft and the queue survive a renderer reload", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("keeps the queue per project (ids are not kept; an empty queue removes it)", () => {
    const s = memoryStorage();
    const items = enqueue(enqueue([], "first", false, { mentions: ["a.ts"] }), "second", false, { attachments: [img] });
    saveQueue(s, "abcd1234", items);
    expect(loadQueue(s, "abcd1234")).toEqual([{ text: "first", mentions: ["a.ts"] }, { text: "second", attachments: [img] }]);
    expect(loadQueue(s, "other000")).toEqual([]);
    saveQueue(s, "abcd1234", []);
    expect(s.data.size).toBe(0);
  });

  it("too big for the storage: the image messages stay out; garbage reads as nothing", () => {
    const s = memoryStorage(200);
    saveQueue(s, "h", enqueue(enqueue([], "text only"), "with image", false, { attachments: [img] }));
    expect(loadQueue(s, "h")).toEqual([{ text: "text only" }]);
    s.data.set("rg.queue.h", "{not json");
    expect(loadQueue(s, "h")).toEqual([]);
    s.data.set("rg.queue.h", JSON.stringify([{ text: "" }, { nope: 1 }, { text: "ok", mentions: [1, "b"] }]));
    expect(loadQueue(s, "h")).toEqual([{ text: "ok", mentions: ["b"] }]);
  });

  it("a restored queue is paused until the user resumes", () => {
    const back = restoredQueue([{ text: "a" }, { text: "b", mentions: ["x"] }])!;
    expect(back.items.map((m) => m.text)).toEqual(["a", "b"]);
    expect(back.items[1]!.mentions).toEqual(["x"]);
    expect(back.paused).toBe("새로고침 뒤 복원했어요 — 재개하면 보내요");
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
    expect(after.getState().queue.paused).toContain("새로고침");
    // Switching projects clears the queue — and the kept copy.
    after.set({ queue: EMPTY_QUEUE });
    expect(loadQueue(storage, projectRootHash("/repo"))).toEqual([]);
  });
});
