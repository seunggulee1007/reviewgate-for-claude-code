import { describe, expect, it } from "vitest";
import { MINI_MAX_LINES, WRITE_PREVIEW_LINES, miniDiffOf } from "./miniDiff";

describe("miniDiffOf (the chat's Edit / MultiEdit / Write rows, from tool_use.input)", () => {
  it("an Edit of one line: the del / add pair with the changed word marked", () => {
    expect(miniDiffOf("Edit", { file_path: "/p/A.java", old_string: "return a;", new_string: "return b;" })).toEqual({
      lines: [
        { kind: "del", text: "return a;", segments: [[7, 8]] },
        { kind: "add", text: "return b;", segments: [[7, 8]] },
      ],
      added: 1,
      deleted: 1,
      hidden: 0,
      write: false,
    });
  });

  it("the unchanged lines of the edit's own text stay as context", () => {
    const d = miniDiffOf("Edit", { old_string: "a();\nb();\nc();", new_string: "a();\nbb();\nc();\nd();" })!;
    expect(d.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["context:a();", "del:b();", "add:bb();", "context:c();", "add:d();"]);
    expect([d.added, d.deleted]).toEqual([2, 1]);
  });

  it("a MultiEdit lists its edits in order with a gap row between them", () => {
    const d = miniDiffOf("MultiEdit", { edits: [{ old_string: "x = 1", new_string: "x = 2" }, { old_string: "y", new_string: "z" }, { junk: true }] })!;
    expect(d.lines.map((l) => l.kind)).toEqual(["del", "add", "gap", "del", "add"]);
    expect([d.added, d.deleted]).toEqual([2, 2]);
  });

  it("a Write shows its first lines as added (the old content is not in the call)", () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const d = miniDiffOf("Write", { file_path: "/p/new.ts", content })!;
    expect(d.lines).toHaveLength(WRITE_PREVIEW_LINES);
    expect(d.lines[0]).toEqual({ kind: "add", text: "line 1" });
    expect(d).toMatchObject({ added: 30, deleted: 0, hidden: 10, write: true });
    expect(miniDiffOf("Write", { content: "" })).toMatchObject({ lines: [], added: 0, hidden: 0 });
  });

  it("long edits are cut at MINI_MAX_LINES rows (the rest counted); huge inputs only count", () => {
    const old = Array.from({ length: 50 }, (_, i) => `o${i}`).join("\n");
    const neu = Array.from({ length: 50 }, (_, i) => `n${i}`).join("\n");
    const d = miniDiffOf("Edit", { old_string: old, new_string: neu })!;
    expect(d.lines).toHaveLength(MINI_MAX_LINES);
    expect(d).toMatchObject({ added: 50, deleted: 50, hidden: 100 - MINI_MAX_LINES });
    const huge = "x\n".repeat(150_000);
    expect(miniDiffOf("Edit", { old_string: huge, new_string: "y" })).toMatchObject({ lines: [], deleted: 150_000, added: 1 });
  });

  it("other tools and unusable inputs have no mini diff", () => {
    expect(miniDiffOf("Bash", { command: "ls" })).toBeNull();
    expect(miniDiffOf("Edit", { old_string: 3 })).toBeNull();
    expect(miniDiffOf("MultiEdit", { edits: "nope" })).toBeNull();
    expect(miniDiffOf("Write", {})).toBeNull();
  });
});
