import { describe, expect, it } from "vitest";
import { extractSymbols, type FileSymbol } from "../src/files/symbols.js";

/** docs/PROTOCOL.md §65: the declarations of one file with their containers (the index's reading of §62's patterns). */

const lines = (...l: string[]): string => l.join("\n") + "\n";
/** `container.name:kind@line` per symbol, file order (`depth` as leading dots). */
const outline = (syms: FileSymbol[]): string[] => syms.map((s) => `${".".repeat(s.depth)}${s.container ? `${s.container}.` : ""}${s.name}:${s.kind}@${s.line}`);

describe("§65 extractSymbols — Java", () => {
  it("classes, nested classes, constructors, overloads, fields, enum constants; never a local or a comment", () => {
    const src = lines(
      "package com.acme.cart;", //                                   1
      "",
      "import java.util.List;",
      "",
      "/** A cart. class Fake {} */", //                              5
      "@Service",
      "public class CartService extends BaseService {",
      "  private final CartRepository repository;",
      "  int count = 0;",
      "  // private int commented;", //                              10
      "  public CartService(CartRepository repository) {",
      "    this.repository = repository;",
      "    int local = 1;",
      "  }",
      "", //                                                         15
      "  @Override",
      "  public Money total(String cartId) {",
      "    String s = \"{ not a brace\";",
      "    return total(cartId, false);",
      "  }", //                                                      20
      "",
      "  public <T> Money total(String cartId,",
      "                         boolean withTax) {",
      "    Runnable r = new Runnable() { public void run() {} };",
      "    return null;", //                                         25
      "  }",
      "",
      "  static class Line {",
      "    private String sku;",
      "    Line(String sku) { this.sku = sku; }", //                 30
      "  }",
      "",
      "  enum Status {",
      "    ACTIVE,",
      "    Closed(\"c\");", //                                       35
      "    private final String code = \"\";",
      "  }",
      "}",
      "",
      "interface CartRepository {", //                             40
      "  Cart find(String id);",
      "}",
    );
    const syms = extractSymbols("src/main/java/com/acme/cart/CartService.java", src);
    expect(outline(syms)).toEqual([
      "CartService:class@7",
      ".CartService.repository:field@8",
      ".CartService.count:field@9",
      ".CartService.CartService:constructor@11",
      ".CartService.total:method@17",
      ".CartService.total:method@22",
      ".CartService.Line:class@28",
      "..CartService.Line.sku:field@29",
      "..CartService.Line.Line:constructor@30",
      ".CartService.Status:enum@33",
      "..CartService.Status.ACTIVE:constant@34",
      "..CartService.Status.Closed:constant@35",
      "..CartService.Status.code:field@36",
      "CartRepository:interface@40",
      ".CartRepository.find:method@41",
    ]);
    const cls = syms[0]!;
    expect(cls).toMatchObject({ column: 14, signature: "public class CartService extends BaseService", endLine: 38 });
    expect(syms.find((s) => s.name === "Line" && s.kind === "class")).toMatchObject({ endLine: 31 });
    expect(syms.find((s) => s.name === "total")!.signature).toBe("public Money total(String cartId)");
  });
});

describe("§65 extractSymbols — Kotlin", () => {
  it("class / object / companion / extension functions / primary-constructor properties / enum entries", () => {
    const src = lines(
      "package com.acme.text", //                                   1
      "",
      "fun String.toSlug(): String = lowercase()",
      "fun <T> List<T>.second(): T = this[1]",
      "data class Article(val title: String, private val slug: String)", // 5
      "class Repo(",
      "    private val db: Db,",
      "    val name: String,",
      ") : Base() {",
      "    val size: Int get() = 0", //                              10
      "    constructor(db: Db) : this(db, \"x\")",
      "    fun load(id: String): Article {",
      "        val local = id",
      "        return Article(local, local)",
      "    }", //                                                    15
      "    companion object {",
      "        const val MAX = 3",
      "        fun create(): Repo = Repo(Db())",
      "    }",
      "    object Cache {", //                                       20
      "        fun clear() {}",
      "    }",
      "}",
      "enum class Color(val hex: String) {",
      "    RED(\"r\"),", //                                           25
      "    Green(\"g\");",
      "    fun dark() = this",
      "}",
      "object Registry",
      "typealias Slug = String", //                                 30
      "val defaultSlug: Slug = \"x\"",
    );
    const syms = extractSymbols("app/src/main/kotlin/com/acme/text/Slugs.kt", src);
    expect(outline(syms)).toEqual([
      "String.toSlug:function@3",
      "List.second:function@4",
      "Article:class@5",
      ".Article.title:property@5",
      ".Article.slug:property@5",
      "Repo:class@6",
      ".Repo.db:property@7",
      ".Repo.name:property@8",
      ".Repo.size:property@10",
      ".Repo.Repo:constructor@11",
      ".Repo.load:method@12",
      ".Repo.Companion:object@16",
      "..Repo.Companion.MAX:property@17",
      "..Repo.Companion.create:method@18",
      ".Repo.Cache:object@20",
      "..Repo.Cache.clear:method@21",
      "Color:enum@24",
      ".Color.hex:property@24",
      ".Color.RED:constant@25",
      ".Color.Green:constant@26",
      ".Color.dark:method@27",
      "Registry:object@29",
      "Slug:type@30",
      "defaultSlug:property@31",
    ]);
  });
});

describe("§65 extractSymbols — JS / TS", () => {
  it("classes (methods, fields, constructor), interfaces, enums, object methods, exports; never a local, a call or a keyword", () => {
    const src = lines(
      "import { x } from './x';", //                                1
      "export const formatPrice = (n) => `${n} {KRW`;",
      "export default function parseQuery(q) {",
      "  const local = 1;",
      "  function inner() {}", //                                    5
      "  if (q) {",
      "    return q;",
      "  }",
      "}",
      "export class CartStore extends Base {", //                   10
      "  items: CartItem[] = [];",
      "  count = 0;",
      "  static #secret = 1;",
      "  constructor(private readonly api: Api) {",
      "    super();", //                                             15
      "  }",
      "  async load(id: CartId) {",
      "    this.items.push(id);",
      "  }",
      "  get total(): number {", //                                 20
      "    return 0;",
      "  }",
      "  onClick = (e) => {",
      "    e.stop();",
      "  };", //                                                    25
      "}",
      "export interface CartItem {",
      "  sku: string;",
      "  find(id: string): CartItem;",
      "}", //                                                       30
      "export enum Kind {",
      "  A = 1,",
      "  B,",
      "}",
      "export const api = {", //                                    35
      "  get(url) {",
      "    return fetch(url);",
      "  },",
      "  post: async (url, body) => fetch(url, body),",
      "  timeout: 3000,", //                                        40
      "};",
      "describe('x', function () {",
      "  it('y', () => {});",
      "});",
      "module.exports.helper = function () {};", //                 45
      "export type CartId = string;",
    );
    const syms = extractSymbols("web/src/models/cart.ts", src);
    expect(outline(syms)).toEqual([
      "formatPrice:function@2",
      "parseQuery:function@3",
      "inner:function@5",
      "CartStore:class@10",
      ".CartStore.items:property@11",
      ".CartStore.count:property@12",
      ".CartStore.secret:property@13",
      ".CartStore.constructor:constructor@14",
      ".CartStore.load:method@17",
      ".CartStore.total:method@20",
      ".CartStore.onClick:method@23",
      "CartItem:interface@27",
      ".CartItem.sku:property@28",
      ".CartItem.find:method@29",
      "Kind:enum@31",
      ".Kind.A:constant@32",
      ".Kind.B:constant@33",
      "api:variable@35",
      ".api.get:method@36",
      ".api.post:method@39",
      ".api.timeout:property@40",
      "helper:variable@45",
      "CartId:type@46",
    ]);
  });

  it("`module.exports = {` / `export default {` members belong to the file", () => {
    const syms = extractSymbols("web/src/util/strings.js", lines("module.exports = {", "  trim(s) { return s; },", "  pad: function (s) { return s; },", "};"));
    expect(outline(syms)).toEqual(["strings.trim:method@2", "strings.pad:method@3"]);
  });

  it("a regex literal that throws the braces off is resynchronised by the next top-level declaration", () => {
    const syms = extractSymbols("web/a.js", lines("const re = /\\{/;", "function a() {}", "function b() {}"));
    expect(outline(syms)).toEqual(["re:variable@1", "a:function@2", "b:function@3"]);
  });
});

describe("§65 extractSymbols — Vue, JSP, Python, Go, Swift", () => {
  it("Vue SFC: the component, its options API members (methods / computed / props), and <script setup> top level", () => {
    const options = lines(
      "<template>", //                                              1
      "  <div>{{ total }}</div>",
      "</template>",
      "<script>",
      "import Row from './Row.vue';", //                            5
      "export default {",
      "  name: 'CartView',",
      "  props: {",
      "    cartId: String,",
      "  },", //                                                    10
      "  data() {",
      "    return { items: [] };",
      "  },",
      "  computed: {",
      "    total() {", //                                           15
      "      return 0;",
      "    },",
      "  },",
      "  methods: {",
      "    reload() {},", //                                        20
      "    remove: function (id) {},",
      "  },",
      "  mounted() {},",
      "};",
      "</script>", //                                               25
    );
    expect(outline(extractSymbols("web/src/views/cart-view.vue", options))).toEqual([
      "CartView:component@1",
      ".CartView.cartId:property@9",
      ".CartView.data:method@11",
      ".CartView.total:property@15",
      ".CartView.reload:method@20",
      ".CartView.remove:method@21",
      ".CartView.mounted:method@23",
    ]);
    const setup = lines("<script setup lang=\"ts\">", "const count = ref(0);", "function increment() {", "  const x = 1;", "}", "</script>", "<template><b/></template>");
    expect(outline(extractSymbols("web/src/components/Counter/index.vue", setup))).toEqual([
      "Counter:component@1",
      ".Counter.count:variable@2",
      ".Counter.increment:function@3",
    ]);
  });

  it("JSP: <%! %> declarations as page members, <script> functions, <c:set var>, tag-file attributes; scriptlet locals never", () => {
    const src = lines(
      "<%@ page contentType=\"text/html\" %>", //                    1
      "<%!",
      "  private int hits = 0;",
      "  public String label(String s) {",
      "    String local = s;", //                                    5
      "    return local;",
      "  }",
      "%>",
      "<% int scriptletLocal = 1; %>",
      "<c:set var=\"title\" value=\"x\"/>", //                       10
      "<script>",
      "  function openRow(id) { location.href = '<%= url %>' + id; }",
      "  var pageSize = ${size};",
      "</script>",
    );
    expect(outline(extractSymbols("src/main/webapp/WEB-INF/views/list.jsp", src))).toEqual([
      "hits:field@3",
      "label:method@4",
      "title:variable@10",
      "openRow:function@12",
      "pageSize:variable@13",
    ]);
    expect(outline(extractSymbols("WEB-INF/tags/panel.tag", lines("<%@ attribute name=\"heading\" required=\"true\" %>")))).toEqual(["heading:property@1"]);
  });

  it("Python: classes, methods, nested classes; module variables; never a nested function or a docstring", () => {
    const src = lines("class Report:", "    \"\"\"def fake(): a docstring\"\"\"", "    def render(self):", "        def helper():", "            pass", "    class Meta:", "        ordering = 1", "", "def build_report():", "    pass", "DEFAULT_NAME = 'r'");
    expect(outline(extractSymbols("tools/report.py", src))).toEqual([
      "Report:class@1",
      ".Report.render:method@3",
      ".Report.Meta:class@6",
      "build_report:function@9",
      "DEFAULT_NAME:variable@11",
    ]);
  });

  it("Go: structs with fields, interfaces with methods, receiver methods; Swift: types, init, members", () => {
    const go = lines("package svc", "", "type Cart struct {", "\tItems []Item", "\ttotal int", "}", "", "type Store interface {", "\tLoad(id string) Cart", "}", "", "func (c *Cart) Total() int {", "\tx := 1", "\treturn x", "}", "", "func NewCart() *Cart {", "\treturn &Cart{}", "}", "const MaxItems = 3");
    expect(outline(extractSymbols("svc/cart.go", go))).toEqual([
      "Cart:class@3", ".Cart.Items:field@4", ".Cart.total:field@5",
      "Store:interface@8", ".Store.Load:method@9",
      "Cart.Total:method@12", "NewCart:function@17", "MaxItems:variable@20",
    ]);
    const swift = lines("struct CartView {", "  let id: String", "  init(id: String) { self.id = id }", "  func reload() {", "    let local = 1", "  }", "  static func make() -> CartView { CartView(id: \"\") }", "}", "protocol Loader {}");
    expect(outline(extractSymbols("ios/Sources/Cart.swift", swift))).toEqual([
      "CartView:class@1", ".CartView.id:variable@2", ".CartView.CartView:constructor@3", ".CartView.reload:method@4", ".CartView.make:method@7",
      "Loader:interface@9",
    ]);
  });
});
