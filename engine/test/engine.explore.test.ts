import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptItem } from "../src/protocol.js";
import { sessionTranscriptPath } from "../src/review/sessions.js";
import { isExploreCall, markExplore, mcpToolPart } from "../src/session/explore.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir, write } from "./helpers/repo.js";

/** MARK: wave4b w4b-tabs — docs/PROTOCOL.md §39.2: exploration calls, and reading another chat without switching. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function opened(): Promise<{ h: Harness; dir: string }> {
  const dir = realpathSync(makeRepo());
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  return { h, dir };
}

const rowsOf = (dir: string, id: string) =>
  readFileSync(sessionTranscriptPath(join(dir, ".git"), id), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

async function endTurn(h: Harness): Promise<void> {
  const s = h.session();
  s.emitTurnEnd({ sessionId: s.opts.settings.resumeSessionId ?? s.opts.settings.sessionId! });
  await h.waitFor((st) => st.gate.phase !== "running" && st.gate.phase !== "collecting", "turn end");
  await h.settle();
}

describe("isExploreCall (§39.2)", () => {
  it("read-only built-ins explore; edits, writes, agents and the todo list do not", () => {
    for (const name of ["Read", "Glob", "Grep", "LS", "NotebookRead", "ListMcpResourcesTool", "ReadMcpResourceTool"]) expect(isExploreCall(name, {})).toBe(true);
    for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task", "TodoWrite", "WebFetch", "SendMessage"]) expect(isExploreCall(name, {})).toBe(false);
  });

  it("Bash explores only through the read-only classifier, never in the background", () => {
    expect(isExploreCall("Bash", { command: "ls -la src" })).toBe(true);
    expect(isExploreCall("Bash", { command: "grep -rn couponCode src" })).toBe(true);
    expect(isExploreCall("Bash", { command: "rm -rf build" })).toBe(false);
    expect(isExploreCall("Bash", { command: "npm test" })).toBe(false);
    expect(isExploreCall("Bash", { command: "cat a > b" })).toBe(false);
    expect(isExploreCall("Bash", { command: "ls", run_in_background: true })).toBe(false);
    expect(isExploreCall("Bash", { command: "  " })).toBe(false);
    expect(isExploreCall("Bash", {})).toBe(false);
  });

  it("an MCP tool explores when its name starts with a lookup verb", () => {
    expect(mcpToolPart("mcp__claude_ai_Claude_Docs__batch")).toBe("batch");
    expect(mcpToolPart("Read")).toBeNull();
    expect(isExploreCall("mcp__elasticsearch__search", {})).toBe(true);
    expect(isExploreCall("mcp__filesystem__read_text_file", {})).toBe(true);
    expect(isExploreCall("mcp__context7__query-docs", {})).toBe(true);
    expect(isExploreCall("mcp__elasticsearch__get_mappings", {})).toBe(true);
    expect(isExploreCall("mcp__filesystem__write_file", {})).toBe(false);
    expect(isExploreCall("mcp__claude-in-chrome__navigate", {})).toBe(false);
    expect(isExploreCall("mcp__srv__searchless", {})).toBe(false);
    expect(isExploreCall("mcp__", {})).toBe(false);
  });
});

describe("the engine marks exploration calls (§39.2)", () => {
  it("tool_use carries explore: true — on the wire and in the chat's rows — for reads, searches and read-only Bash only", async () => {
    const { h, dir } = await opened();
    await h.engine.handle({ type: "send", text: "look around" });
    const s = h.session();
    s.emit({ type: "tool_use", id: "r1", name: "Read", input: { file_path: join(dir, "README.md") }, file: join(dir, "README.md") });
    s.emit({ type: "tool_use", id: "g1", name: "Grep", input: { pattern: "x" } });
    s.emit({ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls -la" } });
    s.emit({ type: "tool_use", id: "b2", name: "Bash", input: { command: "npm run build" } });
    s.emit({ type: "tool_use", id: "e1", name: "Edit", input: { file_path: join(dir, "README.md") }, file: join(dir, "README.md") });
    write(dir, "README.md", "changed\n");
    await endTurn(h);
    const expected = [["r1", true], ["g1", true], ["b1", true], ["b2", null], ["e1", null]];
    expect(h.ofType("tool_use").map((e) => [e.id, e.explore ?? null])).toEqual(expected);
    const chat = h.engine.state.sessions.currentId!;
    expect(rowsOf(dir, chat).filter((r) => r.kind === "tool_use").map((r) => [r.id, r.explore ?? null])).toEqual(expected);
  });
});

describe("reading another chat without switching (§39.2, §38.3's transcript_page)", () => {
  it("a before past the end replies that chat's last rows while a turn runs in the current one; nothing switches", async () => {
    const { h } = await opened();
    await h.engine.handle({ type: "send", text: "first chat question" });
    h.session().emit({ type: "text_delta", text: "first chat answer" });
    await endTurn(h);
    const first = h.engine.state.sessions.currentId!;
    await h.engine.request({ type: "session_new" });
    await h.waitFor((s) => s.session.open && !s.session.starting && s.sessions.currentId !== first, "second chat");
    const second = h.engine.state.sessions.currentId!;
    await h.engine.handle({ type: "send", text: "second chat question" });
    await h.waitFor((s) => s.gate.phase === "running", "running");

    const page = await h.engine.request({ type: "transcript_page", sessionId: first, before: Number.MAX_SAFE_INTEGER });
    expect(page.sessionId).toBe(first);
    expect(page.start).toBe(0);
    expect(page.items.map((r) => r.kind)).toEqual(expect.arrayContaining(["user_message", "assistant_text"]));
    expect(page.items.some((r) => r.kind === "assistant_text" && r.text === "first chat answer")).toBe(true);
    expect(page.before).toBe(page.items.length);
    // The running turn stays where it was.
    expect(h.engine.state.sessions.currentId).toBe(second);
    expect(h.engine.state.gate.phase).toBe("running");
  });
});

describe("rows saved before §39.2 (no explore field)", () => {
  it("markExplore adds the mark to a read / search row that lacks it; other rows stay the same objects", () => {
    const rows = [
      { at: "t", turn: 1, kind: "tool_use", id: "r1", name: "Read", input: { file_path: "/a" } },
      { at: "t", turn: 1, kind: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } },
      { at: "t", turn: 1, kind: "assistant_text", text: "x" },
    ] as const;
    const marked = markExplore(rows as unknown as TranscriptItem[]);
    expect(marked.map((r) => (r.kind === "tool_use" ? r.explore ?? null : "-"))).toEqual([true, null, "-"]);
    expect(marked[1]).toBe(rows[1]);
    expect(marked[2]).toBe(rows[2]);
  });

  it("transcript_page and transcript_restore mark them", async () => {
    const { h, dir } = await opened();
    const chat = h.engine.state.sessions.currentId!;
    const file = sessionTranscriptPath(join(dir, ".git"), chat);
    writeFileSync(file, `${JSON.stringify({ at: "2026-10-01T00:00:00.000Z", turn: 1, kind: "tool_use", id: "g1", name: "Grep", input: { pattern: "x" } })}\n`);
    const page = await h.engine.request({ type: "transcript_page", sessionId: chat, before: 10 });
    expect(page.items.map((r) => (r.kind === "tool_use" ? r.explore : undefined))).toEqual([true]);
  });
});
