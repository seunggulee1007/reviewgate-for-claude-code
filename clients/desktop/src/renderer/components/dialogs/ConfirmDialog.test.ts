// MARK: polish p-ui-kit — P1-chrome-32 / P2-review-37: a destructive confirm opens with Cancel focused, so Return never
// runs it by itself; any other keeps its action focused. (That the focus lands there, and Return / Tab, are checked in a
// real Chromium; here: which button asks for it.)
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog } from "./ConfirmDialog";

const confirm = (danger: boolean | undefined, busy = false) =>
  renderToStaticMarkup(
    createElement(ConfirmDialog, {
      title: "Reject all?",
      message: "3 files go back as they were.",
      confirmLabel: "Reject all",
      danger,
      busy,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    }),
  );

/** Each button's opening tag, by its test id. */
const button = (html: string, testId: string) => new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";

describe("a confirm's focused button", () => {
  it("a destructive one: Cancel, and the red button does not ask for the focus", () => {
    const html = confirm(true);
    expect(button(html, "Cancel")).toContain("autofocus");
    expect(button(html, "Reject all")).not.toContain("autofocus");
    expect(button(html, "Reject all")).toContain('class="danger"');
  });

  it("any other: its action, as before", () => {
    for (const danger of [false, undefined]) {
      const html = confirm(danger);
      expect(button(html, "Reject all")).toContain("autofocus");
      expect(button(html, "Reject all")).toContain('class="primary"');
      expect(button(html, "Cancel")).not.toContain("autofocus");
    }
  });

  it("busy: both buttons off (the dialog itself takes the focus)", () => {
    const html = confirm(true, true);
    expect(button(html, "Cancel")).toContain("disabled");
    expect(button(html, "Reject all")).toContain("disabled");
  });
});
