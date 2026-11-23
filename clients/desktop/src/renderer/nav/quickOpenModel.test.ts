// §65.8 on Windows — the palettes' filtering glue: path:line, camel humps, the file's symbols ranked, bold runs, the index line.
import { describe, expect, it } from "vitest";
import type { DocumentSymbol } from "@reviewgate/engine";
import { boldParts, camelHumps, fileRows, filterDocumentSymbols, indexLine, matchName, parseFileQuery, subsequenceMarks, wordStarts } from "./quickOpenModel";

const sym = (name: string, line: number, depth = 1, container?: string): DocumentSymbol => ({ name, kind: "method", path: "src/Cart.kt", line, column: 5, depth, ...(container ? { container } : {}) });
const tt = (k: string, ...a: (string | number)[]) => k.replace(/\{(\d)\}/g, (_, i) => String(a[Number(i)]));

describe("Go to File's query", () => {
  it("splits path:line, keeps a path without a number", () => {
    expect(parseFileQuery("CartService.java:42")).toEqual({ query: "CartService.java", line: 42 });
    expect(parseFileQuery("  src/a.ts:7 ")).toEqual({ query: "src/a.ts", line: 7 });
    expect(parseFileQuery("CartService.java:")).toEqual({ query: "CartService.java" });
    expect(parseFileQuery("CartService")).toEqual({ query: "CartService" });
    expect(parseFileQuery("a.ts:0")).toEqual({ query: "a.ts" });
  });

  it("drops directories and marks the basename's letters (humps first, else in order)", () => {
    const rows = fileRows(
      [
        { path: "src/main/UserService.java", kind: "file", changed: true },
        { path: "src/main", kind: "dir" },
        { path: "web/user-list.vue", kind: "file" },
      ],
      "UsrSvc",
    );
    expect(rows.map((r) => [r.name, r.folder, r.changed])).toEqual([
      ["UserService.java", "src/main", true],
      ["user-list.vue", "web", false],
    ]);
    expect(rows[0]!.marks).toEqual([0, 1, 3, 4, 7, 9]);
    expect(fileRows([{ path: "a/b/cart.ts", kind: "file" }], "a/b/crt")[0]!.marks).toEqual([0, 2, 3]);
  });
});

describe("matching (the engine's way, client-side)", () => {
  it("camel humps: each part at a word start, in order, words may be skipped", () => {
    expect(wordStarts("NullPointerException")).toEqual([0, 4, 11]);
    expect(wordStarts("HTTPServer_impl")).toEqual([0, 4, 11]);
    expect(camelHumps("UserService", "UsrSvc")).toEqual([0, 1, 3, 4, 7, 9]);
    expect(camelHumps("userService", "uS")).toEqual([0, 4]);
    expect(camelHumps("NullPointerException", "NPE")).toEqual([0, 4, 11]);
    expect(camelHumps("CartRepositoryImpl", "CImpl")).toEqual([0, 14, 15, 16, 17]);
    expect(camelHumps("UserService", "SvcUsr")).toBeNull();
    expect(camelHumps("UserService", "user")).toBeNull(); // one part is not humps
  });

  it("ranks exact > prefix > humps > substring > subsequence; one letter is prefix / substring only", () => {
    const score = (n: string, q: string) => matchName(n, q)?.score ?? null;
    expect(score("total", "total")).toBe(1000);
    expect(score("totalPrice", "total")).toBeGreaterThan(score("TotalPrice", "total")!);
    expect(score("TotalPrice", "total")).toBeGreaterThan(score("userService", "uS")!);
    expect(score("userService", "uS")).toBeGreaterThan(score("subtotal", "total")!);
    expect(score("subtotal", "total")).toBeGreaterThan(score("tXoXtXaXl", "total")!);
    expect(score("abc", "x")).toBeNull();
    expect(score("fax", "x")).not.toBeNull();
    expect(matchName("getTotal", "Total")!.marks).toEqual([3, 4, 5, 6, 7]);
    expect(subsequenceMarks("CartService", "csv")).toEqual([0, 4, 7]);
  });

  it("filters the file's symbols: all in file order when empty, else best first", () => {
    const list = [sym("Cart", 1, 0), sym("add", 3, 1, "Cart"), sym("addAll", 7, 1, "Cart"), sym("total", 9, 1, "Cart"), sym("subTotal", 12, 1, "Cart")];
    expect(filterDocumentSymbols(list, "").map((s) => s.name)).toEqual(["Cart", "add", "addAll", "total", "subTotal"]);
    expect(filterDocumentSymbols(list, "tot").map((s) => s.name)).toEqual(["total", "subTotal"]);
    expect(filterDocumentSymbols(list, "add").map((s) => s.name)).toEqual(["add", "addAll"]);
    expect(filterDocumentSymbols(list, "aA").map((s) => [s.name, s.marks])).toEqual([["addAll", [0, 3]]]);
    expect(filterDocumentSymbols(list, "zz")).toEqual([]);
  });

  it("bold runs at the marks", () => {
    expect(boldParts("UserService", [0, 4])).toEqual([
      { text: "U", bold: true },
      { text: "ser", bold: false },
      { text: "S", bold: true },
      { text: "ervice", bold: false },
    ]);
    expect(boldParts("x", [])).toEqual([{ text: "x", bold: false }]);
  });
});

describe("the index line", () => {
  it("says Indexing… files / filesTotal while building, the error when it failed, nothing when ready", () => {
    expect(indexLine({ status: "building", files: 120, filesTotal: 1635, symbols: 0, truncated: false, builtAt: null }, tt)).toEqual({ text: "Indexing… 120 / 1635 files", failed: false });
    expect(indexLine({ status: "failed", files: 0, symbols: 0, truncated: false, builtAt: null, error: "fatal: not a git repository" }, tt)?.failed).toBe(true);
    expect(indexLine({ status: "ready", files: 9, symbols: 90, truncated: false, builtAt: "2026-11-23T00:00:00Z" }, tt)).toBeNull();
    expect(indexLine(undefined, tt)).toBeNull();
  });
});
