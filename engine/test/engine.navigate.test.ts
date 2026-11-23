import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findDefinition, findReferences, navPreview, NAV_PREVIEW_MAX, NAV_SYMBOL_MAX, parseSymbol } from "../src/files/navigate.js";
import type { DefinitionCandidate } from "../src/protocol.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §62: `find_definition` / `find_references` — search-based go to definition, read-only. */

const FILES: Record<string, string> = {
  // Java: a class, overloads, a field, a constructor, an interface, an enum, a record, an annotation.
  "src/main/java/com/acme/cart/CartService.java": [
    "package com.acme.cart;",
    "",
    "import com.acme.util.Money;",
    "",
    "public class CartService {",
    "  private final CartRepository repository;",
    "  private int count = 0;",
    "",
    "  public CartService(CartRepository repository) {",
    "    this.repository = repository;",
    "  }",
    "",
    "  public Money total(String cartId) {",
    "    return total(cartId, false);",
    "  }",
    "",
    "  public <T> Money total(String cartId, boolean withTax) throws Exception {",
    "    Money sum = Money.zero();",
    "    return sum;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/main/java/com/acme/cart/CartRepository.java": "package com.acme.cart;\n\npublic interface CartRepository {\n  Cart find(String id);\n}\n",
  "src/main/java/com/acme/util/Money.java": "package com.acme.util;\n\npublic final class Money {\n  public static Money zero() { return new Money(); }\n}\n",
  "src/main/java/com/acme/legacy/Money.java": "package com.acme.legacy;\n\npublic class Money {\n}\n",
  "src/main/java/com/acme/cart/Status.java": "package com.acme.cart;\n\npublic enum Status {\n  ACTIVE,\n  CLOSED(\"c\");\n}\n",
  "src/main/java/com/acme/cart/Line.java": "package com.acme.cart;\n\npublic record Line(String sku, int qty) {}\n",
  "src/main/java/com/acme/cart/Audited.java": "package com.acme.cart;\n\npublic @interface Audited {}\n",
  "src/test/java/com/acme/cart/CartServiceTest.java": "package com.acme.cart;\n\nclass CartServiceTest {\n  void total() {}\n}\n",
  // Kotlin: an extension function, a data class, an object, a typealias, a property.
  "app/src/main/kotlin/com/acme/text/Slugs.kt": [
    "package com.acme.text",
    "",
    "fun String.toSlug(): String = lowercase()",
    "fun <T> List<T>.second(): T = this[1]",
    "data class Article(val title: String, val slug: String)",
    "object Registry",
    "sealed class Shape",
    "enum class Color { RED, GREEN }",
    "typealias Slug = String",
    "val defaultSlug: Slug = \"x\"",
    "",
  ].join("\n"),
  // JS / TS: an arrow const, a class method, export default function, interface / type.
  "web/src/utils/format.js": [
    "export const formatPrice = (n) => `${n} KRW`;",
    "export default function parseQuery(q) {",
    "  return q;",
    "}",
    "const limit = 10;",
    "",
  ].join("\n"),
  "web/src/models/cart.ts": [
    "export interface CartItem {",
    "  sku: string;",
    "}",
    "export type CartId = string;",
    "export class CartStore {",
    "  items: CartItem[] = [];",
    "  addItem(item: CartItem): void {",
    "    this.items.push(item);",
    "  }",
    "  async load(id: CartId) {",
    "    addItem(id);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "web/src/views/checkout.js": [
    "import { formatPrice } from '../utils/format';",
    "const api = {",
    "  submit: function (order) { return order; },",
    "  cancel: async (id) => id,",
    "};",
    "formatPrice(3);",
    "describe(\"x\", function () {",
    "});",
    "",
  ].join("\n"),
  "web/src/other/format.js": "export const formatPrice = (n) => n;\n",
  // Vue: SFC methods / computed / setup, component files by name.
  "web/src/components/MyWidget.vue": [
    "<template>",
    "  <div @click=\"toggle\">{{ label }}</div>",
    "</template>",
    "<script>",
    "export default {",
    "  name: 'MyWidget',",
    "  props: { label: String },",
    "  methods: {",
    "    toggle() {",
    "      this.open = !this.open;",
    "    },",
    "  },",
    "  computed: {",
    "    isOpen() {",
    "      return this.open;",
    "    },",
    "  },",
    "};",
    "</script>",
    "",
  ].join("\n"),
  "web/src/components/date-picker.vue": [
    "<script setup>",
    "const props = defineProps({ value: String });",
    "const pickedDate = ref(null);",
    "function choose(d) { pickedDate.value = d; }",
    "</script>",
    "",
  ].join("\n"),
  "web/src/pages/Home.vue": [
    "<template>",
    "  <my-widget label=\"x\" />",
    "  <DatePicker />",
    "</template>",
    "<script>",
    "import MyWidget from '@/components/MyWidget.vue';",
    "export default { components: { MyWidget } };",
    "</script>",
    "",
  ].join("\n"),
  // JSP: a declaration block, an include, a custom tag (tag file + taglib), a Java class used in a scriptlet.
  "src/main/webapp/WEB-INF/views/cart/list.jsp": [
    "<%@ page import=\"com.acme.cart.CartService, com.acme.util.*\" %>",
    "<%@ taglib prefix=\"ui\" tagdir=\"/WEB-INF/tags/ui\" %>",
    "<%@ include file=\"/WEB-INF/views/common/header.jspf\" %>",
    "<%! private int visits = 0; %>",
    "<%! String fmtPrice(int price) {",
    "      return price + \" KRW\";",
    "    } %>",
    "<c:set var=\"pageTitle\" value=\"Cart\" />",
    "<% CartService svc = null; %>",
    "<jsp:include page=\"row.jsp\" />",
    "<ui:panel title=\"x\" />",
    "<script>",
    "function goSearch() {",
    "  return fmtPrice(1);",
    "}",
    "</script>",
    "",
  ].join("\n"),
  "src/main/webapp/WEB-INF/views/cart/row.jsp": "<div>row</div>\n",
  "src/main/webapp/WEB-INF/views/common/header.jspf": "<header/>\n",
  "src/main/webapp/WEB-INF/tags/ui/panel.tag": "<%@ attribute name=\"title\" required=\"true\" %>\n<div>${title}</div>\n",
  // Swift / Python / Go basics.
  "ios/Sources/Cart.swift": "struct CartView {\n  func reload() {}\n}\nprotocol Loader {}\nlet maxItems = 3\n",
  "tools/report.py": "import os\n\nclass Report:\n    def render(self):\n        self.title = 'x'\n\ndef build_report():\n    pass\n\nDEFAULT_NAME = 'r'\n",
  "svc/cart.go": "package svc\n\ntype Cart struct {\n}\n\ntype Store interface {\n}\n\nfunc (c *Cart) Total() int {\n\treturn 0\n}\n\nfunc NewCart() *Cart {\n\treturn &Cart{}\n}\n\nconst MaxItems = 3\n",
  // Noise: a vendored copy and a comment mentioning the class.
  "web/node_modules_copy/vendor/format.js": "export const formatPrice = 1;\n",
  "docs/notes.java": "// class CartService is described elsewhere\n",
};

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-nav"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, ".gitignore", "build/\n");
  for (const [path, text] of Object.entries(FILES)) write(dir, path, text);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  // Untracked (not ignored) files are searched; ignored ones never.
  write(dir, "web/src/untracked/helper.ts", "export function untrackedHelper() {}\n");
  write(dir, "build/gen/Helper.java", "public class CartService {}\n");
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
const at = (cs: DefinitionCandidate[]): string[] => cs.map((c) => `${c.path}:${c.line}:${c.kind}`);
const def = async (root: string, symbol: string, fromPath?: string, line?: number) => (await findDefinition(root, { symbol, fromPath, line })).candidates;

describe("§62 find_definition — patterns per language", () => {
  it("Java: class, constructor, overloaded methods, field, interface, enum + constant, record, annotation; never a comment or an ignored file", async () => {
    const root = repo();
    const svc = await def(root, "CartService");
    expect(at(svc).slice(0, 2)).toEqual([
      "src/main/java/com/acme/cart/CartService.java:5:class",
      "src/main/java/com/acme/cart/CartService.java:9:constructor",
    ]);
    expect(svc[0]).toMatchObject({ column: 14, preview: "public class CartService {" });
    expect(svc.some((c) => c.path.startsWith("build/") || c.path === "docs/notes.java")).toBe(false);
    // A JSP scriptlet that only uses the class is not a definition of it.
    expect(svc.some((c) => c.path.endsWith(".jsp"))).toBe(false);

    const total = at(await def(root, "total", "src/main/java/com/acme/cart/CartService.java", 14));
    expect(total.slice(0, 2)).toEqual(["src/main/java/com/acme/cart/CartService.java:13:method", "src/main/java/com/acme/cart/CartService.java:17:method"]);
    expect(total).not.toContain("src/main/java/com/acme/cart/CartService.java:14:method"); // `return total(…)` is a call
    expect(total.at(-1)).toBe("src/test/java/com/acme/cart/CartServiceTest.java:4:method"); // a test ranks last

    expect(at(await def(root, "repository"))).toEqual(["src/main/java/com/acme/cart/CartService.java:6:field"]);
    expect(at(await def(root, "CartRepository"))[0]).toBe("src/main/java/com/acme/cart/CartRepository.java:3:interface");
    expect(at(await def(root, "Status"))).toEqual(["src/main/java/com/acme/cart/Status.java:3:enum"]);
    expect(at(await def(root, "ACTIVE"))).toEqual(["src/main/java/com/acme/cart/Status.java:4:constant"]);
    expect(at(await def(root, "CLOSED"))).toEqual(["src/main/java/com/acme/cart/Status.java:5:constant"]);
    expect(at(await def(root, "Line"))).toEqual(["src/main/java/com/acme/cart/Line.java:3:record"]);
    expect(at(await def(root, "Audited"))).toEqual(["src/main/java/com/acme/cart/Audited.java:3:annotation"]);
  });

  it("Kotlin: extension functions, data class (and its val parameters), object, sealed / enum class, typealias, top-level val", async () => {
    const root = repo();
    const kt = "app/src/main/kotlin/com/acme/text/Slugs.kt";
    expect(at(await def(root, "toSlug"))).toEqual([`${kt}:3:function`]);
    expect(at(await def(root, "second"))).toEqual([`${kt}:4:function`]);
    expect(at(await def(root, "Article"))).toEqual([`${kt}:5:class`]);
    expect(at(await def(root, "slug"))).toEqual([`${kt}:5:property`]);
    expect(at(await def(root, "Registry"))).toEqual([`${kt}:6:object`]);
    expect(at(await def(root, "Shape"))).toEqual([`${kt}:7:class`]);
    expect(at(await def(root, "Color"))).toEqual([`${kt}:8:enum`]);
    expect(at(await def(root, "Slug"))[0]).toBe(`${kt}:9:type`);
    expect(at(await def(root, "defaultSlug"))).toEqual([`${kt}:10:property`]);
  });

  it("JS / TS: arrow const, export default function, class + methods, interface, type, object-literal methods; a callback call is not one", async () => {
    const root = repo();
    expect(at(await def(root, "parseQuery"))).toEqual(["web/src/utils/format.js:2:function"]);
    expect(at(await def(root, "limit"))).toEqual(["web/src/utils/format.js:5:variable"]);
    expect(at(await def(root, "CartStore"))).toEqual(["web/src/models/cart.ts:5:class"]);
    expect(at(await def(root, "addItem"))).toEqual(["web/src/models/cart.ts:7:method"]); // line 11 calls it
    expect(at(await def(root, "load"))).toEqual(["web/src/models/cart.ts:10:method"]);
    expect(at(await def(root, "CartItem"))).toEqual(["web/src/models/cart.ts:1:interface"]);
    expect(at(await def(root, "CartId"))).toEqual(["web/src/models/cart.ts:4:type"]);
    expect(at(await def(root, "submit"))).toEqual(["web/src/views/checkout.js:3:method"]);
    expect(at(await def(root, "cancel"))).toEqual(["web/src/views/checkout.js:4:method"]);
    expect(await def(root, "describe")).toEqual([]);
    expect(at(await def(root, "untrackedHelper"))).toEqual(["web/src/untracked/helper.ts:1:function"]); // untracked, not ignored
  });

  it("Vue: SFC methods / computed / setup consts and functions; a component name resolves to its file (PascalCase ↔ kebab-case)", async () => {
    const root = repo();
    expect(at(await def(root, "toggle"))).toEqual(["web/src/components/MyWidget.vue:9:method"]);
    expect(at(await def(root, "isOpen"))).toEqual(["web/src/components/MyWidget.vue:14:method"]);
    expect(at(await def(root, "pickedDate"))).toEqual(["web/src/components/date-picker.vue:3:variable"]);
    expect(at(await def(root, "choose"))).toEqual(["web/src/components/date-picker.vue:4:function"]);
    const widget = await def(root, "MyWidget", "web/src/pages/Home.vue", 7);
    expect(at(widget)[0]).toBe("web/src/components/MyWidget.vue:1:component");
    expect(at(widget)).toContain("web/src/components/MyWidget.vue:6:component"); // name: 'MyWidget'
    expect(at(await def(root, "my-widget", "web/src/pages/Home.vue", 2))[0]).toBe("web/src/components/MyWidget.vue:1:component");
    expect(at(await def(root, "DatePicker", "web/src/pages/Home.vue", 3))).toEqual(["web/src/components/date-picker.vue:1:component"]);
  });

  it("JSP: declaration methods / fields, <c:set var>, includes as files, custom tags as tag files, Java classes from JSP", async () => {
    const root = repo();
    const jsp = "src/main/webapp/WEB-INF/views/cart/list.jsp";
    expect(at(await def(root, "fmtPrice", jsp, 14))).toEqual([`${jsp}:5:method`]);
    expect(at(await def(root, "visits", jsp))).toEqual([`${jsp}:4:field`]);
    expect(at(await def(root, "pageTitle", jsp))).toEqual([`${jsp}:8:variable`]);
    expect(at(await def(root, "goSearch", jsp))).toEqual([`${jsp}:13:function`]);
    expect(at(await def(root, "/WEB-INF/views/common/header.jspf", jsp))).toEqual(["src/main/webapp/WEB-INF/views/common/header.jspf:1:file"]);
    expect(at(await def(root, "row.jsp", jsp))).toEqual(["src/main/webapp/WEB-INF/views/cart/row.jsp:1:file"]);
    expect(at(await def(root, "ui:panel", jsp))).toEqual(["src/main/webapp/WEB-INF/tags/ui/panel.tag:1:tag"]);
    expect(at(await def(root, "title", "src/main/webapp/WEB-INF/tags/ui/panel.tag"))[0]).toBe("src/main/webapp/WEB-INF/tags/ui/panel.tag:1:property");
    // A Java class used in a JSP resolves to its Java declaration; the page's import picks util's Money over legacy's.
    expect(at(await def(root, "CartService", jsp))[0]).toBe("src/main/java/com/acme/cart/CartService.java:5:class");
    expect(at(await def(root, "Money", jsp))[0]).toBe("src/main/java/com/acme/util/Money.java:3:class");
  });

  it("Swift, Python, Go basics", async () => {
    const root = repo();
    expect(at(await def(root, "CartView"))).toEqual(["ios/Sources/Cart.swift:1:class"]);
    expect(at(await def(root, "reload"))).toEqual(["ios/Sources/Cart.swift:2:method"]);
    expect(at(await def(root, "Loader"))).toEqual(["ios/Sources/Cart.swift:4:interface"]);
    expect(at(await def(root, "maxItems"))).toEqual(["ios/Sources/Cart.swift:5:variable"]);
    expect(at(await def(root, "Report"))).toEqual(["tools/report.py:3:class"]);
    expect(at(await def(root, "render"))).toEqual(["tools/report.py:4:method"]);
    expect(at(await def(root, "build_report"))).toEqual(["tools/report.py:7:function"]);
    expect(at(await def(root, "DEFAULT_NAME"))).toEqual(["tools/report.py:10:variable"]);
    expect(at(await def(root, "Cart")).filter((c) => c.startsWith("svc/"))).toEqual(["svc/cart.go:3:class"]);
    expect(at(await def(root, "Store"))).toEqual(["svc/cart.go:6:interface"]);
    expect(at(await def(root, "Total"))).toEqual(["svc/cart.go:9:method"]);
    expect(at(await def(root, "NewCart"))).toEqual(["svc/cart.go:13:function"]);
    expect(at(await def(root, "MaxItems"))).toEqual(["svc/cart.go:17:variable"]);
  });
});

describe("§62 find_definition — ranking", () => {
  it("prefers the imported file: Java import over another package's class of the same name; a.b.C picks that file", async () => {
    const root = repo();
    const fromSvc = at(await def(root, "Money", "src/main/java/com/acme/cart/CartService.java", 13));
    expect(fromSvc.slice(0, 2)).toEqual(["src/main/java/com/acme/util/Money.java:3:class", "src/main/java/com/acme/legacy/Money.java:3:class"]);
    expect(at(await def(root, "com.acme.legacy.Money"))[0]).toBe("src/main/java/com/acme/legacy/Money.java:3:class");
  });

  it("prefers the JS module the clicked file imports from, then the same folder; vendored copies last", async () => {
    const root = repo();
    const fromCheckout = await def(root, "formatPrice", "web/src/views/checkout.js", 6);
    expect(at(fromCheckout)).toEqual([
      "web/src/utils/format.js:1:function",
      "web/src/other/format.js:1:function",
      "web/node_modules_copy/vendor/format.js:1:variable",
    ]);
    expect(fromCheckout[0]!.score).toBeGreaterThan(fromCheckout[1]!.score);
    const fromOther = at(await def(root, "formatPrice", "web/src/other/format.js"));
    expect(fromOther[0]).toBe("web/src/other/format.js:1:function"); // same file first
  });

  it("deduplicates a line two patterns take, and caps at 50 (truncated)", async () => {
    const root = repo();
    for (let i = 0; i < 60; i++) write(root, `gen/f${i}.ts`, "export function dup() {}\n");
    const r = await findDefinition(root, { symbol: "dup" });
    expect(r.candidates).toHaveLength(50);
    expect(r.truncated).toBe(true);
    expect(new Set(r.candidates.map((c) => `${c.path}:${c.line}`)).size).toBe(50);
  });
});

describe("§62 find_references", () => {
  it("whole-word, case-sensitive hits: the clicked file first, then its folder, then by path; definitions carry their kind", async () => {
    const root = repo();
    const r = await findReferences(root, { symbol: "formatPrice", fromPath: "web/src/views/checkout.js" });
    expect(r.hits.map((h) => `${h.path}:${h.line}`)).toEqual([
      "web/src/views/checkout.js:1",
      "web/src/views/checkout.js:6",
      "web/node_modules_copy/vendor/format.js:1",
      "web/src/other/format.js:1",
      "web/src/utils/format.js:1",
    ]);
    expect(r.hits[0]).toMatchObject({ column: 10, preview: "import { formatPrice } from '../utils/format';" });
    expect(r.hits[0]!.kind).toBeUndefined();
    expect(r.hits.find((h) => h.path === "web/src/utils/format.js")).toMatchObject({ kind: "function", column: 14 });
    expect(r).toMatchObject({ files: 4, truncated: false });
    // -w: `CartServiceTest` is not a hit of `CartService`; case matters.
    const svc = await findReferences(root, { symbol: "CartService" });
    expect(svc.hits.some((h) => h.preview.includes("CartServiceTest"))).toBe(false);
    expect((await findReferences(root, { symbol: "cartservice" })).hits).toEqual([]);
  });

  it("stops at limit (truncated)", async () => {
    const root = repo();
    const r = await findReferences(root, { symbol: "CartService", limit: 2 });
    expect(r.hits).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });
});

describe("§62 symbols and previews", () => {
  it("accepts identifiers, a.b.C, kebab-case, prefix:tag and paths; refuses anything else bad_symbol", () => {
    expect(parseSymbol("total").form).toBe("ident");
    expect(parseSymbol("$store").form).toBe("ident");
    expect(parseSymbol("com.acme.Money").form).toBe("fqn");
    expect(parseSymbol("my-widget").form).toBe("kebab");
    expect(parseSymbol("ui:panel").form).toBe("tag");
    expect(parseSymbol("/WEB-INF/a.jsp").form).toBe("path");
    expect(parseSymbol("header.jspf").form).toBe("path");
    for (const bad of ["", "  ", "a b", "foo(", "a\nb", "-x", "x".repeat(NAV_SYMBOL_MAX + 1), 42, null]) {
      expect(() => parseSymbol(bad), String(bad)).toThrow(/bad_symbol/);
    }
  });

  it("a long line's preview is a window around the symbol", () => {
    const line = "  " + "x".repeat(500) + " needle " + "y".repeat(500);
    const p = navPreview(line, line.indexOf("needle") + 1);
    expect(p).toContain("needle");
    expect(p.startsWith("…") && p.endsWith("…")).toBe(true);
    expect(p.length).toBeLessThanOrEqual(NAV_PREVIEW_MAX + 2);
    expect(navPreview("    short line", 5)).toBe("short line");
  });
});

describe("§62 through the engine", () => {
  async function opened(): Promise<{ h: Harness; dir: string }> {
    const dir = repo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    return { h, dir };
  }

  it("replies definitions / references", async () => {
    const { h } = await opened();
    const d = await h.engine.request({ type: "find_definition", symbol: "CartStore", fromPath: "web/src/views/checkout.js", line: 1 });
    expect(d).toMatchObject({ type: "definitions", symbol: "CartStore", truncated: false });
    expect(d.candidates[0]).toMatchObject({ path: "web/src/models/cart.ts", line: 5, column: 14, kind: "class" });
    const r = await h.engine.request({ type: "find_references", symbol: "CartStore" });
    expect(r).toMatchObject({ type: "references", symbol: "CartStore", files: 1, truncated: false });
  });

  it("refuses bad_symbol, and no_project without a project", async () => {
    const { h } = await opened();
    await expect(h.engine.request({ type: "find_definition", symbol: "a b" })).rejects.toThrow(/bad_symbol/);
    await expect(h.engine.request({ type: "find_references", symbol: "" })).rejects.toThrow(/bad_symbol/);
    const bare = makeHarness();
    harnesses.push(bare);
    await bare.hello();
    await expect(bare.engine.request({ type: "find_definition", symbol: "x" })).rejects.toThrow(/no_project/);
    await expect(bare.engine.request({ type: "find_references", symbol: "x" })).rejects.toThrow(/no_project/);
  });

  it("works in a folder tracked without git (§59): the hidden repository, untracked files too, no .git appears", async () => {
    const folder = realpathSync.native(makeTempDir("rg-nav-nogit"));
    const data = makeTempDir("rg-nav-nogit-data");
    dirs.push(folder, data);
    write(folder, "src/Widget.kt", "class Widget\nfun Widget.render() = Unit\n");
    const h = makeHarness({ dataDir: data });
    harnesses.push(h);
    await h.hello();
    await h.open(folder);
    await h.engine.request({ type: "track_without_git" });
    await h.waitFor((s) => s.session.open && !s.session.starting, "session after track_without_git");
    expect(h.engine.state.project?.vcs).toBe("shadow");
    write(folder, "src/later.ts", "export const useWidget = () => new Widget();\n"); // after the baseline: untracked
    const d = await h.engine.request({ type: "find_definition", symbol: "Widget", fromPath: "src/later.ts" });
    expect(at(d.candidates)).toEqual(["src/Widget.kt:1:class"]);
    expect(at((await h.engine.request({ type: "find_definition", symbol: "useWidget" })).candidates)).toEqual(["src/later.ts:1:function"]);
    const r = await h.engine.request({ type: "find_references", symbol: "Widget" });
    expect(r.hits.map((x) => `${x.path}:${x.line}`)).toEqual(["src/Widget.kt:1", "src/Widget.kt:2", "src/later.ts:1"]);
    expect(existsSync(join(folder, ".git"))).toBe(false);
  });

  it("answers while the main lane is busy with a turn", async () => {
    const { h } = await opened();
    await h.engine.handle({ type: "send", text: "work" }); // the turn stays open: nothing ends it
    const d = await h.engine.request({ type: "find_definition", symbol: "CartStore" });
    expect(d.candidates.length).toBeGreaterThan(0);
  });
});
