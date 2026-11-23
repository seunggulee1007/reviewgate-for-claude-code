/**
 * §62 on Windows — what a Go to Definition / Find References does with the engine's replies: one candidate opens (a changed
 * file in the review's diff, another one in the project file view), several make the peek list, none the notice; a newer
 * request's reply wins; Back / Forward return to where each jump started.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChangedFileState, DefinitionCandidate, EngineCommand } from "@reviewgate/engine";

type Reply = Record<string, unknown>;
let replies: Map<string, (cmd: EngineCommand) => Reply | Promise<Reply>>;
let sent: EngineCommand[];

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    setTimeout,
    clearTimeout,
    rg: {
      platform: "win32",
      sep: "\\",
      send: () => undefined,
      setUI: async () => undefined,
      onEvent: () => () => undefined,
      request: async () => ({}),
      requestDetailed: async (cmd: EngineCommand) => {
        sent.push(cmd);
        const f = replies.get(cmd.type);
        return f ? { ok: true, reply: await f(cmd) } : { ok: false, error: "unknown_command", code: "unknown_command" };
      },
    },
  };
  const { useStore } = await import("../store");
  const { useNav, currentLocation } = await import("./navStore");
  return { useStore, useNav, currentLocation };
}
let m: Awaited<ReturnType<typeof load>>;
beforeAll(async () => {
  replies = new Map();
  sent = [];
  m = await load();
});

const file = (path: string): ChangedFileState => ({ path, oldPath: null, status: "M", added: 1, deleted: 0, isBinary: false, tools: ["Edit"], toolUseIds: [], state: "pending", noteCount: 0, origin: "tool" });
const cand = (path: string, line: number, kind: DefinitionCandidate["kind"] = "class"): DefinitionCandidate => ({ path, line, column: 14, kind, preview: `class X ${path}`, score: 100 });
const flush = () => new Promise((r) => setTimeout(r, 0));
const at = { x: 10, y: 20 };

beforeEach(() => {
  replies = new Map();
  sent = [];
  m.useNav.getState().reset();
  const s = m.useStore.getState();
  m.useStore.setState({ tab: "changes", historyView: null, liveView: null, selectedPath: "src/A.java", state: { ...s.state, changedFiles: [file("src/A.java"), file("src/B.java")] } });
  replies.set("project_file", (cmd) => ({ type: "project_file", path: (cmd as { path: string }).path, lines: ["package x;", "", "class C {}"], isBinary: false, truncated: false, size: 30 }));
});

describe("Go to Definition (§62, Windows)", () => {
  it("one candidate in a changed file: the review's diff at that line, and Back returns to the click", async () => {
    replies.set("find_definition", () => ({ type: "definitions", symbol: "B", candidates: [cand("src/B.java", 7)], truncated: false }));
    m.useNav.getState().goToDefinition({ symbol: "B", fromPath: "src/A.java", line: 3, ...at, from: { kind: "review", path: "src/A.java", line: 3 } });
    await flush();
    expect(sent[0]).toEqual({ type: "find_definition", symbol: "B", fromPath: "src/A.java", line: 3 });
    const nav = m.useNav.getState();
    expect(nav.peek).toBeNull();
    expect(nav.file).toBeNull();
    expect(nav.reveal).toMatchObject({ path: "src/B.java", line: 7, symbol: "B" });
    expect(m.useStore.getState().selectedPath).toBe("src/B.java");
    expect(nav.history.back).toEqual([{ kind: "review", path: "src/A.java", line: 3 }]);

    m.useNav.getState().revealDone(nav.reveal!.seq, true);
    m.useNav.getState().back();
    expect(m.useStore.getState().selectedPath).toBe("src/A.java");
    expect(m.useNav.getState().reveal).toMatchObject({ path: "src/A.java", line: 3 });
    expect(m.useNav.getState().history.forward).toEqual([{ kind: "review", path: "src/B.java", line: 7 }]);
  });

  it("§65.6: sends the click's column and receiver (each only when known)", async () => {
    replies.set("find_definition", () => ({ type: "definitions", symbol: "refresh", candidates: [], truncated: false }));
    m.useNav.getState().goToDefinition({ symbol: "refresh", fromPath: "src/A.ts", line: 4, column: 15, receiver: "gate", ...at, from: null });
    m.useNav.getState().goToDefinition({ symbol: "refresh", fromPath: "src/A.ts", line: 4, column: 0, ...at, from: null });
    await flush();
    expect(sent).toEqual([
      { type: "find_definition", symbol: "refresh", fromPath: "src/A.ts", line: 4, column: 15, receiver: "gate" },
      { type: "find_definition", symbol: "refresh", fromPath: "src/A.ts", line: 4 },
    ]);
  });

  it("one candidate outside the review: the project file view (project_file), read-only", async () => {
    replies.set("find_definition", () => ({ type: "definitions", symbol: "C", candidates: [cand("lib/C.java", 3)], truncated: false }));
    m.useNav.getState().goToDefinition({ symbol: "C", fromPath: "src/A.java", line: 2, ...at, from: { kind: "review", path: "src/A.java", line: 2 } });
    await flush();
    await flush();
    const f = m.useNav.getState().file!;
    expect(f).toMatchObject({ path: "lib/C.java", line: 3, column: 14, symbol: "C", error: null });
    expect(f.data?.lines).toHaveLength(3);
    expect(sent.map((c) => c.type)).toEqual(["find_definition", "project_file"]);
    expect(m.currentLocation()).toEqual({ kind: "file", path: "lib/C.java", line: 3, column: 1 });
    // A file picked in the Changes list takes the pane back.
    m.useStore.getState().selectFile("src/B.java");
    expect(m.useNav.getState().file).toBeNull();
  });

  it("a line the review's diff does not show opens the file view instead", () => {
    m.useNav.getState().openTarget({ path: "src/B.java", line: 400, column: 1 }, null);
    const r = m.useNav.getState().reveal!;
    m.useNav.getState().revealDone(r.seq, false);
    expect(m.useNav.getState().file).toMatchObject({ path: "src/B.java", line: 400 });
  });

  it("several candidates: the peek list, the first selected; a row opens and is remembered", async () => {
    replies.set("find_definition", () => ({ type: "definitions", symbol: "total", candidates: [cand("a/X.kt", 1, "function"), cand("b/Y.kt", 2, "property")], truncated: true, timedOut: true }));
    m.useNav.getState().goToDefinition({ symbol: "total", ...at, from: { kind: "review", path: "src/A.java", line: 9 } });
    expect(m.useNav.getState().peek).toMatchObject({ loading: true, symbol: "total" });
    await flush();
    const p = m.useNav.getState().peek!;
    expect(p).toMatchObject({ loading: false, selected: 0, truncated: true, timedOut: true });
    expect(p.rows.map((r) => [r.name, r.folder, r.line, r.kind])).toEqual([
      ["X.kt", "a", 1, "function"],
      ["Y.kt", "b", 2, "property"],
    ]);
    m.useNav.getState().openTarget({ ...p.rows[1]!, symbol: p.symbol }, p.from);
    expect(m.useNav.getState().peek).toBeNull();
    expect(m.useNav.getState().file).toMatchObject({ path: "b/Y.kt", line: 2 });
    expect(m.useNav.getState().history.back).toEqual([{ kind: "review", path: "src/A.java", line: 9 }]);
  });

  it("no candidate: the notice, and Find in Project / Find References fill the panel", async () => {
    replies.set("find_definition", () => ({ type: "definitions", symbol: "nope", candidates: [], truncated: false }));
    replies.set("project_search", () => ({ type: "project_search", query: "nope", matches: [{ path: "a.js", line: 2, text: "  nope();" }, { path: "b.js", line: 5, text: "x = nope" }], truncated: false }));
    replies.set("find_references", () => ({ type: "references", symbol: "nope", hits: [{ path: "a.js", line: 2, column: 3, preview: "nope();", kind: "function" }], files: 1, truncated: true }));
    m.useNav.getState().goToDefinition({ symbol: "nope", ...at, from: null });
    await flush();
    expect(m.useNav.getState().peek).toMatchObject({ loading: false, rows: [], error: null });
    m.useNav.getState().findInProject("nope");
    await flush();
    expect(sent[sent.length - 1]).toEqual({ type: "project_search", query: "nope", wholeWord: true, caseSensitive: true });
    expect(m.useNav.getState().peek).toBeNull();
    expect(m.useNav.getState().refs).toMatchObject({ mode: "search", files: 2, loading: false });
    m.useNav.getState().findReferences({ symbol: "nope", fromPath: "a.js" });
    await flush();
    expect(m.useNav.getState().refs).toMatchObject({ mode: "references", files: 1, truncated: true, rows: [{ path: "a.js", line: 2, column: 3, preview: "nope();", kind: "function" }] });
  });

  it("a newer request's reply replaces an older one's (the older reply is dropped)", async () => {
    let releaseFirst: () => void = () => undefined;
    replies.set("find_definition", (cmd) => {
      const symbol = (cmd as { symbol: string }).symbol;
      const reply = { type: "definitions", symbol, candidates: [cand(`${symbol}1.java`, 1), cand(`${symbol}2.java`, 2)], truncated: false };
      return symbol === "First" ? new Promise((r) => (releaseFirst = () => r(reply))) : reply;
    });
    m.useNav.getState().goToDefinition({ symbol: "First", ...at, from: null });
    m.useNav.getState().goToDefinition({ symbol: "Second", ...at, from: null });
    await flush();
    releaseFirst();
    await flush();
    expect(m.useNav.getState().peek?.symbol).toBe("Second");
    expect(m.useNav.getState().peek?.rows[0]?.path).toBe("Second1.java");
  });

  it("a refusal is said in the peek; an unsendable symbol is never sent", async () => {
    m.useNav.getState().goToDefinition({ symbol: "x", ...at, from: null });
    await flush();
    expect(m.useNav.getState().peek?.error).toMatch(/update ReviewGate/);
    sent = [];
    m.useNav.getState().goToDefinition({ symbol: "a b", ...at, from: null });
    expect(sent).toEqual([]);
  });

  it("Back from the History / PR panes' jumps goes back to that pane", () => {
    m.useNav.getState().openTarget({ path: "lib/C.java", line: 1, column: 1 }, { kind: "pane", pane: "prs" });
    m.useNav.getState().back();
    expect(m.useNav.getState().file).toBeNull();
    expect(m.useStore.getState().tab).toBe("prs");
  });

  it("§65.8 peek: the band under the line, the first preview asked; another candidate asks once, a stale preview is dropped", async () => {
    const { useBandSlot } = await import("./bandSlot");
    replies.set("find_definition", () => ({ type: "definitions", symbol: "find", candidates: [cand("a/Repo.kt", 10, "method"), cand("b/Other.kt", 20, "method")], truncated: false }));
    const asked: number[] = [];
    let release: (() => void) | null = null;
    replies.set("definition_preview", (cmd) => {
      const line = (cmd as { line: number }).line;
      asked.push(line);
      const reply = { type: "definition_preview", path: (cmd as { path: string }).path, line, startLine: line - 1, lines: ["/** doc */", "fun find()"], totalLines: 99, language: "kotlin", truncated: false };
      return asked.length === 1 ? new Promise((r) => (release = () => r(reply))) : reply;
    });
    const anchor = { kind: "dom" as const, path: "src/A.kt", rowId: 7 };
    m.useNav.getState().peekDefinition({ symbol: "find", fromPath: "src/A.kt", line: 3, column: 12, receiver: "repo", anchor, from: { kind: "review", path: "src/A.kt", line: 3 } });
    expect(useBandSlot.getState().anchor).toEqual(anchor);
    expect(m.useNav.getState().band).toMatchObject({ loading: true, symbol: "find" });
    await flush();
    expect(sent[0]).toEqual({ type: "find_definition", symbol: "find", fromPath: "src/A.kt", line: 3, column: 12, receiver: "repo" });
    expect(m.useNav.getState().band).toMatchObject({ loading: false, selected: 0 });
    expect(m.useNav.getState().band!.rows.map((r) => r.path)).toEqual(["a/Repo.kt", "b/Other.kt"]);
    // the second candidate while the first preview is still on its way
    m.useNav.getState().setBandSelected(1);
    await flush();
    expect(asked).toEqual([10, 20]);
    expect(m.useNav.getState().band!.previews[1]).toMatchObject({ line: 20 });
    // a newer peek drops the first band's late preview
    m.useNav.getState().peekDefinition({ symbol: "find", anchor: { kind: "dom", path: "src/A.kt", rowId: 9 }, from: null });
    release!();
    await flush();
    const b = m.useNav.getState().band!;
    expect(b.anchor).toEqual({ kind: "dom", path: "src/A.kt", rowId: 9 });
    expect(b.previews[1]).toBeUndefined();
    // back to the first: asked again only because it never arrived for this band; then cached
    m.useNav.getState().setBandSelected(1);
    m.useNav.getState().setBandSelected(0);
    await flush();
    const before = asked.length;
    m.useNav.getState().setBandSelected(1);
    m.useNav.getState().setBandSelected(0);
    expect(asked.length).toBe(before);
  });

  it("§65.8 peek: Open goes to the candidate (the band closes and Back returns); another file closes the band", async () => {
    const { useBandSlot } = await import("./bandSlot");
    replies.set("find_definition", () => ({ type: "definitions", symbol: "C", candidates: [cand("lib/C.java", 3)], truncated: false }));
    replies.set("definition_preview", () => ({ type: "definition_preview", path: "lib/C.java", line: 3, startLine: 3, lines: ["class C {}"], totalLines: 3, language: "java", truncated: false }));
    m.useNav.getState().peekDefinition({ symbol: "C", anchor: { kind: "dom", path: "src/A.java", rowId: 1 }, from: { kind: "review", path: "src/A.java", line: 2 } });
    await flush();
    expect(m.useNav.getState().band?.rows).toHaveLength(1); // one candidate stays in the band — peek never jumps by itself
    m.useNav.getState().openBandSelected();
    expect(m.useNav.getState().band).toBeNull();
    expect(useBandSlot.getState().anchor).toBeNull();
    expect(m.useNav.getState().file).toMatchObject({ path: "lib/C.java", line: 3 });
    expect(m.useNav.getState().history.back).toEqual([{ kind: "review", path: "src/A.java", line: 2 }]);

    m.useNav.getState().closeFile();
    m.useNav.getState().peekDefinition({ symbol: "C", anchor: { kind: "dom", path: "src/A.java", rowId: 1 }, from: null });
    await flush();
    m.useStore.getState().selectFile("src/B.java");
    expect(m.useNav.getState().band).toBeNull();
  });
});
