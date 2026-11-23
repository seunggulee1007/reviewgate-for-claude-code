import { describe, expect, it } from "vitest";
import type { DefinitionCandidate } from "@reviewgate/engine";
import { EMPTY_HISTORY, HISTORY_LIMIT, goBack, goForward, groupByFile, markSymbol, peekKey, peekRows, pushHistory, searchRows, searchedWord, type NavLocation } from "./navModel";

const review = (path: string, line: number): NavLocation => ({ kind: "review", path, line });
const file = (path: string, line: number): NavLocation => ({ kind: "file", path, line, column: 1 });

describe("Back / Forward (§62 history, client-side)", () => {
  it("goes back to where each jump started and forward again", () => {
    let h = pushHistory(EMPTY_HISTORY, review("A.java", 10)); // A:10 → B:3
    h = pushHistory(h, file("B.java", 3)); // B:3 → C:7
    const b1 = goBack(h, file("C.java", 7))!;
    expect(b1.to).toEqual(file("B.java", 3));
    const b2 = goBack(b1.history, b1.to)!;
    expect(b2.to).toEqual(review("A.java", 10));
    expect(goBack(b2.history, b2.to)).toBeNull();
    const f1 = goForward(b2.history, b2.to)!;
    expect(f1.to).toEqual(file("B.java", 3));
    const f2 = goForward(f1.history, f1.to)!;
    expect(f2.to).toEqual(file("C.java", 7));
    expect(goForward(f2.history, f2.to)).toBeNull();
  });

  it("drops the forward steps on a new jump, keeps one entry for the same place twice, and at most the limit", () => {
    let h = pushHistory(EMPTY_HISTORY, review("A.java", 1));
    h = goBack(h, file("B.java", 2))!.history;
    expect(h.forward).toHaveLength(1);
    h = pushHistory(h, review("A.java", 1));
    expect(h.forward).toEqual([]);
    h = pushHistory(h, review("A.java", 1));
    expect(h.back).toEqual([review("A.java", 1)]);
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) h = pushHistory(h, file("X.java", i + 1));
    expect(h.back).toHaveLength(HISTORY_LIMIT);
    expect(h.back[h.back.length - 1]).toEqual(file("X.java", HISTORY_LIMIT + 10));
  });

  it("remembers another pane (History, PRs) as a place too", () => {
    const h = pushHistory(EMPTY_HISTORY, { kind: "pane", pane: "prs" });
    expect(goBack(h, file("B.java", 2))!.to).toEqual({ kind: "pane", pane: "prs" });
  });
});

describe("the peek list", () => {
  const cands: DefinitionCandidate[] = [
    { path: "src/main/java/com/acme/CartService.java", line: 14, column: 14, kind: "class", preview: "public class CartService {", score: 170 },
    { path: "Root.kt", line: 3, column: 7, kind: "function", preview: "fun total() = 1", score: 100 },
  ];

  it("shows the file name, folder, line and kind, best first", () => {
    expect(peekRows(cands)).toEqual([
      { path: cands[0]!.path, name: "CartService.java", folder: "src/main/java/com/acme", line: 14, column: 14, kind: "class", preview: "public class CartService {" },
      { path: "Root.kt", name: "Root.kt", folder: "", line: 3, column: 7, kind: "function", preview: "fun total() = 1" },
    ]);
  });

  it("moves with ↑ ↓ (wrapping), opens with Enter, closes with Esc", () => {
    expect(peekKey("ArrowDown", 0, 3)).toEqual({ kind: "select", index: 1 });
    expect(peekKey("ArrowDown", 2, 3)).toEqual({ kind: "select", index: 0 });
    expect(peekKey("ArrowUp", 0, 3)).toEqual({ kind: "select", index: 2 });
    expect(peekKey("Home", 2, 3)).toEqual({ kind: "select", index: 0 });
    expect(peekKey("End", 0, 3)).toEqual({ kind: "select", index: 2 });
    expect(peekKey("Enter", 1, 3)).toEqual({ kind: "open", index: 1 });
    expect(peekKey("Escape", 1, 3)).toEqual({ kind: "close" });
    expect(peekKey("a", 1, 3)).toBeNull();
    expect(peekKey("Enter", 0, 0)).toBeNull();
    expect(peekKey("Escape", 0, 0)).toEqual({ kind: "close" });
  });
});

describe("references", () => {
  it("groups the hits by file in the order received", () => {
    const groups = groupByFile([
      { path: "a/B.java", line: 3, column: 1, preview: "x" },
      { path: "C.java", line: 1, column: 1, preview: "y", kind: "class" },
      { path: "a/B.java", line: 9, column: 1, preview: "z" },
    ]);
    expect(groups.map((g) => [g.name, g.folder, g.rows.map((r) => r.line)])).toEqual([
      ["B.java", "a", [3, 9]],
      ["C.java", "", [1]],
    ]);
  });

  it("turns Find in Project matches into rows at the word's column", () => {
    expect(searchRows([{ path: "A.java", line: 4, text: "    int totalCount = total();" }], "total")).toEqual([
      { path: "A.java", line: 4, column: 22, preview: "int totalCount = total();" },
    ]);
  });
});

describe("markSymbol", () => {
  it("marks whole-word occurrences only", () => {
    expect(markSymbol("total = subtotal + total", "total")).toEqual([
      { text: "total", mark: true },
      { text: " = subtotal + ", mark: false },
      { text: "total", mark: true },
    ]);
  });

  it("marks the searched part of a qualified name, a tag or a path", () => {
    expect(searchedWord("com.acme.CartService")).toBe("CartService");
    expect(searchedWord("ui:panel")).toBe("panel");
    expect(searchedWord("/WEB-INF/views/row.jspf")).toBe("row.jspf");
    expect(searchedWord("my-widget")).toBe("my-widget");
    expect(markSymbol("<my-widget />", "my-widget").filter((p) => p.mark).map((p) => p.text)).toEqual(["my-widget"]);
    expect(markSymbol("nothing here", "Cart")).toEqual([{ text: "nothing here", mark: false }]);
  });
});
