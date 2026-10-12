/** wave4 w4-input (polish-11): the Enter that confirms a Korean IME composition never runs a field's action. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isComposing, isEnter } from "./ime";

describe("isEnter / isComposing", () => {
  it("a plain Enter is an Enter", () => {
    expect(isEnter({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(true);
    expect(isEnter({ key: "Enter" })).toBe(true);
  });

  it("the Enter that confirms a composition is not (React event: nativeEvent.isComposing)", () => {
    expect(isEnter({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(false);
  });

  it("the macOS Chromium composition keydown (keyCode 229) is not", () => {
    expect(isEnter({ key: "Enter", keyCode: 229 })).toBe(false);
    expect(isEnter({ key: "Enter", nativeEvent: { keyCode: 229 } })).toBe(false);
  });

  it("a DOM keydown during composition is not", () => {
    expect(isEnter({ key: "Enter", isComposing: true, keyCode: 13 })).toBe(false);
  });

  it("other keys are never an Enter, and any key of a composition counts as composing", () => {
    expect(isEnter({ key: "Tab" })).toBe(false);
    expect(isComposing({ keyCode: 229 })).toBe(true);
    expect(isComposing({ isComposing: false, keyCode: 9 })).toBe(false);
  });
});

/** Every text field's Enter handler goes through the helper — a raw `e.key === "Enter"` would act on the IME's Enter. */
describe("no text field compares Enter itself", () => {
  const root = fileURLToPath(new URL("./components", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !name.includes(".test.") ? [path] : [];
    });
  // Buttons and rows (role="button") take no IME input; their Enter is a click.
  const notTextFields = new Set(["LiveChanges.tsx", "AgentBits.tsx"]);

  it("uses isEnter / isComposing in every component", () => {
    const offenders = files(root)
      .filter((path) => !notTextFields.has(path.split(/[\\/]/).pop()!))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        // A `switch (e.key)` is fine behind an early `if (isComposing(e)) return;`.
        const guarded = /if \(isComposing\(e\)\) return;/.test(source);
        return source
          .split("\n")
          .map((text, i) => ({ text, line: i + 1 }))
          .filter((l) => /\.key\s*[!=]==\s*"Enter"/.test(l.text) || (!guarded && /case\s+"Enter"/.test(l.text)))
          .map((l) => `${path.slice(root.length + 1)}:${l.line}`);
      });
    expect(offenders).toEqual([]);
  });
});
