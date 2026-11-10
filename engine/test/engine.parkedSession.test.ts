import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type FakeClaudeSession, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §9.1 (r2-chats-cards M33): the chat switched away from keeps its idle Claude Code process for a while
 * (one besides the live one), so switching back takes it again instead of starting a CLI (2–9 s with plugins and MCP
 * servers); a busy chat, a changed start, too long idle, a deleted chat or a process that starts to work end it, and turns
 * stay one at a time — only the live CLI ever runs one.
 */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function opened(parkIdleMs = 60_000): Promise<{ h: Harness; first: string }> {
  const dir = realpathSync(makeRepo());
  dirs.push(dir);
  const h = makeHarness({ parkIdleMs });
  harnesses.push(h);
  await h.hello();
  const first = (await h.open(dir)).sessions.currentId!;
  return { h, first };
}

const idOf = (s: FakeClaudeSession): string => s.opts.settings.resumeSessionId ?? s.opts.settings.sessionId!;
/** The engine's live CLI (`h.session()` is the newest one made, not necessarily the live one here). */
const current = (h: Harness): FakeClaudeSession => (h.engine as unknown as { session: FakeClaudeSession }).session;

async function turn(h: Harness, text: string): Promise<void> {
  await h.engine.handle({ type: "send", text });
  current(h).emitTurnEnd({ sessionId: idOf(current(h)) });
  await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn end");
  await h.settle();
}

const live = (h: Harness, id: string) => h.waitFor((s) => s.sessions.currentId === id && s.session.open && !s.session.starting, `chat ${id} live`);
const newChat = async (h: Harness, other: string): Promise<string> => {
  await h.engine.request({ type: "session_new" });
  return (await h.waitFor((s) => s.sessions.currentId !== other && s.session.open && !s.session.starting, "new chat")).sessions.currentId!;
};

describe("the chat left keeps its idle CLI (§9.1)", () => {
  it("switching back takes the parked process again — no new CLI, its id and model come back; the one left is parked in turn", async () => {
    const { h, first } = await opened();
    await turn(h, "hello");
    current(h).emitSessionInfo({ sessionId: first, model: "claude-acme-1", slashCommands: [], skills: [], plugins: [], mcpServers: [] });
    await h.settle();
    const a = h.sessions[0]!;
    const second = await newChat(h, first);
    expect(h.sessions).toHaveLength(2);
    expect(a.disposed).toBe(false); // parked, idle
    await turn(h, "other topic");

    await h.engine.request({ type: "session_open", sessionId: first });
    const back = await live(h, first);
    expect(h.sessions).toHaveLength(2); // no CLI started
    expect(current(h)).toBe(a);
    expect(back.session.sessionId).toBe(first);
    expect(back.session.model).toBe("claude-acme-1");
    expect(h.sessions[1]!.disposed).toBe(false); // the second chat's CLI waits in turn

    // A message in the chat taken back runs in its own process.
    await turn(h, "back again");
    expect(a.sends.map((x) => x.text)).toEqual(["hello", "back again"]);
    await h.engine.request({ type: "session_open", sessionId: second });
    await live(h, second);
    expect(h.sessions).toHaveLength(2);
    expect(current(h)).toBe(h.sessions[1]);
  });

  it("one parked CLI at most: a third chat ends the oldest; a chat whose CLI ended resumes as before", async () => {
    const { h, first } = await opened();
    await turn(h, "one");
    const second = await newChat(h, first);
    await turn(h, "two");
    const third = await newChat(h, second);
    expect(third).not.toBe(first);
    await h.waitFor(() => h.sessions[0]!.disposed, "the first CLI ended");
    expect(h.sessions[1]!.disposed).toBe(false);
    await h.engine.request({ type: "session_open", sessionId: first });
    await live(h, first);
    expect(h.sessions).toHaveLength(4); // resumed in a new CLI
    expect(h.sessions[3]!.opts.settings.resumeSessionId).toBe(first);
  });

  it("idle too long: the parked CLI ends by itself", async () => {
    const { h, first } = await opened(50);
    await turn(h, "one");
    await newChat(h, first);
    await h.waitFor(() => h.sessions[0]!.disposed, "the parked CLI ended after its idle time", 3000);
  });

  it("never parked: a chat with a turn running (the switch waits for it), or with parking off (0)", async () => {
    const off = await opened(0);
    await turn(off.h, "one");
    await newChat(off.h, off.first);
    expect(off.h.sessions[0]!.disposed).toBe(true);

    const { h, first } = await opened();
    await h.engine.handle({ type: "send", text: "long job" });
    await expect(h.engine.request({ type: "session_new" })).rejects.toThrow("session_busy");
    current(h).emitTurnEnd({ sessionId: first });
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn end");
    // A background task still running in that chat: stopped with it as before (its result has nowhere to go).
    current(h).emit({ type: "background_tasks", tasks: [{ taskId: "bg1", kind: "bash", description: "watch", status: "running" } as never] });
    await h.settle();
    await newChat(h, first);
    expect(h.sessions[0]!.disposed).toBe(true);
  });

  it("a changed start (another model, setting or mode) starts a fresh CLI instead", async () => {
    const { h, first } = await opened();
    await turn(h, "one");
    const second = await newChat(h, first);
    await h.engine.handle({ type: "set_settings", settings: { systemPromptAppend: "Answer in Korean." } });
    await h.settle();
    await h.engine.request({ type: "session_open", sessionId: first });
    await live(h, first);
    expect(h.sessions[0]!.disposed).toBe(true);
    expect(h.sessions).toHaveLength(3);
    expect(h.sessions[2]!.opts.settings.resumeSessionId).toBe(first);
    expect(second).not.toBe(first);
  });

  it("a parked CLI that starts to work, dies or whose chat is deleted ends — nothing it does reaches this chat", async () => {
    const { h, first } = await opened();
    await turn(h, "one");
    const second = await newChat(h, first);
    const a = h.sessions[0]!;
    a.emitAutoTurnStart({ trigger: "task_notification" } as never);
    await h.settle();
    expect(a.disposed).toBe(true);
    expect(a.autoTurnAnswers).toEqual([]);
    expect(h.engine.state.sessions.currentId).toBe(second);
    expect(h.engine.state.gate.phase).not.toBe("running");

    await turn(h, "two");
    const third = await newChat(h, second);
    const b = h.sessions[1]!;
    expect(b.disposed).toBe(false);
    await h.engine.request({ type: "session_delete", sessionId: second });
    await h.waitFor(() => b.disposed, "deleting the chat ends its parked CLI");
    expect(h.engine.state.sessions.currentId).toBe(third);
  });

  it("closing the project or the engine ends the parked CLI too", async () => {
    const { h, first } = await opened();
    await turn(h, "one");
    await newChat(h, first);
    await h.engine.request({ type: "close_project" });
    expect(h.sessions[0]!.disposed).toBe(true);
    expect(h.sessions[1]!.disposed).toBe(true);
  });
});
