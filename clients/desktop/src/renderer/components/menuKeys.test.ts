// MARK: polish p-ui-kit — P1-chrome-31 / P2-review-31 / P4-composer-12: the menu primitive answers the keys as Windows'
// menus do, and says what it is to a screen reader.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Menu, menuRows, type MenuItem } from "./Menu";
import { firstEnabled, lastEnabled, menuKeyTarget, type MenuNavItem } from "./menuKeys";

const items: MenuNavItem[] = [
  { text: "New Branch…", disabled: true },
  { text: "Refresh", disabled: false },
  { text: "main", disabled: false },
  { text: "Create PR from this branch…", disabled: true },
];

describe("where a key moves the focus in an open menu", () => {
  it("↓ / ↑ go round the items, a disabled one included; from no item they start at the ends that can be chosen", () => {
    expect(menuKeyTarget("ArrowDown", -1, items)).toBe(1);
    expect(menuKeyTarget("ArrowUp", -1, items)).toBe(2);
    expect(menuKeyTarget("ArrowDown", 1, items)).toBe(2);
    expect(menuKeyTarget("ArrowDown", 2, items)).toBe(3);
    expect(menuKeyTarget("ArrowDown", 3, items)).toBe(0);
    expect(menuKeyTarget("ArrowUp", 0, items)).toBe(3);
  });

  it("Home / End jump to the first and the last item", () => {
    expect(menuKeyTarget("Home", 2, items)).toBe(0);
    expect(menuKeyTarget("End", 1, items)).toBe(3);
  });

  it("a letter goes to the next item that starts with it, round from the focused one, in any case", () => {
    expect(menuKeyTarget("r", -1, items)).toBe(1);
    expect(menuKeyTarget("M", 1, items)).toBe(2);
    expect(menuKeyTarget("c", 0, items)).toBe(3);
    const twice: MenuNavItem[] = [{ text: "Open Project…", disabled: false }, { text: "Open in New Window…", disabled: false }, { text: "Prune", disabled: false }];
    expect(menuKeyTarget("o", 0, twice)).toBe(1);
    expect(menuKeyTarget("o", 1, twice)).toBe(0);
    expect(menuKeyTarget("x", 0, twice)).toBeNull();
  });

  it("a Hangul consonant goes to the next item whose first syllable starts with it", () => {
    const ko: MenuNavItem[] = [{ text: "새 브랜치…", disabled: false }, { text: "새로 고침", disabled: false }, { text: "감추기", disabled: false }, { text: "ㄱ자 목록", disabled: false }];
    expect(menuKeyTarget("ㅅ", -1, ko)).toBe(0);
    expect(menuKeyTarget("ㅅ", 0, ko)).toBe(1);
    expect(menuKeyTarget("ㄱ", 1, ko)).toBe(2);
    expect(menuKeyTarget("ㄱ", 2, ko)).toBe(3);
    expect(menuKeyTarget("새", -1, ko)).toBe(0);
    expect(menuKeyTarget("ㄲ", -1, ko)).toBeNull();
  });

  it("other keys, a space and an empty menu do not move it", () => {
    expect(menuKeyTarget("Enter", 1, items)).toBeNull();
    expect(menuKeyTarget(" ", 1, items)).toBeNull();
    expect(menuKeyTarget("Shift", 1, items)).toBeNull();
    expect(menuKeyTarget("ArrowDown", -1, [])).toBeNull();
  });

  it("a menu opened from the keys starts on the first item that can be chosen (↑: the last)", () => {
    expect(firstEnabled(items)).toBe(1);
    expect(lastEnabled(items)).toBe(2);
    const none = [{ text: "No branches", disabled: true }];
    expect(firstEnabled(none)).toBe(0);
    expect(lastEnabled(none)).toBe(0);
  });
});

describe("what the menu says to a screen reader", () => {
  it("the button says it opens a menu and that it is closed; its chevron (an icon, not ▼) is not read", () => {
    const html = renderToStaticMarkup(createElement(Menu, { label: "main", items: [], title: "Switch branch", testId: "Branch switcher" }));
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<span class="chev" aria-hidden="true"><svg class="rg-icon[^"]*"[^>]*><path d="M4.5 6.25 8 9.75l3.5-3.5"><\/path><\/svg><\/span>/);
    expect(html).not.toContain("▼");
    expect(html).not.toContain('role="menu"');
  });

  it("items take focus only from the keys or the pointer; a checked one is a radio item, a disabled one says so", () => {
    const rows: MenuItem[] = [
      { kind: "head", label: "Branches" },
      { kind: "item", label: "main", checked: true },
      { kind: "item", label: "develop", checked: false },
      { kind: "sep" },
      { kind: "item", label: "New Branch…", disabled: true, title: "Claude is working" },
      { kind: "footer", label: "Claude is working" },
    ];
    const html = renderToStaticMarkup(createElement("div", null, menuRows(rows, () => undefined)));
    expect(html).toContain('<div class="head" role="none">Branches</div>');
    expect(html).toContain('role="menuitemradio" aria-checked="true" tabindex="-1"');
    expect(html).toContain('role="menuitemradio" aria-checked="false" tabindex="-1"');
    expect(html).toContain('<div class="sep" role="separator"></div>');
    expect(html).toMatch(/role="menuitem" aria-disabled="true" tabindex="-1" class="item disabled\s*" title="Claude is working"/);
    expect(html).toMatch(/<span class="check" aria-hidden="true"><svg class="rg-icon[^"]*"[^>]*><path d="M3.5 8.5 6.5 11.5 12.5 4.5"><\/path><\/svg><\/span>/);
    expect(html).toContain('<span class="check" aria-hidden="true"></span>');
    expect(html).not.toContain("✓");
    expect(html).toContain('<div class="footer" role="none">Claude is working</div>');
  });
});
