import { afterEach, describe, expect, it } from "vitest";
import { BTW_HISTORY, BTW_SYSTEM, BtwHistory, btwForkPrompt } from "../src/side/btw.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { FakeSide, makeSideRepo, type SideScript } from "./helpers/fakeSide.js";
import { removeDir } from "./helpers/repo.js";

/** docs/PROTOCOL.md §56.1 `btw_ask`: /btw as in the terminal — answered apart, with no tools, while Claude works. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function running(script: SideScript = () => ({ text: "fork answer" })): Promise<{ h: Harness; sides: FakeSide[] }> {
  const sides: FakeSide[] = [];
  const h = makeHarness({ sideQueryFactory: (o) => {
    const f = new FakeSide(o, script);
    sides.push(f);
    return f;
  } });
  harnesses.push(h);
  const dir = makeSideRepo("rg-btw");
  dirs.push(dir);
  await h.hello();
  await h.open(dir);
  await h.engine.request({ type: "send", text: "Fix the cart" });
  await h.waitFor((s) => s.gate.phase === "running", "turn running");
  return { h, sides };
}

describe("§56.1 btw_ask", () => {
  it("while a turn runs the live session answers; the next question carries the earlier exchange; nothing joins the chat", async () => {
    const { h } = await running();
    const rowsBefore = h.ofType("user_message").length;
    h.session().sideQuestionResult = { response: "It is the cart total.", synthetic: false };
    const first = await h.engine.request({ type: "btw_ask", question: "  what does sum() return?  " });
    expect(first).toMatchObject({ type: "btw_answer", question: "what does sum() return?", answer: "It is the cart total.", via: "session" });
    h.session().sideQuestionResult = { response: "Yes.", synthetic: false };
    await h.engine.request({ type: "btw_ask", question: "is it cached?" });
    expect(h.session().sideQuestions).toEqual([
      { question: "what does sum() return?", history: [] },
      { question: "is it cached?", history: [{ question: "what does sum() return?", response: "It is the cart total." }] },
    ]);
    // The turn goes on: nothing was sent, put into it or interrupted, and no row came.
    expect(h.session().sends).toHaveLength(1);
    expect(h.session().steers).toEqual([]);
    expect(h.session().interrupts).toBe(0);
    expect(h.ofType("user_message")).toHaveLength(rowsBefore);
    expect(h.engine.state.gate.phase).toBe("running");
  });

  it("a note of the CLI's own (synthetic) is shown but not handed to the next question", async () => {
    const { h } = await running();
    h.session().sideQuestionResult = { response: "(The model tried to call Read instead of answering directly.)", synthetic: true };
    const r = await h.engine.request({ type: "btw_ask", question: "read cart.ts?" });
    expect(r).toMatchObject({ via: "session", synthetic: true });
    await h.engine.request({ type: "btw_ask", question: "again" });
    expect(h.session().sideQuestions[1]!.history).toEqual([]);
  });

  it("a session that refuses it leaves it to a fork of the chat with no tools, one turn, no session file", async () => {
    const { h, sides } = await running();
    h.session().sideQuestionResult = { response: "first", synthetic: false };
    await h.engine.request({ type: "btw_ask", question: "q1" });
    h.session().sideQuestionResult = new Error("Unsupported control request subtype: side_question");
    const r = await h.engine.request({ type: "btw_ask", question: "q2" });
    expect(r).toMatchObject({ type: "btw_answer", question: "q2", answer: "fork answer", via: "fork" });
    expect(sides).toHaveLength(1);
    const o = sides[0]!.opts;
    expect(o.tools).toEqual([]);
    expect(o.maxTurns).toBe(1);
    expect(o.persistSession).toBe(false);
    expect(o.allowWeb).toBe(false);
    expect(o.system).toBe(BTW_SYSTEM);
    expect(o.prompt).toBe(btwForkPrompt("q2", [{ question: "q1", response: "first" }]));
    expect(o.mcp).toBeUndefined();
    expect(h.engine.state.gate.phase).toBe("running");
  });

  it("a question waiting for its answer holds up neither the turn's lane nor another question", async () => {
    const { h } = await running();
    let answer: (a: { response: string; synthetic: boolean }) => void = () => {};
    h.session().sideQuestionResult = new Promise((r) => (answer = r));
    const asked = h.engine.request({ type: "btw_ask", question: "slow one" });
    await h.waitFor(() => h.session().sideQuestions.length === 1, "asked");
    await h.engine.request({ type: "steer", text: "also the README" }); // the main lane is free
    expect(h.session().steers).toEqual(["also the README"]);
    answer({ response: "done", synthetic: false });
    await expect(asked).resolves.toMatchObject({ answer: "done" });
  });

  it("refused: empty, too long, and a fork that failed", async () => {
    const { h } = await running(() => ({ text: "", error: "boom\nmore" }));
    await expect(h.engine.request({ type: "btw_ask", question: "   " })).rejects.toThrow(/empty_question/);
    await expect(h.engine.request({ type: "btw_ask", question: "x".repeat(20_001) })).rejects.toThrow(/question_too_long/);
    h.session().sideQuestionResult = new Error("no");
    await expect(h.engine.request({ type: "btw_ask", question: "q" })).rejects.toThrow("btw_failed:boom");
    h.session().sideQuestionResult = null; // the CLI cancelled it
    await expect(h.engine.request({ type: "btw_ask", question: "q" })).rejects.toThrow("btw_failed:cancelled");
  });
});

describe("§56.1 the chat's /btw history", () => {
  it("keeps the last exchanges of the current chat; another chat starts with none", () => {
    const b = new BtwHistory();
    for (let i = 0; i < BTW_HISTORY + 2; i++) b.add("chat-1", { question: `q${i}`, response: `a${i}` });
    expect(b.of("chat-1").map((x) => x.question)).toEqual(Array.from({ length: BTW_HISTORY }, (_, i) => `q${i + 2}`));
    expect(b.of("chat-2")).toEqual([]);
    expect(b.of("chat-1")).toEqual([]);
  });

  it("the fork's prompt is the question alone, or the earlier exchanges before it", () => {
    expect(btwForkPrompt("why?", [])).toBe("why?");
    expect(btwForkPrompt("why?", [{ question: "a", response: "b" }])).toBe("Earlier side questions in this chat:\n\nQ: a\nA: b\n\nThe side question now:\nwhy?");
  });
});
