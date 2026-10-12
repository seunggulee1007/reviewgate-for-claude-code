import { appendFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionTranscriptPath } from "../src/review/sessions.js";
import { fileLinesOf, imageMediaType, perChatOf, prHeadContent, searchTranscriptMany } from "../src/review/reviewLeftovers.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3 review leftovers through the engine: the history diff's new side for
 * "20줄 더 보기" (`history_file_lines`), the whitespace-ignoring diff (`select_file {ignoreWhitespace}`), several matches per
 * chat (`transcript_search {perChat}`) and an image's two sides (`file_image`).
 */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-w4c-review"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "Svc.java", Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  write(dir, "ws.java", "class A {\n  int a = 1;\n  int b = 2;\n}\n");
  writeFileSync(join(dir, "logo.png"), PNG_A);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

// Two 1×1 PNGs (different pixels).
const PNG_A = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PNG_B = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

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

/** One turn that writes `files` (path → content) and ends; waits for the collection. */
async function turn(h: Harness, dir: string, text: string, files: Record<string, string | Buffer>): Promise<void> {
  await h.engine.handle({ type: "send", text });
  const s = h.session();
  const entries = Object.entries(files).map(([file, content], i) => {
    const id = `t${i}`;
    s.emit({ type: "tool_use", id, name: "Write", input: { file_path: join(dir, file) }, file: join(dir, file) });
    writeFileSync(join(dir, file), content);
    s.emit({ type: "tool_result", toolUseId: id, isError: false, preview: "ok" });
    return { path: join(dir, file), tools: ["Write"], count: 1, toolUseIds: [id] };
  });
  s.emit({ type: "text_delta", text: `${text} — done` });
  s.emitTurnEnd({ sessionId: s.opts.settings.resumeSessionId ?? s.opts.settings.sessionId!, toolFiles: entries });
  await h.waitFor((st) => st.gate.turnEndTree !== null && st.gate.phase !== "collecting" && st.gate.phase !== "running", "collection");
  await h.settle();
}

const svcAfter = (): string => Array.from({ length: 60 }, (_, i) => (i === 29 ? "line 30 CHANGED" : `line ${i + 1}`)).join("\n") + "\n";

describe("review leftovers (§41.3) — engine", () => {
  it("history_file_lines reads the new side of the round's diff (the round in progress too); unknown entries are refused", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await turn(h, dir, "change line 30", { "Svc.java": svcAfter() });
    const history = await h.engine.request({ type: "review_history" });
    const current = history.current!;
    expect(current.files.map((f) => f.path)).toEqual(["Svc.java"]);
    const reply = await h.engine.request({ type: "history_file_lines", entryId: current.id, path: "Svc.java" });
    expect(reply).toMatchObject({ type: "file_lines", scope: "history", path: "Svc.java", entryId: current.id, isBinary: false, isTooLarge: false });
    expect(reply.lines).toHaveLength(60);
    expect(reply.lines[29]).toBe("line 30 CHANGED");
    await expect(h.engine.request({ type: "history_file_lines", entryId: "ghost", path: "Svc.java" })).rejects.toThrow("unknown_history_entry:ghost");
    await expect(h.engine.request({ type: "history_file_lines", entryId: current.id, path: "nope.txt" })).rejects.toThrow("not_in_history_entry:nope.txt");
  });

  it("select_file {ignoreWhitespace} diffs with -w: a whitespace-only file has no hunks, a mixed one keeps its real change", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await turn(h, dir, "reindent", { "ws.java": "class A {\n\tint a = 1;\n\tint b = 2;\n}\n", "Svc.java": svcAfter().replace("line 10\n", "  line 10\n") });
    const plain = await h.engine.request({ type: "select_file", path: "ws.java" });
    expect(plain.diff.hunks.length).toBe(1);
    expect(plain).not.toHaveProperty("ignoreWhitespace");
    const ws = await h.engine.request({ type: "select_file", path: "ws.java", ignoreWhitespace: true });
    expect(ws).toMatchObject({ type: "file_diff", scope: "turn", path: "ws.java", ignoreWhitespace: true, truncated: false });
    expect(ws.diff.hunks).toEqual([]);
    expect(ws.diff.newPath).toBe("ws.java");
    expect(ws.baseTree).toBe(plain.baseTree);
    expect(ws.endTree).toBe(plain.endTree);
    const mixed = await h.engine.request({ type: "select_file", path: "Svc.java", ignoreWhitespace: true });
    const changed = mixed.diff.hunks.flatMap((hk) => hk.lines).filter((l) => l.kind === "add" || l.kind === "del").map((l) => l.text);
    expect(changed).toEqual(["line 30", "line 30 CHANGED"]);
    const full = await h.engine.request({ type: "select_file", path: "Svc.java" });
    expect(full.diff.hunks.flatMap((hk) => hk.lines).filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["  line 10", "line 30 CHANGED"]);
  });

  it("file_image sends both sides of a changed png as base64; other files are refused", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await turn(h, dir, "new logo", { "logo.png": PNG_B, "Svc.java": svcAfter() });
    const img = await h.engine.request({ type: "file_image", path: "logo.png" });
    expect(img).toMatchObject({ type: "file_image", path: "logo.png", oldPath: null, mediaType: "image/png" });
    expect(Buffer.from(img.old!.dataBase64!, "base64").equals(PNG_A)).toBe(true);
    expect(Buffer.from(img.new!.dataBase64!, "base64").equals(PNG_B)).toBe(true);
    expect(img.new!.size).toBe(PNG_B.length);
    await expect(h.engine.request({ type: "file_image", path: "Svc.java" })).rejects.toThrow("not_an_image:Svc.java");
    await expect(h.engine.request({ type: "file_image", path: "ghost.png" })).rejects.toThrow("not_a_changed_file:ghost.png");
  });

  it("transcript_search {perChat: 3} gives each chat's three newest matches and counts the rest; without it one, as before", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    const chat = (await h.open(dir)).sessions.currentId!;
    const path = sessionTranscriptPath(join(dir, ".git"), chat);
    const rows = Array.from({ length: 5 }, (_, i) => JSON.stringify({ at: `2026-10-22T09:00:0${i}.000Z`, turn: i + 1, kind: i % 2 ? "assistant_text" : "user_message", text: `invoiceMapper ${i}` }));
    appendFileSync(path, [...rows, JSON.stringify({ at: "2026-10-22T09:01:00.000Z", turn: 6, kind: "tool_use", id: "x", name: "Read", input: { q: "invoiceMapper" } })].join("\n") + "\n");
    const one = await h.engine.request({ type: "transcript_search", query: "invoicemapper" });
    expect(one.matches).toHaveLength(1);
    expect(one.matches[0]).not.toHaveProperty("more");
    expect(one.matches[0]!.line).toBe("invoiceMapper 4");
    const three = await h.engine.request({ type: "transcript_search", query: "invoicemapper", perChat: 3 });
    expect(three.matches).toHaveLength(1);
    const m = three.matches[0]!;
    expect([m.sessionId, m.line, m.total]).toEqual([chat, "invoiceMapper 4", 5]);
    expect(m.more!.map((x) => [x.line, x.kind, x.turn])).toEqual([["invoiceMapper 3", "assistant_text", 4], ["invoiceMapper 2", "user_message", 3]]);
    expect(m.row).toBeGreaterThan(m.more![0]!.row);
  });
});

describe("review leftovers (§41.3) — helpers", () => {
  it("fileLinesOf splits like full_file (CRLF, the last empty line) and flags binary / large content", () => {
    expect(fileLinesOf(Buffer.from("a\r\nb\n"))).toEqual({ lines: ["a", "b"], isBinary: false, isTooLarge: false });
    expect(fileLinesOf(Buffer.from([0x50, 0x00, 0x41]))).toEqual({ lines: [], isBinary: true, isTooLarge: false });
    expect(fileLinesOf(Buffer.alloc(3 * 1024 * 1024, 0x61)).isTooLarge).toBe(true);
  });

  it("perChatOf clamps to 1–10 (1 when absent)", () => {
    expect([perChatOf(undefined), perChatOf(3), perChatOf(0), perChatOf(99), perChatOf("3")]).toEqual([1, 3, 1, 10, 1]);
  });

  it("imageMediaType knows png / jpg / jpeg / gif only", () => {
    expect(["a.PNG", "b.jpg", "c.jpeg", "d.gif", "e.svg", "f"].map(imageMediaType)).toEqual(["image/png", "image/jpeg", "image/jpeg", "image/gif", null, null]);
  });

  it("searchTranscriptMany: newest first, a JSON-escaped query still found, nothing → null", () => {
    const text = [JSON.stringify({ at: "t1", turn: 1, kind: "user_message", text: 'say "hi"' }), JSON.stringify({ at: "t2", turn: 2, kind: "assistant_text", text: 'said "hi" back' })].join("\n");
    const r = searchTranscriptMany(text, '"hi"', 3)!;
    expect([r.line, r.total, r.more.map((x) => x.line)]).toEqual(['said "hi" back', 2, ['say "hi"']]);
    expect(searchTranscriptMany(text, "absent", 3)).toBeNull();
  });

  it("prHeadContent fetches from GitHub without a local commit and drops content over 2 MB", async () => {
    expect((await prHeadContent(null, "abc1234", "a.txt", async () => Buffer.from("x\n")))?.toString()).toBe("x\n");
    expect(await prHeadContent(null, "abc1234", "a.txt", async () => Buffer.alloc(3 * 1024 * 1024))).toBeNull();
  });
});
