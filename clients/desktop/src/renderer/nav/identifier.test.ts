import { describe, expect, it } from "vitest";
import { identifierAt, isSendableSymbol, receiverBefore } from "./identifier";

/** The symbol at the first `|` of `marked` (the marker removed). */
const at = (marked: string, path = "") => {
  const offset = marked.indexOf("|");
  return identifierAt(marked.replace("|", ""), offset, path)?.symbol ?? null;
};

describe("identifierAt (§62)", () => {
  it("Java: a word, a type through its import / package, not a member through its receiver", () => {
    expect(at("    private final Cart|Service cartService;", "A.java")).toBe("CartService");
    expect(at("import com.acme.shop.Cart|Service;", "A.java")).toBe("com.acme.shop.CartService");
    expect(at("import static com.acme.Util.tr|im;", "A.java")).toBe("com.acme.Util.trim");
    expect(at("        return this.tot|al;", "A.java")).toBe("total");
    expect(at("    cartService.addI|tem(item);", "A.java")).toBe("addItem");
    expect(at("    com.acme.Mo|ney.of(1)", "A.java")).toBe("com.acme.Money");
    expect(at("    @Autow|ired", "A.java")).toBe("Autowired");
    // the word's end (the pointer just past its last letter) still names it
    expect(at("total|;", "A.java")).toBe("total");
  });

  it("Kotlin: fun / val names and extension receivers", () => {
    expect(at("fun List<Item>.tot|al(): Int = sumOf { it.price }", "A.kt")).toBe("total");
    expect(at("val repo = Cart|Repository()", "A.kt")).toBe("CartRepository");
    expect(at("import com.acme.Cart|Repository", "A.kt")).toBe("com.acme.CartRepository");
  });

  it("JavaScript / TypeScript: $-names, import paths in quotes", () => {
    expect(at("this.$st|ore.dispatch('x')", "a.js")).toBe("$store");
    expect(at("import { format|Price } from './util/price'", "a.ts")).toBe("formatPrice");
    expect(at("import { formatPrice } from './util/pr|ice'", "a.ts")).toBe("./util/price");
    expect(at("const x = require(\"../lib/hel|per.js\")", "a.js")).toBe("../lib/helper.js");
    // a quoted word that is no path is the word itself
    expect(at("emit('chan|ged')", "a.js")).toBe("changed");
  });

  it("Vue: kebab-case tag names, PascalCase components, script names", () => {
    expect(at("    <my-wid|get :items=\"items\" />", "A.vue")).toBe("my-widget");
    expect(at("    </my-widget|>", "A.vue")).toBe("my-widget");
    expect(at("    <Cart|Summary />", "A.vue")).toBe("CartSummary");
    expect(at("    <div @click=\"add|Item\">", "A.vue")).toBe("addItem");
    expect(at("import CartSummary from '@/components/Cart|Summary.vue'", "A.vue")).toBe("@/components/CartSummary.vue");
    // an attribute name with a dash is not a tag
    expect(at("    <div data-te|st=\"x\">", "A.vue")).toBe("test");
  });

  it("JSP: custom tags, include paths, scriptlet names, the container's tags left alone", () => {
    expect(at("<ui:pan|el title=\"x\">", "a.jsp")).toBe("ui:panel");
    expect(at("</ui:panel|>", "a.jsp")).toBe("ui:panel");
    expect(at("<%@ include file=\"/WEB-INF/views/ro|w.jspf\" %>", "a.jsp")).toBe("/WEB-INF/views/row.jspf");
    expect(at("<jsp:include page=\"ro|w.jsp\" />", "a.jsp")).toBe("row.jsp");
    expect(at("<jsp:incl|ude page=\"row.jsp\" />", "a.jsp")).toBe("include");
    expect(at("<% String t = format|Total(cart); %>", "a.jsp")).toBe("formatTotal");
    expect(at("<c:out value=\"${cart.to|tal}\"/>", "a.jsp")).toBe("total");
  });

  it("nothing on keywords, numbers, spaces and punctuation", () => {
    expect(at("    pub|lic class A {", "A.java")).toBeNull();
    expect(at("    int x = 12|3;", "A.java")).toBeNull();
    expect(at("    a  |  b", "A.java")).toBeNull();
    expect(at("    (|)", "A.java")).toBeNull();
    expect(identifierAt("abc", 9)).toBeNull();
  });

  it("gives the range the name covers (the underline)", () => {
    expect(identifierAt("  CartService x", 4)).toEqual({ symbol: "CartService", start: 2, end: 13 });
    expect(identifierAt("<ui:panel>", 3)).toEqual({ symbol: "ui:panel", start: 1, end: 9 });
  });

  it("sends only what the engine takes", () => {
    expect(isSendableSymbol("a.b.C")).toBe(true);
    expect(isSendableSymbol("my widget")).toBe(false);
    expect(isSendableSymbol("f()")).toBe(false);
    expect(isSendableSymbol("한글")).toBe(false);
    expect(isSendableSymbol("x".repeat(201))).toBe(false);
  });

  it("§65.6: names the receiver written in front of the word (find_definition's receiver)", () => {
    const rec = (marked: string, path = "A.java") => {
      const offset = marked.indexOf("|");
      return identifierAt(marked.replace("|", ""), offset, path)?.receiver ?? null;
    };
    expect(rec("        return this.tot|al;")).toBe("this");
    expect(rec("    cartService.addI|tem(item);")).toBe("cartService");
    expect(rec("val n = user?.na|me", "A.kt")).toBe("user");
    expect(rec("val n = user!!.na|me", "A.kt")).toBe("user");
    expect(rec("list.map(Repo::cre|ate)", "A.kt")).toBe("Repo");
    expect(rec("node->ne|xt", "a.c")).toBe("node");
    expect(rec("items.forEach { it -> sa|ve(it) }", "A.kt")).toBeNull();
    expect(rec("this.gate . refr|esh()", "a.ts")).toBe("gate");
    // unqualified, or after a call / index: nothing is known
    expect(rec("    total|();")).toBeNull();
    expect(rec("    foo().ba|r();")).toBeNull();
    expect(rec("    items[0].pri|ce")).toBeNull();
    // a type through its package names no receiver (the chain is the symbol)
    expect(identifierAt("    com.acme.Money.of(1)", 15)).toEqual({ symbol: "com.acme.Money", start: 4, end: 18 });
    expect(receiverBefore("x = 1.5", 6)).toBeUndefined();
    expect(identifierAt("  cart.total", 9)).toEqual({ symbol: "total", start: 7, end: 12, receiver: "cart" });
  });
});
