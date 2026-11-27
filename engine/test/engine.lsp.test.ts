import { afterEach, describe, expect, it } from "vitest";
import { findBundle } from "../src/lsp/locate.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §73 through the engine: `source` / `fallback`, the setting, `state.nav.lsp`, `ready.languageServer`. */

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function repo(): string {
  const dir = makeTempDir("rg-elsp");
  dirs.push(dir);
  sh(dir, "init", "-q");
  sh(dir, "config", "user.email", "dev@example.com");
  sh(dir, "config", "user.name", "Dev");
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" }, include: ["src"] }));
  write(dir, "src/lib/math.ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  write(dir, "src/index.ts", "export { add } from './lib/math';\n");
  write(dir, "src/app.ts", "import { add } from './index';\n// add is not called here\nconst three = add(1, 2);\n");
  write(dir, "src/Main.java", "class Main {\n  int add(int a) { return a; }\n}\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

async function opened(settings = {}): Promise<{ h: Harness; dir: string }> {
  const dir = repo();
  const h = makeHarness();
  harnesses.push(h);
  await h.hello(settings);
  await h.open(dir);
  return { h, dir };
}

describe.skipIf(!findBundle())("§73 through the engine", () => {
  it("ready says the server is there", async () => {
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    expect(h.ofType("ready")[0]?.languageServer).toMatchObject({ available: true, typescript: expect.stringMatching(/^6\./) });
  });

  it("a TS file: the language server answers (source lsp, quickInfo); its state; a Java file: the search, no fallback", async () => {
    const { h } = await opened();
    const d = await h.engine.request({ type: "find_definition", symbol: "add", fromPath: "src/app.ts", line: 3, column: 15 });
    expect(d).toMatchObject({ type: "definitions", symbol: "add", source: "lsp", truncated: false });
    expect(d.candidates.map((c) => `${c.path}:${c.line}:${c.kind}`)).toEqual(["src/lib/math.ts:1:function"]);
    expect(d.quickInfo?.display).toContain("add(a: number, b: number): number");
    expect(d.fallback).toBeUndefined();
    const s = await h.waitFor((st) => st.nav?.lsp?.status === "ready", "lsp ready");
    expect(s.nav?.lsp).toMatchObject({ status: "ready", typescript: { source: "bundled" } });

    // References: only the real ones — §62's grep would also list the comment on line 2.
    const r = await h.engine.request({ type: "find_references", symbol: "add", fromPath: "src/app.ts", line: 3, column: 15 });
    expect(r).toMatchObject({ type: "references", source: "lsp", files: 3 });
    expect(r.hits.map((x) => `${x.path}:${x.line}`)).toEqual(["src/app.ts:1", "src/app.ts:3", "src/index.ts:1", "src/lib/math.ts:1"]);
    const grep = await h.engine.request({ type: "find_references", symbol: "add", fromPath: "src/app.ts" }); // no line: the search
    expect(grep).toMatchObject({ source: "grep" });
    expect(grep.fallback).toBeUndefined();
    expect(grep.hits.some((x) => x.path === "src/app.ts" && x.line === 2)).toBe(true);

    const java = await h.engine.request({ type: "find_definition", symbol: "add", fromPath: "src/Main.java", line: 2 });
    expect(java).toMatchObject({ source: "grep" });
    expect(java.fallback).toBeUndefined();
  });

  it("the setting off: the search answers with fallback off, the server stops; on again: the server", async () => {
    const { h } = await opened({ languageServer: false });
    const off = await h.engine.request({ type: "find_definition", symbol: "add", fromPath: "src/app.ts", line: 3 });
    expect(off).toMatchObject({ source: "grep", fallback: "off" });
    expect(off.candidates.some((c) => c.path === "src/lib/math.ts" && c.line === 1)).toBe(true);
    expect(h.states.at(-1)?.nav?.lsp).toBeUndefined();
    await h.engine.request({ type: "set_settings", settings: { languageServer: true } });
    const on = await h.engine.request({ type: "find_definition", symbol: "add", fromPath: "src/app.ts", line: 3 });
    expect(on).toMatchObject({ source: "lsp" });
    await h.engine.request({ type: "set_settings", settings: { languageServer: false } });
    await h.waitFor((st) => st.nav !== undefined && st.nav.lsp === undefined, "lsp gone");
  });

  it("a code browser read of a TS file starts the server before any click", async () => {
    const { h } = await opened();
    await h.engine.request({ type: "project_file", path: "src/app.ts" });
    const s = await h.waitFor((st) => st.nav?.lsp?.status === "ready", "lsp ready");
    expect(s.nav?.lsp?.status).toBe("ready");
  });

  it("close_project stops it", async () => {
    const { h } = await opened();
    await h.engine.request({ type: "find_definition", symbol: "add", fromPath: "src/app.ts", line: 3 });
    await h.engine.request({ type: "close_project" });
    await h.settle();
    expect(h.states.at(-1)?.nav).toBeUndefined();
  });
});

describe("§73 without a bundle", () => {
  it("unavailable: the search answers, ready says so", async () => {
    const h = makeHarness({ lspDir: "/nonexistent/reviewgate-lsp" });
    harnesses.push(h);
    await h.hello();
    expect(h.ofType("ready")[0]?.languageServer).toEqual({ available: false });
    await h.open(repo());
    const d = await h.engine.request({ type: "find_definition", symbol: "add", fromPath: "src/app.ts", line: 3 });
    expect(d).toMatchObject({ source: "grep", fallback: "unavailable" });
    const s = await h.waitFor((st) => st.nav?.lsp?.status === "unavailable", "unavailable");
    expect(s.nav?.lsp?.error).toContain("not part of this build");
  });
});
