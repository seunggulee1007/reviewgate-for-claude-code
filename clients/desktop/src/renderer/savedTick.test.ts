import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n } from "./i18n";

// polish p-foundation — P5-sheets-34: "✓ 저장했어요" beside a field shows only after what it stores changed.

beforeAll(() => initI18n("ko", "win32"));
afterAll(() => initI18n("en", "darwin"));

describe("the saved tick", () => {
  it("says nothing until the stored value changes", async () => {
    const { SavedTick } = await import("./components/common/SavedTick");
    const out = renderToStaticMarkup(createElement(SavedTick, { value: "a" }));
    expect(out).toContain('role="status"');
    expect(out).not.toContain("저장");
  });
});
