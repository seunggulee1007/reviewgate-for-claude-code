import { beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand } from "@reviewgate/engine";

// docs/PROTOCOL.md §56.1 on Windows: `/btw <question>` is the app's command — asked on the side (`btw_ask`), the answer
// over the composer, `/btw` alone shows it again in the same chat; the palette always lists it. Mac: BtwTests.swift.

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string };
const sent: EngineCommand[] = [];
let answer: (c: EngineCommand) => Reply | Promise<Reply> = () => ({ ok: true, reply: { type: "btw_answer", question: "why?", answer: "Because.", via: "session" } });

async function load() {
  (globalThis as unknown as { window: unknown }).window = {
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand): Promise<Reply> => {
        sent.push(c);
        return answer(c);
      },
      onEvent: () => () => undefined,
      platform: "win32",
    },
  };
  return import("./btw");
}

beforeEach(async () => {
  sent.length = 0;
  (await load()).useBtw.setState({ overlay: null, last: null, asking: null, failure: null });
});

describe("§56.1 /btw", () => {
  it("is /btw followed by a space or nothing, any case; anything else is a message", async () => {
    const { btwQuestion } = await load();
    expect(btwQuestion("/btw what does sum() return?")).toBe("what does sum() return?");
    expect(btwQuestion("  /BTW   why?\n")).toBe("why?");
    expect(btwQuestion("/btw")).toBe("");
    expect(btwQuestion("/btw\nmulti\nline")).toBe("multi\nline");
    expect(btwQuestion("/btwx no")).toBeNull();
    expect(btwQuestion("by the way /btw")).toBeNull();
  });

  it("asks btw_ask; the answer opens over the box and comes back with /btw alone in the same chat only", async () => {
    const { useBtw } = await load();
    await useBtw.getState().ask("  why?  ", "chat-1");
    expect(sent).toEqual([{ type: "btw_ask", question: "why?" }]);
    expect(useBtw.getState().overlay).toEqual({ kind: "answered", answer: { question: "why?", answer: "Because.", viaFork: false, synthetic: false } });
    useBtw.getState().dismiss();
    expect(useBtw.getState().overlay).toBeNull();
    expect(useBtw.getState().showLast("chat-2")).toBe(false);
    expect(useBtw.getState().showLast("chat-1")).toBe(true);
    expect(useBtw.getState().overlay?.kind).toBe("answered");
  });

  it("a fork's answer says so; a refusal closes it and gives the question back with why", async () => {
    const { useBtw } = await load();
    answer = () => ({ ok: true, reply: { type: "btw_answer", question: "q", answer: "a", via: "fork" } });
    await useBtw.getState().ask("q", null);
    expect(useBtw.getState().overlay).toMatchObject({ kind: "answered", answer: { viaFork: true } });
    answer = () => ({ ok: false, error: "btw_failed:boom", code: "btw_failed" });
    await useBtw.getState().ask("why?", null);
    expect(useBtw.getState().overlay).toBeNull();
    expect(useBtw.getState().failure).toMatchObject({ question: "why?", text: "Claude could not answer the side question: boom" });
  });

  it("Cancel while it waits drops the answer when it comes", async () => {
    const { useBtw } = await load();
    let release: (r: Reply) => void = () => {};
    answer = () => new Promise<Reply>((r) => (release = r));
    const asking = useBtw.getState().ask("slow", null);
    expect(useBtw.getState().overlay).toEqual({ kind: "asking", question: "slow" });
    useBtw.getState().dismiss();
    release({ ok: true, reply: { type: "btw_answer", question: "slow", answer: "late", via: "session" } });
    await asking;
    expect(useBtw.getState().overlay).toBeNull();
    expect(useBtw.getState().showLast(null)).toBe(false);
  });

  it("the palette always lists /btw as a built-in with its hint, and gives a listed one the app's words", async () => {
    await load();
    const { slashEntries } = await import("./slashCommands");
    const caps = { slashCommands: ["compact"], skills: [], plugins: [], mcpServers: [] };
    const btw = slashEntries(caps as never).find((e) => e.name === "btw");
    expect(btw).toMatchObject({ description: "Ask a quick side question — Claude keeps working; the answer stays out of the chat", argumentHint: "<question>", group: { kind: "builtin" } });
    expect(slashEntries({ ...caps, slashCommands: ["btw", "compact"] } as never).filter((e) => e.name === "btw")).toHaveLength(1);
    expect(slashEntries(null)).toEqual([]);
  });
});
