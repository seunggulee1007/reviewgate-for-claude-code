import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findDefinition } from "../src/files/navigate.js";
import { humpMatch, matchName, rankSymbols, SymbolIndex } from "../src/files/symbolIndex.js";
import { definitionPreview, type FileSymbol } from "../src/files/symbols.js";
import type { ToolFileEntry } from "../src/session/events.js";
import { makeHarness, type FakeClaudeSession, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §65: the symbol index, document / workspace symbols, previews, container-aware go to definition. */

const FILES: Record<string, string> = {
  "src/main/java/com/acme/cart/CartService.java": [
    "package com.acme.cart;", //                                          1
    "",
    "import com.acme.util.Money;",
    "",
    "/**", //                                                             5
    " * The cart.",
    " */",
    "@Service",
    "public class CartService {",
    "  private final CartRepository repository;", //                    10
    "",
    "  public Cart find(String id) {",
    "    return repository.find(id);",
    "  }",
    "", //                                                               15
    "  public void reload() {",
    "    find(\"x\");",
    "    this.find(\"y\");",
    "    userRepository.find(\"z\");",
    "  }", //                                                            20
    "}",
    "",
  ].join("\n"),
  "src/main/java/com/acme/cart/CartRepository.java": "package com.acme.cart;\n\npublic interface CartRepository {\n  Cart find(String id);\n}\n",
  "src/main/java/com/acme/cart/UserRepository.java": "package com.acme.cart;\n\npublic interface UserRepository {\n  User find(String id);\n}\n",
  "src/main/java/com/acme/a/AuditRepository.java": "package com.acme.a;\n\npublic interface AuditRepository {\n  Audit find(String id);\n}\n",
  "src/test/java/com/acme/cart/CartServiceTest.java": "package com.acme.cart;\n\nclass CartServiceTest {\n  void find() {}\n}\n",
  "app/src/main/kotlin/com/acme/Repo.kt": [
    "package com.acme",
    "",
    "class Aaa {",
    "    companion object {",
    "        fun create(): Aaa = Aaa()",
    "    }",
    "}",
    "class Repo {",
    "    companion object {",
    "        fun create(): Repo = Repo()",
    "    }",
    "}",
    "fun main() {",
    "    val r = Repo.create()",
    "}",
    "",
  ].join("\n"),
  "web/src/models/a-user.ts": "export class UserStore {\n  load(id: string) {\n    return id;\n  }\n}\n",
  "web/src/models/cart.ts": "export class CartStore {\n  load(id: string) {\n    return id;\n  }\n}\n",
  "web/src/views/checkout.ts": "import { CartStore } from '../models/cart';\n\nconst store: CartStore = new CartStore();\nstore.load('1');\n",
  "web/src/components/CartBadge.vue": "<template><span/></template>\n<script>\nexport default {\n  methods: {\n    refresh() {},\n  },\n};\n</script>\n",
  "src/main/java/com/acme/util/UserService.java": "package com.acme.util;\n\npublic class UserService {\n  public void userServiceHelper() {}\n}\n",
  // Never indexed: excluded folders, a minified file.
  "vendor/lib/Vendored.java": "public class VendoredThing {}\n",
  "web/dist/bundle.js": "export class DistThing {}\n",
  "web/src/lib.min.js": "export class MinThing {}\n",
  "notes.txt": "class NotCode {}\n",
};

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-sym"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, ".gitignore", "ignored/\n");
  for (const [path, text] of Object.entries(FILES)) write(dir, path, text);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  write(dir, "web/src/untracked.ts", "export function untrackedHelper() {}\n");
  write(dir, "ignored/Ignored.java", "public class IgnoredThing {}\n");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});
function repo(): string {
  const d = makeRepo();
  dirs.push(d);
  return d;
}
const names = (syms: { name: string; container?: string }[]): string[] => syms.map((s) => (s.container ? `${s.container}.${s.name}` : s.name));
const sym = (name: string, kind: FileSymbol["kind"], container?: string): FileSymbol => ({ name, kind, line: 1, column: 1, depth: 0, ...(container ? { container } : {}) });

describe("§65 fuzzy matching", () => {
  it("camel humps: UsrSvc → UserService, uS → userService, NPE → NullPointerException; words may be skipped", () => {
    expect(humpMatch("UsrSvc", "UserService")).toEqual([0, 1, 3, 4, 7, 9]);
    expect(humpMatch("uS", "userService")).toEqual([0, 4]);
    expect(humpMatch("NPE", "NullPointerException")).toEqual([0, 4, 11]);
    expect(humpMatch("USvc", "UserAccountService")).not.toBeNull();
    expect(humpMatch("SvcU", "UserService")).toBeNull();
    expect(humpMatch("xyz", "UserService")).toBeNull();
  });

  it("tiers: exact > prefix > humps > substring > subsequence; a one-letter query stops at humps", () => {
    const exact = matchName("User", "User")!.score;
    const prefix = matchName("User", "UserService")!.score;
    const hump = matchName("UsSe", "UserService")!.score;
    const sub = matchName("serv", "UserService")!.score;
    const seq = matchName("usrvc", "UserService")!.score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(hump);
    expect(hump).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(seq);
    expect(matchName("e", "UserService")).toBeNull();
    expect(matchName("S", "UserService")).not.toBeNull(); // a hump
    expect(matchName("serv", "UserService")!.matches).toEqual([4, 5, 6, 7]);
  });

  it("ranking: types boosted, tests and vendored files lowered, `Container.member` filters by container", () => {
    const files: [string, FileSymbol[]][] = [
      ["src/test/UserServiceTest.java", [sym("UserServiceTest", "class")]],
      ["src/main/UserService.java", [sym("UserService", "class"), sym("userService", "field", "Holder"), sym("UserService", "constructor", "UserService")]],
      ["node_modules/x/UserService.js", [sym("UserService", "class")]],
      ["src/main/Cart.java", [sym("total", "method", "CartService"), sym("total", "method", "OrderService")]],
    ];
    const r = rankSymbols(files, "UsrSvc", 10).symbols;
    expect(r.map((s) => `${s.path}:${s.name}:${s.kind}`)).toEqual([
      "src/main/UserService.java:UserService:class",
      "src/main/UserService.java:userService:field",
      "src/main/UserService.java:UserService:constructor",
      "src/test/UserServiceTest.java:UserServiceTest:class",
      "node_modules/x/UserService.js:UserService:class",
    ]);
    expect(r[0]!.matches).toEqual([0, 1, 3, 4, 7, 9]);
    expect(names(rankSymbols(files, "CartSvc.tot", 10).symbols)).toEqual(["CartService.total"]);
    expect(rankSymbols(files, "uS", 2)).toMatchObject({ truncated: true });
    expect(rankSymbols(files, "   ", 10).symbols).toEqual([]);
  });
});

describe("§65 SymbolIndex", () => {
  it("builds lazily: idle until asked; tracked + untracked files, never ignored / excluded / minified / non-code ones", async () => {
    const dir = repo();
    let changes = 0;
    const index = new SymbolIndex({ root: dir, onChange: () => changes++ });
    expect(index.state).toEqual({ status: "idle", files: 0, symbols: 0, truncated: false, builtAt: null });
    await index.ensure();
    const st = index.state;
    expect(st.status).toBe("ready");
    expect(st.truncated).toBe(false);
    expect(st.builtAt).not.toBeNull();
    expect(st.files).toBe(12);
    expect(changes).toBeGreaterThan(0);
    const all = (await index.search("Thing", 50)).symbols.map((s) => s.name);
    expect(all).toEqual([]);
    expect(names((await index.search("untrackedHelper", 5)).symbols)).toEqual(["untrackedHelper"]);
    expect((await index.search("CartBadge", 5)).symbols[0]).toMatchObject({ name: "CartBadge", kind: "component", path: "web/src/components/CartBadge.vue" });
    expect(names((await index.search("refresh", 5)).symbols)).toEqual(["CartBadge.refresh"]);
  });

  it("re-reads only changed files after refresh(paths); a sweep drops deleted ones and picks up new ones", async () => {
    const dir = repo();
    const index = new SymbolIndex({ root: dir, onChange: () => {} });
    await index.ensure();
    const before = index.state.symbols;
    write(dir, "web/src/models/cart.ts", "export class CartStore {\n  load(id: string) {}\n  save() {}\n}\n");
    index.refresh(["web/src/models/cart.ts"]);
    await new Promise((r) => setTimeout(r, 350));
    await index.ensure();
    expect(names((await index.search("save", 5)).symbols)).toEqual(["CartStore.save"]);
    expect(index.state.symbols).toBe(before + 1);
    sh(dir, "rm", "-q", "web/src/models/a-user.ts");
    write(dir, "web/src/models/fresh.ts", "export const freshValue = 1;\n");
    await index.build(false);
    expect(names((await index.search("UserStore", 5)).symbols)).toEqual([]);
    expect(names((await index.search("freshValue", 5)).symbols)).toEqual(["freshValue"]);
  });

  it("limits: the symbol cap and the time budget cut a build short (truncated); files over 1 MB are skipped", async () => {
    const dir = repo();
    write(dir, "web/src/huge.ts", `export const hugeThing = 1;\n${"// x\n".repeat(220_000)}`);
    const capped = new SymbolIndex({ root: dir, onChange: () => {}, maxSymbols: 5 });
    await capped.ensure();
    expect(capped.state).toMatchObject({ status: "ready", truncated: true });
    expect(capped.state.symbols).toBeLessThanOrEqual(5);
    const rushed = new SymbolIndex({ root: dir, onChange: () => {}, budgetMs: -1 });
    await rushed.ensure();
    expect(rushed.state).toMatchObject({ status: "ready", truncated: true, files: 0 });
    const full = new SymbolIndex({ root: dir, onChange: () => {} });
    await full.ensure();
    expect(names((await full.search("hugeThing", 5)).symbols)).toEqual([]);
  });

  it("a failing file list is status failed with git's first line", async () => {
    const index = new SymbolIndex({ root: "/nonexistent", onChange: () => {}, listFiles: async () => { throw new Error("fatal: not a git repository\nmore"); } });
    await index.ensure();
    expect(index.state).toMatchObject({ status: "failed", error: "fatal: not a git repository" });
  });
});

describe("§65 find_definition — containers", () => {
  const withIndex = (dir: string) => {
    const index = new SymbolIndex({ root: dir, onChange: () => {} });
    return (symbol: string, fromPath: string, line: number, extra: { receiver?: string; column?: number } = {}) =>
      findDefinition(dir, { symbol, fromPath, line, ...extra, symbolsOf: (p) => index.fileSymbols(p) });
  };
  const top = (cs: { path: string; container?: string }[]): string => `${cs[0]!.path}#${cs[0]!.container ?? ""}`;

  it("Java: a field's declared type wins over the clicked file's own method; unqualified / this → the enclosing class; a guessed type from the name", async () => {
    const dir = repo();
    const def = withIndex(dir);
    const from = "src/main/java/com/acme/cart/CartService.java";
    // Without the index: §62's ranking puts the clicked file's own `find` first.
    expect((await findDefinition(dir, { symbol: "find", fromPath: from, line: 13 })).candidates[0]!.path).toBe(from);
    const viaField = (await def("find", from, 13)).candidates;
    expect(top(viaField)).toBe("src/main/java/com/acme/cart/CartRepository.java#CartRepository");
    expect(viaField.find((c) => c.path === from)).toMatchObject({ container: "CartService" });
    expect(top((await def("find", from, 17)).candidates)).toBe(`${from}#CartService`);
    expect(top((await def("find", from, 18)).candidates)).toBe(`${from}#CartService`);
    expect(top((await def("find", from, 19)).candidates)).toBe("src/main/java/com/acme/cart/UserRepository.java#UserRepository");
    // An explicit receiver beats the line.
    expect(top((await def("find", from, 17, { receiver: "AuditRepository" })).candidates)).toBe("src/main/java/com/acme/a/AuditRepository.java#AuditRepository");
  });

  it("Kotlin: Type.member reaches the companion object; TS: a variable declared with an explicit type", async () => {
    const dir = repo();
    const def = withIndex(dir);
    const kt = (await def("create", "app/src/main/kotlin/com/acme/Repo.kt", 14)).candidates;
    expect(kt[0]).toMatchObject({ line: 10, container: "Repo.Companion" });
    const ts = (await def("load", "web/src/views/checkout.ts", 4)).candidates;
    expect(top(ts)).toBe("web/src/models/cart.ts#CartStore");
  });
});

describe("§65 definition_preview", () => {
  it("the comment / annotation block above by default, 15 lines after, the symbol on the line; before / after; refusals", () => {
    const dir = repo();
    const p = definitionPreview(dir, { path: "src/main/java/com/acme/cart/CartService.java", line: 9 });
    expect(p).toMatchObject({ path: "src/main/java/com/acme/cart/CartService.java", line: 9, startLine: 5, totalLines: 21, language: "java", truncated: false });
    expect(p.lines[0]).toBe("/**");
    expect(p.lines).toHaveLength(17); // 5…21: the file ends before 9 + 15
    expect(p.symbol).toMatchObject({ name: "CartService", kind: "class", endLine: 21 });
    const q = definitionPreview(dir, { path: "src/main/java/com/acme/cart/CartService.java", line: 12, before: 1, after: 2 });
    expect([q.startLine, q.lines.length]).toEqual([11, 4]);
    expect(q.symbol).toMatchObject({ name: "find", container: "CartService" });
    const capped = definitionPreview(dir, { path: "src/main/java/com/acme/cart/CartService.java", line: 12, before: 500, after: 500 });
    expect(capped.lines.length).toBeLessThanOrEqual(80);
    expect(() => definitionPreview(dir, { path: "src/main/java/com/acme/cart/CartService.java", line: 99 })).toThrow(/line_out_of_range/);
    expect(() => definitionPreview(dir, { path: "../etc/passwd", line: 1 })).toThrow(/invalid_path/);
    expect(definitionPreview(dir, { path: "web/src/views/checkout.ts", line: 3 }).language).toBe("typescript");
  });
});

// ---------------------------------------------------------------- through the engine

const cliId = (s: FakeClaudeSession): string => (s.opts.settings.forkAt ? s.opts.settings.sessionId! : s.opts.settings.resumeSessionId ?? s.opts.settings.sessionId!);
let uuidSeq = 0;
function claudeWrote(h: Harness): ToolFileEntry[] {
  const root = h.engine.state.project!.root;
  return sh(root, "status", "--porcelain", "-z", "-uall").split("\0").filter(Boolean).filter((e) => !/^[RC]/.test(e))
    .map((e, i) => ({ path: join(root, e.slice(3)), tools: ["Edit"], count: 1, toolUseIds: [`edit-${uuidSeq}-${i}`] }));
}
async function turn(h: Harness, mutate: () => void): Promise<void> {
  const before = h.engine.state.hud.turnCount;
  await h.engine.handle({ type: "send", text: "work" });
  const s = h.session();
  s.emitSessionInfo({ sessionId: cliId(s) });
  mutate();
  s.emitTurnEnd({ sessionId: cliId(s), lastUuid: `uuid-sym-${++uuidSeq}`, toolFiles: claudeWrote(h) });
  await h.waitFor((st) => st.hud.turnCount > before && st.gate.phase !== "running" && st.gate.phase !== "collecting", "turn collected");
  await h.settle();
}

describe("§65 through the engine", () => {
  async function opened(): Promise<{ h: Harness; dir: string }> {
    const dir = repo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    return { h, dir };
  }

  it("state.nav.index: idle after open_project (never built at the start), ready after the first workspace_symbols", async () => {
    const { h } = await opened();
    expect(h.engine.state.nav?.index).toMatchObject({ status: "idle", files: 0, symbols: 0 });
    const r = await h.engine.request({ type: "workspace_symbols", query: "CartSvc" });
    expect(r).toMatchObject({ type: "workspace_symbols", query: "CartSvc", truncated: false, index: { status: "ready" } });
    expect(r.symbols[0]).toMatchObject({ name: "CartService", kind: "class", path: "src/main/java/com/acme/cart/CartService.java", line: 9, column: 14, signature: "public class CartService" });
    await h.waitFor((s) => s.nav?.index.status === "ready" && s.nav.index.files === 12, "nav state ready");
  });

  it("document_symbols: file order with depth; definition_preview; nav_index_build; refusals", async () => {
    const { h } = await opened();
    const d = await h.engine.request({ type: "document_symbols", path: "src/main/java/com/acme/cart/CartService.java" });
    expect(d).toMatchObject({ type: "document_symbols", path: "src/main/java/com/acme/cart/CartService.java", language: "java", truncated: false });
    expect(d.symbols.map((s) => `${s.depth}:${s.name}:${s.kind}:${s.line}`)).toEqual(["0:CartService:class:9", "1:repository:field:10", "1:find:method:12", "1:reload:method:16"]);
    const p = await h.engine.request({ type: "definition_preview", path: "web/src/models/cart.ts", line: 2, before: 0, after: 1 });
    expect(p).toMatchObject({ type: "definition_preview", startLine: 2, lines: ["  load(id: string) {", "    return id;"], language: "typescript", symbol: { name: "load", container: "CartStore" } });
    const b = await h.engine.request({ type: "nav_index_build", full: true });
    expect(b.type).toBe("nav_index");
    await h.waitFor((s) => s.nav?.index.status === "ready", "built");
    await expect(h.engine.request({ type: "document_symbols", path: "../x.java" })).rejects.toThrow(/invalid_path/);
    await expect(h.engine.request({ type: "definition_preview", path: "nope.ts", line: 1 })).rejects.toThrow(/file_not_found/);
    const bare = makeHarness();
    harnesses.push(bare);
    await bare.hello();
    await expect(bare.engine.request({ type: "workspace_symbols", query: "x" })).rejects.toThrow(/no_project/);
    await expect(bare.engine.request({ type: "document_symbols", path: "a.ts" })).rejects.toThrow(/no_project/);
    expect(bare.engine.state.nav).toBeUndefined();
  });

  it("refreshes after a turn's collection: a class Claude added is found without a rebuild", async () => {
    const { h, dir } = await opened();
    await h.engine.request({ type: "workspace_symbols", query: "Cart" });
    expect((await h.engine.request({ type: "workspace_symbols", query: "BrandNewThing" })).symbols).toEqual([]);
    const files = h.engine.state.nav!.index.files;
    await turn(h, () => write(dir, "src/main/java/com/acme/cart/BrandNewThing.java", "package com.acme.cart;\n\npublic class BrandNewThing {}\n"));
    await h.waitFor((s) => (s.nav?.index.files ?? 0) > files, "index refreshed after the turn");
    expect(names((await h.engine.request({ type: "workspace_symbols", query: "BrandNewThing" })).symbols)).toEqual(["BrandNewThing"]);
  });

  it("find_definition through the engine uses the index's containers (and says them)", async () => {
    const { h } = await opened();
    const d = await h.engine.request({ type: "find_definition", symbol: "find", fromPath: "src/main/java/com/acme/cart/CartService.java", line: 13 });
    expect(d.candidates[0]).toMatchObject({ path: "src/main/java/com/acme/cart/CartRepository.java", container: "CartRepository", kind: "method" });
    expect(h.engine.state.nav?.index.status).toBe("idle"); // read on demand, the whole index not built
  });

  it("works in a folder tracked without git (§59): untracked files indexed, no .git appears", async () => {
    const folder = realpathSync.native(makeTempDir("rg-sym-nogit"));
    const data = makeTempDir("rg-sym-nogit-data");
    dirs.push(folder, data);
    write(folder, "src/Widget.kt", "class Widget {\n    fun render() = Unit\n}\n");
    const h = makeHarness({ dataDir: data });
    harnesses.push(h);
    await h.hello();
    await h.open(folder);
    await h.engine.request({ type: "track_without_git" });
    await h.waitFor((s) => s.session.open && !s.session.starting, "session after track_without_git");
    write(folder, "src/later.ts", "export class LaterWidget {}\n");
    const r = await h.engine.request({ type: "workspace_symbols", query: "Widget" });
    expect(r.symbols.map((s) => `${s.path}:${s.name}`)).toEqual(["src/Widget.kt:Widget", "src/later.ts:LaterWidget"]);
    expect(names((await h.engine.request({ type: "workspace_symbols", query: "render" })).symbols)).toEqual(["Widget.render"]);
    expect(existsSync(join(folder, ".git"))).toBe(false);
  });

  it("answers while the main lane is busy with a turn", async () => {
    const { h } = await opened();
    await h.engine.handle({ type: "send", text: "work" }); // the turn stays open
    const r = await h.engine.request({ type: "workspace_symbols", query: "CartStore" });
    expect(r.symbols[0]).toMatchObject({ name: "CartStore" });
  });
});
