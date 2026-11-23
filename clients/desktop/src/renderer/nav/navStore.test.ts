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
});
