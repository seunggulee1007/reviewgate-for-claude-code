/**
 * MARK: wave4d w4d-speed — audit polish-09: a 500-row chat receiving 100 streaming deltas. Through the real store, the list's
 * shape stays one array for every delta (so the list, its index and its agent groups are not drawn again), the streaming row
 * reads every new chunk, and a structural event (a tool call) is a new shape at once. The old per-delta work (every row of
 * the chat rendered again) is timed against the new one (the streaming row) and printed for the record.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineEvent } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import type { ChatItem } from "./store";
import { liveAssistant, sameShape, transcriptShape, type AssistantItem } from "./transcriptShape";

// DOMPurify needs a DOM: markdown is shown as its source text here (the sanitizer has its own tests).
vi.mock("./components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => createElement("div", { className: "markdown" }, text) }));

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }),
      setSettings: async (patch: Record<string, unknown>) => patch,
      getSettings: async () => ({}),
      setUI: async () => undefined,
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
      sep: "/",
    },
  };
  return (await import("./store")).useStore;
}
type UseStore = Awaited<ReturnType<typeof loadStore>>;

const user = (id: number): ChatItem => ({ kind: "user", id, text: `u${id}` });
const answer = (id: number, text: string, streaming: boolean): AssistantItem => ({ kind: "assistant", id, text, streaming });

describe("transcript shape (wave4d w4d-speed, polish-09)", () => {
  it("is the same while only the last assistant row changes", () => {
    const a = user(1);
    const prev: ChatItem[] = [a, answer(2, "Hel", true)];
    expect(sameShape(prev, prev)).toBe(true);
    expect(sameShape(prev, [a, answer(2, "Hello", true)])).toBe(true);
    expect(sameShape(prev, [a, answer(2, "Hello", false)])).toBe(true); // streaming ended in place (a fatal error)
    expect(sameShape(prev, [a, answer(3, "Hel", true)])).toBe(false); // another message
    expect(sameShape(prev, [user(1), answer(2, "Hel", true)])).toBe(false); // an earlier row was replaced
    expect(sameShape(prev, [a, answer(2, "Hel", false), user(4)])).toBe(false); // a row was added
    expect(sameShape([a, user(2)], [a, user(2)])).toBe(false); // the last row is not an answer
    expect(sameShape([], [])).toBe(true);
    expect(sameShape([a], [])).toBe(false);
  });

  it("the shape keeps the first array of a run; the live row reads the newest text", () => {
    const a = user(10);
    const first: ChatItem[] = [a, answer(11, "a", true)];
    const shape = transcriptShape(first);
    expect(shape).toBe(first);
    const later: ChatItem[] = [a, answer(11, "abc", true)];
    expect(transcriptShape(later)).toBe(first);
    expect(transcriptShape(later)).toBe(first); // the same state, the same answer (a selector's contract)
    expect(liveAssistant(later, first[1] as AssistantItem).text).toBe("abc");
    // A finished row is its own live version (another chat shown read-only never reads the live one).
    const done = answer(11, "abc", false);
    expect(liveAssistant(later, done)).toBe(done);
    const next: ChatItem[] = [a, done, user(12)];
    expect(transcriptShape(next)).toBe(next);
  });

  describe("through the store", () => {
    let useStore: UseStore;
    // The store's first import is the slow part on a loaded machine: once, with room.
    beforeAll(async () => {
      initI18n("ko", "darwin");
      useStore = await loadStore();
    }, 60_000);
    afterAll(() => initI18n("en", "darwin"));
    beforeEach(() => {
      useStore.setState({ transcript: [] });
    });

    /** 100 rounds of read → result → text → edit → result: 500 rows, the agent-free shape of a long acme session. */
    const longChat = () => {
      const events: EngineEvent[] = [];
      for (let i = 0; i < 100; i++) {
        events.push({ type: "tool_use", id: `read-${i}`, name: "Read", file: `api/src/main/java/A${i}.java`, input: { file_path: `api/src/main/java/A${i}.java` } } as EngineEvent);
        events.push({ type: "tool_result", toolUseId: `read-${i}`, isError: false, preview: `class A${i} {}` } as EngineEvent);
        events.push({ type: "text_delta", text: `A${i} 를 고칠게요.` } as EngineEvent);
        events.push({ type: "tool_use", id: `edit-${i}`, name: "Edit", file: `api/src/main/java/A${i}.java`, input: { file_path: `api/src/main/java/A${i}.java`, old_string: "a", new_string: "b" } } as EngineEvent);
        events.push({ type: "tool_result", toolUseId: `edit-${i}`, isError: false, preview: "ok" } as EngineEvent);
      }
      for (const ev of events) useStore.getState().handleEvent(ev);
      expect(useStore.getState().transcript).toHaveLength(500);
    };

    it("100 deltas on a 500-row chat: one shape, the streaming row sees every chunk, a tool call is a new shape", () => {
      longChat();
      useStore.getState().handleEvent({ type: "text_delta", text: "정리하면" } as EngineEvent);
      const shapes = new Set<ChatItem[]>();
      const texts: string[] = [];
      const start = transcriptShape(useStore.getState().transcript);
      const streaming = start[start.length - 1] as AssistantItem;
      const unsub = useStore.subscribe((s) => {
        shapes.add(transcriptShape(s.transcript));
        texts.push(liveAssistant(s.transcript, streaming).text);
      });
      for (let i = 0; i < 100; i++) useStore.getState().handleEvent({ type: "text_delta", text: ` ${i}` } as EngineEvent);
      expect(useStore.getState().transcript).toHaveLength(501);
      expect([...shapes]).toEqual([start]); // the list (and everything built from its rows) is drawn 0 times again
      expect(texts).toHaveLength(100); // the streaming row: 100 times, each with its chunk
      expect(texts[99]!.endsWith(" 98 99")).toBe(true);
      useStore.getState().handleEvent({ type: "tool_use", id: "after", name: "Bash", input: { command: "ls" } } as EngineEvent);
      unsub();
      const after = transcriptShape(useStore.getState().transcript);
      expect(after).not.toBe(start);
      expect(after).toHaveLength(502);
      // Every row object but the finished answer is the one the list drew: a memoized row is not drawn again.
      expect(after.slice(0, 500).every((item, i) => item === start[i])).toBe(true);
      expect(after[500]).toMatchObject({ kind: "assistant", streaming: false });
    }, 30_000);

    it("prints the per-delta cost before (every row rendered again) and now (the streaming row)", async () => {
      longChat();
      useStore.getState().handleEvent({ type: "text_delta", text: "정리하면" } as EngineEvent);
      const { Transcript, AssistantMessage } = await import("./components/chat/Transcript");
      const renderAll = () => {
        Object.assign(useStore.getInitialState(), useStore.getState());
        return renderToStaticMarkup(createElement(Transcript));
      };
      expect(renderAll()).toContain("정리하면");
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) {
        useStore.getState().handleEvent({ type: "text_delta", text: ` b${i}` } as EngineEvent);
        renderAll();
      }
      const before = (performance.now() - t0) / 20;
      const t1 = performance.now();
      for (let i = 0; i < 100; i++) {
        useStore.getState().handleEvent({ type: "text_delta", text: ` a${i}` } as EngineEvent);
        const s = useStore.getState();
        transcriptShape(s.transcript);
        Object.assign(useStore.getInitialState(), s);
        renderToStaticMarkup(createElement(AssistantMessage, { item: s.transcript[s.transcript.length - 1] as AssistantItem }));
      }
      const now = (performance.now() - t1) / 100;
      console.log(`wave4d w4d-speed: a delta on a 500-row chat — before ${before.toFixed(2)} ms (every row), now ${now.toFixed(3)} ms (the streaming row)`);
      expect(now).toBeLessThan(before);
    }, 60_000);
  });
});
