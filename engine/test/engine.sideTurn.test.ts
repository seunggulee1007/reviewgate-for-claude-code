import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SIDE_PROMPT_HEADER } from "../src/side/context.js";
import { runningTurnHeader } from "../src/side/runningTurn.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { FakeSide, makeSideRepo, waitForEvent, type SideScript } from "./helpers/fakeSide.js";
import { removeDir, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §36.10 (SME-02): a side question asked while a turn runs knows what that turn was asked and did. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function setup(script: SideScript = () => ({ text: "answer" })) {
  const sides: FakeSide[] = [];
  const h = makeHarness({ sideQueryFactory: (o) => {
    const f = new FakeSide(o, script);
    sides.push(f);
    return f;
  } });
  harnesses.push(h);
  return { h, sides };
}

/** Turn 1 edits README.md and ends with `lastUuid` (the fork point of a side question asked during turn 2). */
async function firstTurn(h: Harness, dir: string, lastUuid?: string): Promise<void> {
  await h.engine.handle({ type: "send", text: "Change README" });
  h.session().emitSessionInfo();
  write(dir, "README.md", "line1\nline2 changed\nline3\n");
  h.session().emit({ type: "tool_use", id: "toolu_e1", name: "Edit", input: { file_path: join(dir, "README.md"), old_string: "line2", new_string: "line2 changed" }, file: join(dir, "README.md") });
  h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "README.md"), tools: ["Edit"], count: 1, toolUseIds: ["toolu_e1"] }], ...(lastUuid ? { lastUuid } : {}) });
  await h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.canSend, "turn 1 collected");
}

/** Turn 2 runs: some text, a Read, an Agent with a subagent call. */
async function runningSecondTurn(h: Harness, dir: string): Promise<void> {
  await h.engine.handle({ type: "send", text: "Now make the parser accept empty input", mentions: ["README.md"] });
  expect(h.engine.state.gate.phase).toBe("running");
  const s = h.session();
  s.emit({ type: "text_delta", text: "I'll check the parser first." });
  s.emit({ type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: join(dir, "README.md") } });
  s.emit({ type: "tool_use", id: "toolu_a1", name: "Agent", input: { subagent_type: "explore", description: "Find the callers", prompt: "Find every caller of parse()" } });
  s.emit({ type: "tool_use", id: "toolu_g1", name: "Grep", input: { pattern: "parse(" }, parentToolUseId: "toolu_a1" });
  s.emit({ type: "text_delta", text: " Then I will run the tests." });
  await h.settle();
}

describe("§36.10 side questions during a turn", () => {
  it("fork_at while turn 2 runs: the first prompt gets the running-turn block after the anchor context; fork.atTurn 1, runningTurn 2", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    const { h, sides } = setup();
    await h.hello();
    await h.open(dir);
    await firstTurn(h, dir, "uuid-T1");
    await runningSecondTurn(h, dir);
    const t = (await h.engine.request({ type: "side_ask", anchor: { path: "README.md", line: 2, side: "new" }, question: "왜 이 명령이 필요해?" })).thread;
    await waitForEvent(h, "side_turn_end", (e) => e.threadId === t.id);
    const o = sides[0]!.opts;
    expect(o.forkFrom).toBe("sess-1");
    expect(o.forkAt).toBe("uuid-T1");
    const p = o.prompt;
    expect(p.startsWith(SIDE_PROMPT_HEADER)).toBe(true);
    const anchorAt = p.indexOf("File: README.md");
    const blockAt = p.indexOf(runningTurnHeader(2));
    const questionAt = p.indexOf("Question: 왜 이 명령이 필요해?");
    expect(anchorAt).toBeGreaterThan(0);
    expect(blockAt).toBeGreaterThan(anchorAt);
    expect(questionAt).toBeGreaterThan(blockAt);
    const block = p.slice(blockAt, questionAt);
    expect(block).toContain("Now make the parser accept empty input");
    expect(block).toContain("Mentioned: README.md");
    expect(block).toContain("I'll check the parser first. Then I will run the tests.");
    expect(block).toContain("- Read: README.md");
    expect(block).toContain("- Agent: (explore) Find the callers");
    expect(block).toContain('  - [explore] Grep: {"pattern":"parse("}');
    // Turn 1's request and calls are in the forked conversation, not in the block.
    expect(block).not.toContain("Change README");
    expect(block).not.toContain("Edit");
    const thread = (await h.engine.request({ type: "side_list" })).threads[0]!;
    expect(thread.fork).toEqual({ mode: "fork_at", fromSessionId: "sess-1", at: "uuid-T1", atTurn: 1, runningTurn: 2 });
    // A follow-up question resumes the side session: no block again.
    await h.engine.request({ type: "side_ask", threadId: t.id, question: "그리고?" });
    await waitForEvent(h, "side_turn_end", (e) => e.threadId === t.id && sides.length === 2);
    expect(sides[1]!.opts.prompt).toBe("그리고?");
  });

  it("idle: a fork of the whole session with atTurn = the last turn and no block", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    const { h, sides } = setup();
    await h.hello();
    await h.open(dir);
    await firstTurn(h, dir, "uuid-T1");
    const t = (await h.engine.request({ type: "side_ask", question: "what changed?" })).thread;
    await waitForEvent(h, "side_turn_end", (e) => e.threadId === t.id);
    expect(sides[0]!.opts.prompt).not.toContain("in progress");
    expect((await h.engine.request({ type: "side_list" })).threads[0]!.fork).toEqual({ mode: "fork_full", fromSessionId: "sess-1", at: null, atTurn: 1, runningTurn: null });
  });

  it("the first turn of a brand-new chat: fresh with the block (atTurn null, runningTurn 1)", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    const { h, sides } = setup();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "Run ./gradlew clean build and fix what fails" });
    h.session().emit({ type: "tool_use", id: "toolu_b1", name: "Bash", input: { command: "./gradlew clean build" } });
    await h.settle();
    const t = (await h.engine.request({ type: "side_ask", anchor: { toolUseId: "toolu_b1" }, question: "왜 필요해?" })).thread;
    await waitForEvent(h, "side_turn_end", (e) => e.threadId === t.id);
    const o = sides[0]!.opts;
    expect(o.forkFrom).toBeUndefined();
    expect(o.resume).toBeUndefined();
    expect(o.prompt).toContain(runningTurnHeader(1));
    expect(o.prompt).toContain("Run ./gradlew clean build and fix what fails");
    expect(o.prompt).toContain("- Bash: ./gradlew clean build");
    expect(o.prompt).toContain("What the main agent has said so far in this turn: (no text yet)");
    expect((await h.engine.request({ type: "side_list" })).threads[0]!.fork).toEqual({ mode: "fresh", fromSessionId: null, at: null, atTurn: null, runningTurn: 1 });
  });

  it("a fork_full while a turn runs (fork point unknown) adds nothing; a failed fork_at keeps the block's turns on the fork_full retry", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    const { h, sides } = setup((o) => (o.forkAt === "uuid-bad" ? { text: "", error: "No message found with message.uuid of: uuid-bad", silent: true } : { text: "ok" }));
    await h.hello();
    await h.open(dir);
    // Turn 1 ends without a chain uuid: turn 2's side question can only fork the whole session.
    await firstTurn(h, dir);
    await runningSecondTurn(h, dir);
    const t = (await h.engine.request({ type: "side_ask", question: "status?" })).thread;
    await waitForEvent(h, "side_turn_end", (e) => e.threadId === t.id);
    expect(sides[0]!.opts.forkAt).toBeUndefined();
    expect(sides[0]!.opts.forkFrom).toBe("sess-1");
    expect(sides[0]!.opts.prompt).not.toContain("in progress");
    expect((await h.engine.request({ type: "side_list" })).threads[0]!.fork).toEqual({ mode: "fork_full", fromSessionId: "sess-1", at: null, atTurn: 2, runningTurn: null });

    // Turn 2 ends with a uuid the CLI does not know; turn 3's side question falls back to the whole session.
    h.session().emitTurnEnd({ toolFiles: [], lastUuid: "uuid-bad" });
    await h.waitFor((s) => s.gate.canSend, "turn 2 collected");
    await h.engine.handle({ type: "send", text: "turn three" });
    const t2 = (await h.engine.request({ type: "side_ask", question: "and now?" })).thread;
    await waitForEvent(h, "side_turn_end", (e) => e.threadId === t2.id);
    expect(sides.slice(1).map((f) => [f.opts.forkAt, f.opts.prompt.includes(runningTurnHeader(3))])).toEqual([["uuid-bad", true], [undefined, true]]);
    const fork = (await h.engine.request({ type: "side_list" })).threads.find((x) => x.id === t2.id)!.fork;
    expect(fork).toEqual({ mode: "fork_full", fromSessionId: "sess-1", at: null, atTurn: 2, runningTurn: 3 });
  });
});
