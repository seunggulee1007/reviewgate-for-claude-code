import { realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lineWindow, PROJECT_FILE_MAX_BYTES, PROJECT_FILE_MAX_LINES, PROJECT_SEARCH_LINE_MAX, searchProject } from "../src/files/browse.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §47: `project_file` / `project_search` — any file of the project, read-only. */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-browse"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, ".gitignore", "build/\n");
  write(dir, "src/main/java/CartService.java", "class CartService {\n  void cartId() {}\n  // 장바구니 조회\n}\n");
  write(dir, "src/main/java/Cart.java", "class Cart {\r\n  String cart;\r\n}\r\n");
  write(dir, "README.md", "Cart docs\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  write(dir, "notes/untracked.txt", "cart in an untracked file\n");
  write(dir, "build/out.txt", "cart in an ignored file\n");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
async function opened(): Promise<{ h: Harness; dir: string }> {
  const dir = track(makeRepo());
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  return { h, dir };
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("§47 project_file", () => {
  it("reads tracked and untracked files as lines, CRLF split, the last empty line dropped", async () => {
    const { h } = await opened();
    const r = await h.engine.request({ type: "project_file", path: "src/main/java/CartService.java" });
    expect(r).toMatchObject({ type: "project_file", path: "src/main/java/CartService.java", isBinary: false, truncated: false });
    expect(r.lines).toEqual(["class CartService {", "  void cartId() {}", "  // 장바구니 조회", "}"]);
    expect((await h.engine.request({ type: "project_file", path: "src/main/java/Cart.java" })).lines).toEqual(["class Cart {", "  String cart;", "}"]);
    expect((await h.engine.request({ type: "project_file", path: "notes/untracked.txt" })).lines).toEqual(["cart in an untracked file"]);
  });

  it("refuses paths outside the repository, under .git, directories and missing files", async () => {
    const { h, dir } = await opened();
    const outside = track(realpathSync(makeTempDir("rg-browse-out")));
    write(outside, "secret.txt", "secret\n");
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    await expect(h.engine.request({ type: "project_file", path: "../x" })).rejects.toThrow(/invalid_path/);
    await expect(h.engine.request({ type: "project_file", path: "/etc/hosts" })).rejects.toThrow(/invalid_path/);
    await expect(h.engine.request({ type: "project_file", path: ".git/config" })).rejects.toThrow(/invalid_path/);
    await expect(h.engine.request({ type: "project_file", path: "link.txt" })).rejects.toThrow(/invalid_path/);
    await expect(h.engine.request({ type: "project_file", path: "src/main" })).rejects.toThrow(/not_a_file/);
    await expect(h.engine.request({ type: "project_file", path: "nope.txt" })).rejects.toThrow(/file_not_found/);
  });

  it("sends at most 20 000 lines (truncated) and no lines of a binary file", async () => {
    const { h, dir } = await opened();
    write(dir, "big.txt", Array.from({ length: PROJECT_FILE_MAX_LINES + 5 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    write(dir, "blob.bin", Buffer.from([1, 2, 0, 3]));
    const big = await h.engine.request({ type: "project_file", path: "big.txt" });
    expect(big.lines).toHaveLength(PROJECT_FILE_MAX_LINES);
    expect(big.lines.at(-1)).toBe(`line ${PROJECT_FILE_MAX_LINES}`);
    expect(big.truncated).toBe(true);
    expect(await h.engine.request({ type: "project_file", path: "blob.bin" })).toMatchObject({ lines: [], isBinary: true, size: 4 });
  });

  it("a file past the byte cap without a newline in it (a minified bundle) shows what was read, not an empty file", async () => {
    const { h, dir } = await opened();
    write(dir, "bundle.min.js", "x".repeat(PROJECT_FILE_MAX_BYTES + 10));
    const min = await h.engine.request({ type: "project_file", path: "bundle.min.js" });
    expect(min.lines).toHaveLength(1);
    expect(min.lines[0]!.length).toBe(PROJECT_FILE_MAX_BYTES);
    expect(min.truncated).toBe(true);
  }, 20_000);
});

describe("§47 project_search", () => {
  it("finds a fixed string ignoring case in tracked and untracked files, never ignored ones", async () => {
    const { h } = await opened();
    const r = await h.engine.request({ type: "project_search", query: "CART" });
    expect(r.query).toBe("CART");
    expect(r.truncated).toBe(false);
    const paths = new Set(r.matches.map((m) => m.path));
    expect(paths).toEqual(new Set(["README.md", "src/main/java/Cart.java", "src/main/java/CartService.java", "notes/untracked.txt"]));
    expect(r.matches).toContainEqual({ path: "src/main/java/Cart.java", line: 2, text: "  String cart;" });
    expect((await h.engine.request({ type: "project_search", query: "장바구니" })).matches).toEqual([
      { path: "src/main/java/CartService.java", line: 3, text: "  // 장바구니 조회" },
    ]);
  });

  it("caseSensitive, wholeWord, limit and a pattern git would read as an option", async () => {
    const { h, dir } = await opened();
    expect((await h.engine.request({ type: "project_search", query: "Cart", caseSensitive: true })).matches.every((m) => m.text.includes("Cart"))).toBe(true);
    const words = await h.engine.request({ type: "project_search", query: "cart", wholeWord: true });
    expect(words.matches.map((m) => m.text)).not.toContain("  void cartId() {}");
    expect(words.matches.length).toBeGreaterThan(0);
    const capped = await h.engine.request({ type: "project_search", query: "cart", limit: 2 });
    expect(capped.matches).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    write(dir, "flags.txt", "use -n here\n");
    expect((await h.engine.request({ type: "project_search", query: "-n" })).matches).toEqual([{ path: "flags.txt", line: 1, text: "use -n here" }]);
    expect((await h.engine.request({ type: "project_search", query: "no such text anywhere" })).matches).toEqual([]);
  });

  it("refuses an empty query and one holding a newline", async () => {
    const { h } = await opened();
    await expect(h.engine.request({ type: "project_search", query: "  " })).rejects.toThrow(/empty_query/);
    await expect(h.engine.request({ type: "project_search", query: "a\nb" })).rejects.toThrow(/invalid_query/);
  });

  it("a long line comes back as a window around its first match", async () => {
    const long = "x".repeat(1000) + "needle" + "y".repeat(1000);
    const w = lineWindow(long, "NEEDLE", false);
    expect(w.startsWith("…")).toBe(true);
    expect(w.endsWith("…")).toBe(true);
    expect(w).toContain("needle");
    expect(w.length).toBeLessThanOrEqual(PROJECT_SEARCH_LINE_MAX + 2);
    expect(lineWindow("short needle", "needle", true)).toBe("short needle");
  });

  it("without a project: refused no_project", async () => {
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await expect(h.engine.request({ type: "project_search", query: "x" })).rejects.toThrow(/no_project/);
    await expect(h.engine.request({ type: "project_file", path: "README.md" })).rejects.toThrow(/no_project/);
  });
});

describe("§47 searchProject", () => {
  // Windows file names cannot hold a newline.
  it.skipIf(process.platform === "win32")("parses a path holding a newline (git prints it verbatim with -z)", async () => {
    const dir = track(makeRepo());
    write(dir, "odd\nname.txt", "cart\n");
    const r = await searchProject(dir, { query: "cart", caseSensitive: true });
    expect(r.matches).toContainEqual({ path: "odd\nname.txt", line: 1, text: "cart" });
  });
});
