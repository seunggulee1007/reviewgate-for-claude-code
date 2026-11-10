// MARK: wave6 w6-statusline — reading files a repository may have put there, and strings the Mac's JSONDecoder takes.
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeReadOrNull, safeReadText, wellFormed, wellFormedJson } from "../src/util/safeRead.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("safe reads", () => {
  it("a small regular file is read; a missing one is absent; a large one, a folder are not read", () => {
    const dir = makeTempDir("rg-safe");
    dirs.push(dir);
    writeFileSync(join(dir, "a.json"), '{"a":1}');
    writeFileSync(join(dir, "big.json"), "x".repeat(2048));
    mkdirSync(join(dir, "sub"));
    expect(safeReadText(join(dir, "a.json"))).toEqual({ text: '{"a":1}' });
    expect(safeReadText(join(dir, "nope.json"))).toEqual({ error: "absent" });
    expect(safeReadText(join(dir, "big.json"), 1024)).toEqual({ error: "too_large", detail: "2048" });
    expect(safeReadOrNull(join(dir, "big.json"), 1024)).toBeNull();
    expect(safeReadText(join(dir, "sub"))).toMatchObject({ error: expect.stringMatching(/not_file|unreadable/) });
    expect(safeReadOrNull(join(dir, "a.json", "deeper"))).toBeNull(); // ENOTDIR: absent
  });

  it.skipIf(process.platform === "win32")("a device or a FIFO is never read (no hang, no endless read); a link to a file is", () => {
    const dir = makeTempDir("rg-safe-dev");
    dirs.push(dir);
    symlinkSync("/dev/zero", join(dir, "zero.json"));
    execFileSync("mkfifo", [join(dir, "fifo.json")]);
    writeFileSync(join(dir, "real.json"), "{}");
    symlinkSync(join(dir, "real.json"), join(dir, "link.json"));
    expect(safeReadText(join(dir, "zero.json"))).toEqual({ error: "not_file" });
    expect(safeReadText(join(dir, "fifo.json"))).toEqual({ error: "not_file" });
    expect(safeReadText(join(dir, "link.json"))).toEqual({ text: "{}" });
  });
});

describe("well-formed strings", () => {
  it("a lone surrogate half becomes U+FFFD; a pair and plain text stay", () => {
    expect(wellFormed("a\ud800b")).toBe("a�b");
    expect(wellFormed("a\udc00")).toBe("a�");
    expect(wellFormed("\udc00\ud800")).toBe("��");
    expect(wellFormed("😀 ok")).toBe("😀 ok");
    expect(wellFormed("plain")).toBe("plain");
  });

  it("an NDJSON line: escaped lone halves become \\ufffd (Swift refuses the line for one); an escaped backslash before u stays", () => {
    const line = wellFormedJson(JSON.stringify({ a: "x\ud800y", b: "\udfff", c: "😀", d: "\\ud800 as text" }));
    expect(JSON.parse(line)).toEqual({ a: "x�y", b: "�", c: "😀", d: "\\ud800 as text" });
    expect(line).toContain("\\\\ud800 as text");
    const plain = JSON.stringify({ a: "nothing to do" });
    expect(wellFormedJson(plain)).toBe(plain);
  });
});
