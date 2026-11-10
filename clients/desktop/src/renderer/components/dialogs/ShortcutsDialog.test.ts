// MARK: wave4d w4d-windows — polish-08: Help › Keyboard Shortcuts renders every row of the table, in Korean, with the
// platform's own column marked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n } from "../../i18n";
import { SHORTCUT_SECTIONS } from "../../shortcutTable";
import { ShortcutsDialog } from "./ShortcutsDialog";

const g = globalThis as { window?: unknown };

describe("ShortcutsDialog", () => {
  beforeAll(() => {
    g.window = { rg: { platform: "win32" } };
    initI18n("ko", "win32");
  });
  afterAll(() => {
    delete g.window;
    initI18n("en", "darwin");
  });

  it("shows every row with both platforms' keys, Windows' column marked on Windows", () => {
    const html = renderToStaticMarkup(createElement(ShortcutsDialog, { onClose: () => undefined }));
    expect(html).toContain("키보드 단축키");
    expect(html).toContain("에이전트 패널 보기/숨기기");
    expect(html).toContain("중단하고 보내기");
    const rows = SHORTCUT_SECTIONS.flatMap((s) => s.rows);
    expect(html.match(/<tr>/g)?.length).toBe(rows.length + SHORTCUT_SECTIONS.length); // + one header row per section
    for (const r of rows) {
      expect(html).toContain(`<td class="mono">${r.mac}</td>`);
      expect(html).toContain(`<td class="mono current">${r.win}</td>`);
    }
  });
});
