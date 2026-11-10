import { appendFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewHistoryEntry } from "../src/protocol.js";
import { sessionTranscriptPath } from "../src/review/sessions.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * MARK: wave4 w4-history — docs/PROTOCOL.md §38.3 "History that lasts" through the engine: the turn summary as a row
 * (back after a restart), `transcript_restore.start` + `transcript_page`, `transcript_search` over every chat, and the
 * `why` / `commit` a past round keeps.
 */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-w4-history"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\nline3\n");
  write(dir, "b.txt", "bee\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** One turn that edits `file` with a rationale (the §12 why) and ends; waits for the collection. */
async function editTurn(h: Harness, dir: string, text: string, file: string, content: string, id: string, rationale: string): Promise<void> {
  await h.engine.handle({ type: "send", text });
  const s = h.session();
  s.emit({ type: "tool_use", id, name: "Edit", input: { file_path: join(dir, file) }, file: join(dir, file), rationale });
  write(dir, file, content);
  s.emit({ type: "tool_result", toolUseId: id, isError: false, preview: "ok" });
  s.emit({ type: "text_delta", text: `${text} — done` });
  s.emitTurnEnd({ sessionId: s.opts.settings.resumeSessionId ?? s.opts.settings.sessionId!, toolFiles: [{ path: join(dir, file), tools: ["Edit"], count: 1, toolUseIds: [id] }] });
  await h.waitFor((st) => st.gate.turnEndTree !== null && st.gate.phase !== "collecting" && st.gate.phase !== "running", "collection");
  await h.settle();
}

describe("history that lasts (§38.3)", () => {
  it("the turn summary is a transcript row: back in transcript_restore after a restart, with start / sessionId", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    const opened = await a.open(dir);
    const chat = opened.sessions.currentId!;
    expect(a.ofType("transcript_restore")[0]).toEqual({ type: "transcript_restore", items: [] }); // an empty chat: as before
    await editTurn(a, dir, "fix the readme", "README.md", "line1\nFIXED\nline3\n", "e1", "The second line was wrong.");
    const live = a.ofType("turn_summary").at(-1)!;
    expect(live.files.map((f) => [f.path, f.why])).toEqual([["README.md", "The second line was wrong."]]);
    await a.engine.dispose();

    const b = harness();
    await b.hello();
    await b.open(dir);
    const restore = b.ofType("transcript_restore")[0]!;
    expect(restore.sessionId).toBe(chat);
    expect(restore.start).toBe(0);
    expect(restore.items.map((i) => i.kind)).toEqual(["user_message", "tool_use", "tool_result", "assistant_text", "turn_end", "turn_summary"]);
    const row = restore.items.find((i) => i.kind === "turn_summary")!;
    if (row.kind !== "turn_summary") throw new Error("not a summary row");
    expect(row.turn).toBe(1);
    expect(row).not.toHaveProperty("type");
    expect(row.files.map((f) => [f.path, f.why, f.adds, f.dels])).toEqual([["README.md", "The second line was wrong.", 1, 1]]);
    expect(row.review).toEqual(live.review);
  });

  it("transcript_page reads the rows before the restored ones (the current chat by default); unknown chats are refused", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    const chat = (await a.open(dir)).sessions.currentId!;
    const path = sessionTranscriptPath(join(dir, ".git"), chat);
    const rows = Array.from({ length: 450 }, (_, i) => JSON.stringify({ at: `2026-10-22T09:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`, turn: i + 1, kind: "user_message", text: `message ${i}` }));
    appendFileSync(path, rows.join("\n") + "\n");
    await a.engine.request({ type: "session_open", sessionId: chat });
    const restore = a.ofType("transcript_restore").at(-1)!;
    expect(restore.items).toHaveLength(200);
    expect(restore.start).toBe(250);
    const firstAt = restore.items[0]!.at;
    const page = await a.engine.request({ type: "transcript_page", before: restore.start!, beforeAt: firstAt });
    expect(page).toMatchObject({ type: "transcript_page", sessionId: chat, start: 50, before: 250 });
    expect(page.items).toHaveLength(200);
    expect(page.items[0]).toMatchObject({ kind: "user_message", text: "message 50" });
    expect(page.items.at(-1)).toMatchObject({ text: "message 249" });
    const last = await a.engine.request({ type: "transcript_page", sessionId: chat, before: page.start, limit: 500 });
    expect([last.start, last.items.length]).toEqual([0, 50]);
    await expect(a.engine.request({ type: "transcript_page", sessionId: "ghost", before: 10 })).rejects.toThrow("unknown_session:ghost");
  });

  it("transcript_search finds messages and answers in every chat (newest chat first, one match each)", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    const first = (await a.open(dir)).sessions.currentId!;
    await editTurn(a, dir, "invoiceMapper 쿼리를 고쳐줘", "README.md", "line1\nSELECT 1\nline3\n", "e1", "query fix");
    await a.engine.request({ type: "accept", paths: ["README.md"] });
    await a.engine.request({ type: "session_new" });
    await a.waitFor((s) => s.session.open && !s.session.starting && s.sessions.currentId !== first, "second chat");
    const second = a.engine.state.sessions.currentId!;
    await editTurn(a, dir, "b 파일도 InvoiceMapper 처럼", "b.txt", "bee\nmore\n", "e2", "same as mapper");

    const res = await a.engine.request({ type: "transcript_search", query: "invoicemapper" });
    expect(res.type).toBe("transcript_search");
    expect(res.matches.map((m) => [m.sessionId, m.kind, m.line])).toEqual([
      [second, "assistant_text", "b 파일도 InvoiceMapper 처럼 — done"],
      [first, "assistant_text", "invoiceMapper 쿼리를 고쳐줘 — done"],
    ]);
    expect(res.matches[1]!.row).toBe(3);
    expect((await a.engine.request({ type: "transcript_search", query: "쿼리를 고쳐" })).matches.map((m) => m.sessionId)).toEqual([first]);
    expect(res.matches[1]!.title).toBe("invoiceMapper 쿼리를 고쳐줘");
    const answer = await a.engine.request({ type: "transcript_search", query: "처럼 — done" });
    expect(answer.matches.map((m) => [m.sessionId, m.kind])).toEqual([[second, "assistant_text"]]);
    expect((await a.engine.request({ type: "transcript_search", query: "   " })).matches).toEqual([]);
    expect((await a.engine.request({ type: "transcript_search", query: "nothing like this" })).matches).toEqual([]);
  });

  it("history_diff says why the round changed the file; a committed file keeps its commit subject", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    await a.open(dir);
    await editTurn(a, dir, "fix the readme", "README.md", "line1\nFIXED\nline3\n", "e1", "The second line was wrong.");
    await a.engine.request({ type: "accept", paths: ["README.md"] });
    await a.engine.request({ type: "commit", message: "fix: readme line two\n\nbody" });
    await a.waitFor((s) => s.changedFiles.length === 0, "committed");
    const ev = await a.engine.request({ type: "review_history" });
    const entry: ReviewHistoryEntry = ev.entries[0] ?? ev.current!;
    expect(entry).toBeDefined();
    const file = entry.files.find((f) => f.path === "README.md")!;
    expect(file.committed).toBe(true);
    expect(file.commit?.subject).toBe("fix: readme line two");
    expect(file.commit?.sha).toMatch(/^[0-9a-f]{40}$/);
    const d = await a.engine.request({ type: "history_diff", entryId: entry.id, path: "README.md" });
    expect(d.why).toMatchObject({ text: "The second line was wrong.", toolUseId: "e1", turn: 1 });
  });
});
