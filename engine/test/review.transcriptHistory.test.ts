import { describe, expect, it } from "vitest";
import type { TranscriptItem, TurnSummaryEvent } from "../src/protocol.js";
import {
  historyWhy,
  matchedLine,
  searchTranscriptText,
  SUMMARY_ROW_MAX_BYTES,
  SUMMARY_ROW_MAX_FILES,
  SUMMARY_ROW_TEXT_CHARS,
  summaryRow,
  transcriptWindow,
} from "../src/review/transcriptHistory.js";

/** MARK: wave4 w4-history — docs/PROTOCOL.md §38.3: paging, search, summary rows and the history why (pure parts). */
const row = (i: number, extra: Partial<TranscriptItem> = {}): string =>
  JSON.stringify({ at: `2026-10-22T10:00:${String(i).padStart(2, "0")}.000Z`, turn: Math.floor(i / 3) + 1, kind: "assistant_text", text: `answer ${i}`, ...extra });
const ndjson = (n: number): string => Array.from({ length: n }, (_, i) => row(i)).join("\n") + "\n";
const texts = (items: TranscriptItem[]) => items.map((r) => (r.kind === "assistant_text" ? r.text : r.kind));

describe("transcriptWindow (§38.3 paging)", () => {
  it("the end window is the last rows with the index of the first; pages before it reach row 0", () => {
    const text = ndjson(10);
    const last = transcriptWindow(text, null, 4);
    expect(texts(last.items)).toEqual(["answer 6", "answer 7", "answer 8", "answer 9"]);
    expect([last.start, last.end]).toEqual([6, 10]);
    const page = transcriptWindow(text, last.start, 4);
    expect(texts(page.items)).toEqual(["answer 2", "answer 3", "answer 4", "answer 5"]);
    expect(page.start).toBe(2);
    const first = transcriptWindow(text, page.start, 4);
    expect(texts(first.items)).toEqual(["answer 0", "answer 1"]);
    expect(first.start).toBe(0);
    expect(transcriptWindow(text, 0, 4)).toEqual({ items: [], start: 0, end: 0 });
  });

  it("a torn line keeps its index (skipped, never shifts the rows around it); an empty file has no rows", () => {
    const lines = ndjson(5).split("\n");
    lines[2] = '{"at":"torn';
    const w = transcriptWindow(lines.join("\n"), null, 10);
    expect(texts(w.items)).toEqual(["answer 0", "answer 1", "answer 3", "answer 4"]);
    expect(transcriptWindow(lines.join("\n"), 3, 1)).toMatchObject({ start: 1 });
    expect(transcriptWindow("", null, 200)).toEqual({ items: [], start: 0, end: 0 });
  });

  it("after a rotation (oldest rows dropped) beforeAt finds the row the client holds; once it is gone nothing older is left", () => {
    const full = ndjson(10).split("\n").filter(Boolean);
    const rotated = full.slice(4).join("\n") + "\n"; // rows 4…9 now at 0…5
    const at6 = JSON.parse(full[6]!).at as string;
    const w = transcriptWindow(rotated, 6, 3, at6);
    expect(texts(w.items)).toEqual(["answer 4", "answer 5"]);
    expect([w.start, w.end]).toEqual([0, 2]);
    const at2 = JSON.parse(full[2]!).at as string;
    expect(transcriptWindow(rotated, 2, 3, at2)).toEqual({ items: [], start: 0, end: 0 });
    // Not rotated: the row at `before` already carries the anchor.
    expect(texts(transcriptWindow(full.join("\n"), 6, 2, at6).items)).toEqual(["answer 4", "answer 5"]);
  });
});

describe("searchTranscriptText (§38.3)", () => {
  it("finds the newest user message or answer containing the query (case-insensitive) with its line", () => {
    const text = [
      row(0, { kind: "user_message", text: "SQL 을 고쳐줘" } as Partial<TranscriptItem>),
      row(1, { text: "첫 줄\nSELECT * FROM invoice WHERE id = ?\n끝" } as Partial<TranscriptItem>),
      row(2, { kind: "tool_use", id: "t1", name: "Bash", input: { command: "select now()" } } as unknown as Partial<TranscriptItem>),
      row(3, { text: "다른 답" } as Partial<TranscriptItem>),
    ].join("\n");
    expect(searchTranscriptText(text, "select")).toEqual({ row: 1, turn: 1, at: "2026-10-22T10:00:01.000Z", kind: "assistant_text", line: "SELECT * FROM invoice WHERE id = ?" });
    expect(searchTranscriptText(text, "  sql ")).toMatchObject({ row: 0, kind: "user_message", line: "SQL 을 고쳐줘" });
    expect(searchTranscriptText(text, "now()")).toBeNull(); // tool input is not the conversation
    expect(searchTranscriptText(text, "")).toBeNull();
    expect(searchTranscriptText(text, 'a "quoted"')).toBeNull();
  });

  it("a query JSON escapes still matches (no raw pre-check); a long line is cut around the match", () => {
    const text = row(0, { text: 'say "hi" there' } as Partial<TranscriptItem>);
    expect(searchTranscriptText(text, '"hi"')).toMatchObject({ row: 0, line: 'say "hi" there' });
    const long = `${"a".repeat(300)} needle ${"b".repeat(300)}`;
    const line = matchedLine(long, "needle")!;
    expect(line.length).toBeLessThanOrEqual(162);
    expect(line).toContain("needle");
    expect(line.startsWith("…") && line.endsWith("…")).toBe(true);
  });
});

function summary(files: number, extra: Partial<TurnSummaryEvent> = {}): TurnSummaryEvent {
  return {
    type: "turn_summary",
    turn: 3,
    files: Array.from({ length: files }, (_, i) => ({ path: `src/f${i}.ts`, status: "M" as const, state: "pending" as const, adds: 1, dels: 0, why: `because ${i}`, whyToolUseId: `t${i}`, tools: ["Edit"], toolUseIds: [`t${i}`] })),
    commands: [{ toolUseId: "b1", command: "npm test", isError: false, testOutcome: "pass" }],
    plan: null,
    review: { files, added: files, deleted: 0 },
    ...extra,
  };
}

describe("summaryRow (§38.3)", () => {
  it("keeps the event's fields without type / turn", () => {
    const r = summaryRow(summary(2));
    expect(r).not.toHaveProperty("type");
    expect(r).not.toHaveProperty("turn");
    expect(r.files.map((f) => [f.path, f.why])).toEqual([["src/f0.ts", "because 0"], ["src/f1.ts", "because 1"]]);
    expect(r.commands).toEqual([{ toolUseId: "b1", command: "npm test", isError: false, testOutcome: "pass" }]);
    expect(r.review).toEqual({ files: 2, added: 2, deleted: 0 });
    expect(r.truncated).toBeUndefined();
  });

  it("bounds the lists, the texts and the whole row (truncated)", () => {
    const big = summary(SUMMARY_ROW_MAX_FILES + 20);
    big.files[0]!.why = "x".repeat(SUMMARY_ROW_TEXT_CHARS * 3);
    big.files[0]!.whyDetail = { text: "y".repeat(SUMMARY_ROW_TEXT_CHARS * 3), source: "same_message", delegation: "z".repeat(SUMMARY_ROW_TEXT_CHARS * 2) };
    const r = summaryRow(big);
    expect(r.truncated).toBe(true);
    expect(r.files.length).toBeLessThanOrEqual(SUMMARY_ROW_MAX_FILES);
    expect(r.files[0]!.why!.length).toBe(SUMMARY_ROW_TEXT_CHARS);
    expect(r.files[0]!.whyDetail!.text!.length).toBe(SUMMARY_ROW_TEXT_CHARS);
    expect(r.files[0]!.whyDetail!.delegation!.length).toBe(SUMMARY_ROW_TEXT_CHARS);
    const heavy = summary(250);
    for (const f of heavy.files) f.why = "w".repeat(SUMMARY_ROW_TEXT_CHARS);
    const h = summaryRow(heavy);
    expect(Buffer.byteLength(JSON.stringify(h))).toBeLessThanOrEqual(SUMMARY_ROW_MAX_BYTES);
    expect(h.truncated).toBe(true);
    expect(h.files.length).toBeGreaterThan(0);
  });
});

describe("historyWhy (§38.3)", () => {
  const rows = (items: object[]): TranscriptItem[] => items.map((r) => ({ at: "2026-10-22T10:00:00.000Z", ...r }) as TranscriptItem);

  it("prefers the newest summary row of the round's turns, else the first tool call with a rationale; null when none", () => {
    const r = rows([
      { turn: 1, kind: "tool_use", id: "e1", name: "Edit", input: {}, rationale: "Fix the mapper." },
      { turn: 1, kind: "turn_summary", files: [{ path: "a.xml", status: "M", state: "pending", adds: 1, dels: 1, why: "Fix the mapper.", whyToolUseId: "e1", tools: ["Edit"], toolUseIds: ["e1"], whyDetail: { text: "Fix the mapper.", source: "same_message", toolUseId: "e1" } }], commands: [], plan: null },
      { turn: 2, kind: "turn_summary", files: [{ path: "a.xml", status: "M", state: "pending", adds: 1, dels: 1, why: "Redo it.", whyToolUseId: "e2", tools: ["Edit"], toolUseIds: ["e1", "e2"] }], commands: [], plan: null },
      { turn: 5, kind: "turn_summary", files: [{ path: "a.xml", status: "M", state: "pending", adds: 1, dels: 1, why: "Another round.", whyToolUseId: "e9", tools: ["Edit"], toolUseIds: ["e9"] }], commands: [], plan: null },
    ]);
    expect(historyWhy(r, { turns: [1, 2] }, { path: "a.xml", toolUseIds: ["e1", "e2"] })).toEqual({ text: "Redo it.", source: "same_message", toolUseId: "e2", turn: 2 });
    expect(historyWhy(r, { turns: [1] }, { path: "a.xml", toolUseIds: ["e1"] })).toEqual({ text: "Fix the mapper.", source: "same_message", toolUseId: "e1", turn: 1 });
    // No summary row of that round (an older chat): the tool call's own rationale.
    expect(historyWhy(r.slice(0, 1), { turns: [1] }, { path: "a.xml", toolUseIds: ["e1"] })).toEqual({ text: "Fix the mapper.", source: "same_message", toolUseId: "e1", turn: 1 });
    expect(historyWhy(r, { turns: [7] }, { path: "b.txt", toolUseIds: [] })).toBeNull();
  });
});
