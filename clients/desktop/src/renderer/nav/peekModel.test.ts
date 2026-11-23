// §65.8 on Windows — the peek band's pure parts: the Ctrl+click setting, the header, the marked definition line, the keys.
import { describe, expect, it } from "vitest";
import type { DefinitionCandidate } from "@reviewgate/engine";
import { bandKey, bandLines, bandRows, bandScrollLine, bandTitle, ctrlClickAction } from "./peekModel";

const cand = (path: string, line: number, container?: string): DefinitionCandidate => ({ path, line, column: 5, kind: "method", preview: "fun find()", score: 100, ...(container ? { container } : {}) });

describe("the peek band (§65.8)", () => {
  it("Ctrl+click peeks unless Settings says go to", () => {
    expect(ctrlClickAction(undefined)).toBe("peek");
    expect(ctrlClickAction("peek")).toBe("peek");
    expect(ctrlClickAction("jump")).toBe("jump");
    expect(ctrlClickAction("other")).toBe("peek");
  });

  it("heads the band with File:line — Container.member, the preview's symbol first", () => {
    const [row] = bandRows([cand("src/cart/CartRepository.kt", 42, "CartRepository")]);
    expect(row).toMatchObject({ name: "CartRepository.kt", folder: "src/cart", container: "CartRepository" });
    expect(bandTitle(row!, { name: "find", kind: "method", path: row!.path, line: 42, column: 9, container: "CartRepository.Companion" }, "find")).toBe("CartRepository.kt:42 — CartRepository.Companion.find");
    expect(bandTitle(row!, undefined, "find")).toBe("CartRepository.kt:42 — CartRepository.find");
    const [top] = bandRows([cand("util.ts", 3)]);
    expect(bandTitle(top!, { name: "slug", kind: "function", path: "util.ts", line: 3, column: 17 }, "slug")).toBe("util.ts:3 — slug");
  });

  it("numbers the preview's lines and marks the definition line; scrolls to 3 lines above it", () => {
    const lines = bandLines({ startLine: 38, line: 42, lines: ["/**", " * Finds.", " */", "@Query", "fun find() {", "}"] });
    expect(lines.map((l) => l.no)).toEqual([38, 39, 40, 41, 42, 43]);
    expect(lines.filter((l) => l.target).map((l) => l.text)).toEqual(["fun find() {"]);
    expect(bandScrollLine(lines)).toBe(1);
    expect(bandScrollLine(bandLines({ startLine: 1, line: 1, lines: ["class A"] }))).toBe(0);
  });

  it("↑ / ↓ switch the candidate (wrapping), Enter opens, Esc closes — one candidate takes no arrows", () => {
    expect(bandKey("ArrowDown", 0, 3)).toEqual({ kind: "select", index: 1 });
    expect(bandKey("ArrowDown", 2, 3)).toEqual({ kind: "select", index: 0 });
    expect(bandKey("ArrowUp", 0, 3)).toEqual({ kind: "select", index: 2 });
    expect(bandKey("Enter", 1, 3)).toEqual({ kind: "open" });
    expect(bandKey("Escape", 0, 0)).toEqual({ kind: "close" });
    expect(bandKey("ArrowDown", 0, 1)).toBeNull();
    expect(bandKey("Enter", 0, 0)).toBeNull();
    expect(bandKey("a", 0, 3)).toBeNull();
  });
});
