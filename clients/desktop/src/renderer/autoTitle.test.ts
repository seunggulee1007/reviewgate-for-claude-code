// MARK: polish p-ui-kit — PX-09: cut text reads in full on hover. (The real page — computed styles, the pointer, a
// component writing over a title — is checked in a real Chromium; here the rules, on plain objects.)
import { describe, expect, it } from "vitest";
import { autoTitleFor, updateAutoTitle, type CutStyle, type TitleTarget } from "./autoTitle";

/** An element as the module sees it, with what a test changes (its box, its text) writable. */
interface Fake {
  attrs: Map<string, string>;
  parentElement: Fake | null;
  classList: { contains(name: string): boolean };
  dataset: Record<string, string | undefined>;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  innerText: string;
  textContent: string | null;
  style: CutStyle;
  skip: boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  closest(selector: string): unknown;
}

function fake(o: { cls?: string[]; title?: string; wide?: number; box?: number; tall?: number; high?: number; text?: string; parent?: Fake | null; style?: CutStyle; skip?: boolean } = {}): Fake {
  const attrs = new Map<string, string>();
  if (o.title !== undefined) attrs.set("title", o.title);
  const el: Fake = {
    attrs,
    parentElement: o.parent ?? null,
    classList: { contains: (name: string) => (o.cls ?? []).includes(name) },
    dataset: {},
    scrollWidth: o.wide ?? 100,
    clientWidth: o.box ?? 100,
    scrollHeight: o.tall ?? 20,
    clientHeight: o.high ?? 20,
    innerText: o.text ?? "",
    textContent: o.text ?? "",
    style: o.style ?? null,
    skip: o.skip ?? false,
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => void attrs.set(name, value),
    removeAttribute: (name) => void attrs.delete(name),
    closest: () => null,
  };
  // closest(SKIP): this element or one above it is a field / opts out
  el.closest = () => {
    for (let at: Fake | null = el; at; at = at.parentElement) if (at.skip) return at;
    return null;
  };
  return el;
}

const styleOf = (el: TitleTarget) => (el as Fake).style;
const hover = (el: Fake) => updateAutoTitle(el, styleOf);
const PATH = "src/main/java/com/acme/review/ReviewService.java";

describe("the tooltip a cut text gets", () => {
  it("its whole text; under it a row's own tooltip, unless that already holds the text", () => {
    expect(autoTitleFor(PATH, null)).toBe(PATH);
    expect(autoTitleFor(`  ${PATH}\n`, null)).toBe(PATH);
    expect(autoTitleFor("ReviewService.java", "Open in editor (⌘O)")).toBe("ReviewService.java\nOpen in editor (⌘O)");
    expect(autoTitleFor("ReviewService.java", PATH)).toBeNull();
    expect(autoTitleFor("리뷰 대기\n파일 3개", "리뷰 대기 파일 3개 — 눌러서 열기")).toBeNull(); // line breaks as spaces
    // a name and its folder against the full path: every word is in it
    expect(autoTitleFor("ReviewService.java — src/main/java/com/acme/review", PATH)).toBeNull();
    // a word the row's tooltip does not have: both
    expect(autoTitleFor("ReviewService.java — 3 changes", PATH)).toBe(`ReviewService.java — 3 changes\n${PATH}`);
  });

  it("none for no text, or under a row that asked for no tooltip (title=\"\")", () => {
    expect(autoTitleFor("   ", null)).toBeNull();
    expect(autoTitleFor(PATH, "")).toBeNull();
  });

  it("a very long text is cut", () => {
    const title = autoTitleFor("가".repeat(5000), null)!;
    expect(title.length).toBe(1000);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("hovering cut text", () => {
  it("a .truncate that is cut gets its whole text; once it fits, the tooltip goes", () => {
    const el = fake({ cls: ["truncate"], wide: 240, box: 120, text: PATH });
    hover(el);
    expect(el.getAttribute("title")).toBe(PATH);
    el.clientWidth = 300; // the pane grew
    hover(el);
    expect(el.getAttribute("title")).toBeNull();
    expect(el.dataset.autoTitle).toBeUndefined();
  });

  it("one that fits gets none; nor an inline one (it cuts nothing) or one not shown — no box", () => {
    const el = fake({ cls: ["truncate"], wide: 80, box: 120, text: "짧은 이름" });
    hover(el);
    expect(el.getAttribute("title")).toBeNull();
    const inline = fake({ cls: ["truncate"], wide: 240, box: 0, high: 0, text: PATH });
    hover(inline);
    expect(inline.getAttribute("title")).toBeNull();
  });

  it("the text changed: the tooltip follows it", () => {
    const el = fake({ cls: ["truncate"], wide: 240, box: 120, text: PATH });
    hover(el);
    el.innerText = `${PATH}.bak`;
    hover(el);
    expect(el.getAttribute("title")).toBe(`${PATH}.bak`);
  });

  it("a tooltip the component wrote stays — also one written over ours, which is then theirs", () => {
    const own = fake({ cls: ["truncate"], wide: 240, box: 120, text: PATH, title: "직접 단 툴팁" });
    hover(own);
    expect(own.getAttribute("title")).toBe("직접 단 툴팁");
    const el = fake({ cls: ["truncate"], wide: 240, box: 120, text: PATH });
    hover(el);
    el.setAttribute("title", "새 툴팁"); // React set the title prop
    el.clientWidth = 300;
    hover(el);
    expect(el.getAttribute("title")).toBe("새 툴팁");
  });

  it("a row's tooltip around it: kept under the whole text, or alone when it already holds the text", () => {
    const row = fake({ title: "Claude가 작업 중이에요" });
    const label = fake({ cls: ["truncate"], wide: 240, box: 120, text: "feature/acme-1502-very-long-branch", parent: row });
    hover(label);
    expect(label.getAttribute("title")).toBe("feature/acme-1502-very-long-branch\nClaude가 작업 중이에요");
    const fileRow = fake({ title: PATH });
    const name = fake({ cls: ["truncate"], wide: 240, box: 120, text: "ReviewService.java", parent: fileRow });
    hover(name);
    expect(name.getAttribute("title")).toBeNull();
  });

  it("our own tooltip higher up is no row tooltip", () => {
    const outer = fake({ cls: ["truncate"], wide: 400, box: 200, text: `${PATH} 외 2개` });
    hover(outer);
    const inner = fake({ cls: ["truncate"], wide: 240, box: 120, text: PATH, parent: outer });
    hover(inner);
    expect(inner.getAttribute("title")).toBe(PATH);
  });

  it("the cut text may be a few levels up from the element under the pointer (a <b> in the label)", () => {
    const label = fake({ cls: ["truncate"], wide: 240, box: 120, text: PATH });
    const bold = fake({ parent: label, text: "ReviewService" });
    hover(bold);
    expect(label.getAttribute("title")).toBe(PATH);
    expect(bold.getAttribute("title")).toBeNull();
  });

  it("an inner span that cuts nothing, or fits: the block around it that is cut gets it", () => {
    const block = fake({ style: "line", wide: 300, box: 200, text: `ReviewStore ${PATH}` });
    const inline = fake({ cls: ["truncate"], box: 0, high: 0, text: "ReviewStore", parent: block });
    hover(inline);
    expect(block.getAttribute("title")).toBe(`ReviewStore ${PATH}`);
    expect(inline.getAttribute("title")).toBeNull();
    const fits = fake({ cls: ["truncate"], wide: 60, box: 80, text: "ReviewStore", parent: block });
    block.removeAttribute("title");
    delete block.dataset.autoTitle;
    hover(fits);
    expect(block.getAttribute("title")).toBe(`ReviewStore ${PATH}`);
  });

  it("a component's tooltip on the inner one covers the block too", () => {
    const block = fake({ style: "line", wide: 300, box: 200, text: PATH });
    const inner = fake({ cls: ["truncate"], wide: 300, box: 200, text: PATH, title: "직접 단 툴팁", parent: block });
    hover(inner);
    expect(inner.getAttribute("title")).toBe("직접 단 툴팁");
    expect(block.getAttribute("title")).toBeNull();
  });

  it("styled cuts count too: an ellipsis without .truncate, a line clamp (by its height)", () => {
    const ellipsis = fake({ style: "line", wide: 300, box: 200, text: "git push --force-with-lease origin feature/PAY-1502" });
    hover(ellipsis);
    expect(ellipsis.getAttribute("title")).toBe("git push --force-with-lease origin feature/PAY-1502");
    const clamp = fake({ style: "lines", tall: 80, high: 40, text: "두 줄을 넘는 설명이에요." });
    hover(clamp);
    expect(clamp.getAttribute("title")).toBe("두 줄을 넘는 설명이에요.");
    const fits = fake({ style: "lines", tall: 40, high: 40, text: "한 줄" });
    hover(fits);
    expect(fits.getAttribute("title")).toBeNull();
  });

  it("nothing inside a field, the code editor or a spot that opts out; nothing on text that is not cut by style", () => {
    const field = fake({ skip: true });
    const inField = fake({ cls: ["truncate"], wide: 240, box: 120, text: PATH, parent: field });
    hover(inField);
    expect(inField.getAttribute("title")).toBeNull();
    const plain = fake({ wide: 240, box: 120, text: PATH }); // overflows, but nothing cuts it (it scrolls, or wraps)
    hover(plain);
    expect(plain.getAttribute("title")).toBeNull();
  });
});
