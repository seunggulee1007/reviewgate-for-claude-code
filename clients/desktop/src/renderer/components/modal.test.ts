// MARK: polish p-ui-kit — P1-chrome-32 / P5-sheets-06: the dialog primitive is a modal dialog to a screen reader, and the
// focus goes back where it was when a dialog closes. (Tab going round and the focus coming back are checked in a real
// Chromium; node has no DOM.)
import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Modal } from "./Menu";
import { pushDialog, rememberOpener, returnTarget, topDialog } from "./modalDom";

const fake = (connected: boolean, dialog: unknown = null) => ({ isConnected: connected, closest: () => dialog }) as unknown as HTMLElement;

/** A dialog's markup, its children given as JSX gives them (one argument each). */
const modal = (props: Omit<ComponentProps<typeof Modal>, "children">, ...children: ReactNode[]) =>
  renderToStaticMarkup(createElement(Modal, props as ComponentProps<typeof Modal>, ...children));

describe("the dialog primitive", () => {
  it("is a modal dialog named by its title, and can take the focus itself", () => {
    const html = modal({ title: "커밋하기", testId: "Commit dialog" }, createElement("p", null, "본문"));
    const id = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain('role="dialog" aria-modal="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain(`<h3 id="${id}">커밋하기</h3>`);
  });

  it("the body scrolls between the title and the bottom button row, which stay put", () => {
    const html = modal({ title: "커밋하기" }, createElement("textarea"), createElement("div", { className: "actions" }, createElement("button", { className: "primary" }, "커밋")));
    expect(html).toMatch(/<h3 id="[^"]+">커밋하기<\/h3><div class="dialog-body"><textarea><\/textarea><\/div><div class="actions"><button class="primary">커밋<\/button><\/div><\/div>/);
    // no bottom row (the commit dialog's split mode keeps its own inside, its row not rendered): everything scrolls
    const split = modal({ title: "커밋" }, createElement("section", { className: "split" }, createElement("div", { className: "actions" })), false);
    expect(split).toContain('<div class="dialog-body"><section class="split"><div class="actions"></div></section></div></div>');
    // a component last is not a row, whatever its props say
    const Row = (p: { className: string }) => createElement("div", { className: p.className });
    expect(modal({ title: "커밋" }, createElement("p"), createElement(Row, { className: "actions" }))).toContain('<div class="dialog-body"><p></p><div class="actions"></div></div></div>');
    // only a button row: no empty body
    const bare = modal({ title: "닫기" }, createElement("div", { className: "row actions" }));
    expect(bare).not.toContain("dialog-body");
    expect(bare).toContain('<div class="row actions"></div>');
  });

  it("without a title it names nothing", () => {
    const html = modal({ testId: "Image viewer" }, createElement("img", { alt: "screenshot.png" }));
    expect(html).not.toContain("aria-labelledby");
    expect(html).not.toContain("<h3");
  });
});

describe("which dialog has the keys, and where the focus goes back", () => {
  it("the newest open dialog is on top; closing it hands the keys back", () => {
    const settings = fake(true);
    const confirm = fake(true);
    const popSettings = pushDialog(settings);
    const popConfirm = pushDialog(confirm);
    expect(topDialog()).toBe(confirm);
    popConfirm();
    expect(topDialog()).toBe(settings);
    popSettings();
    expect(topDialog()).toBeNull();
  });

  it("back to the opener; when that was a button in a dialog that is gone, to where the focus was before that one", () => {
    const toolbar = fake(true);
    expect(returnTarget(toolbar)).toBe(toolbar);
    const first = fake(false);
    rememberOpener(first, toolbar);
    const buttonInFirst = fake(false, first);
    expect(returnTarget(buttonInFirst)).toBe(toolbar);
    expect(returnTarget(fake(false))).toBeNull();
    expect(returnTarget(null)).toBeNull();
  });
});

describe("a click past the dialog never throws typed text away", () => {
  const root = { querySelectorAll: () => fields } as unknown as HTMLElement;
  const field = (value: string) => ({ value, closest: () => root }) as unknown as HTMLInputElement;
  const editable = (text: string) => ({ textContent: text, closest: () => root }) as unknown as HTMLElement;
  let fields: HTMLElement[] = [];

  it("text as the dialog opened (a generated message too) is no change; typing, or text in a field that came later, is", async () => {
    const { snapshotText, textChanged } = await import("./modalDom");
    const message = field("feat: 생성된 메시지");
    const note = editable("");
    fields = [message, note];
    const opened = snapshotText(root);
    expect(textChanged(root, opened)).toBe(false);
    message.value = "feat: 생성된 메시지 — 고침";
    expect(textChanged(root, opened)).toBe(true);
    message.value = "feat: 생성된 메시지";
    expect(textChanged(root, opened)).toBe(false);
    note.textContent = "메모";
    expect(textChanged(root, opened)).toBe(true);
    note.textContent = "";
    const later = field("");
    fields = [message, note, later];
    expect(textChanged(root, opened)).toBe(false);
    later.value = "새로 쓴 글";
    expect(textChanged(root, opened)).toBe(true);
  });
});

describe("⌘↩ in a dialog", () => {
  const key = (more: Partial<KeyboardEvent> & { nativeEvent?: { isComposing?: boolean } }) => ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...more });
  it("⌘↩ and Ctrl+Enter press the default button; with ⌥ or ⇧, or ending a composition, they do not", async () => {
    const { isDefaultButtonKey } = await import("./modalDom");
    expect(isDefaultButtonKey(key({ metaKey: true }))).toBe(true);
    expect(isDefaultButtonKey(key({ ctrlKey: true }))).toBe(true);
    expect(isDefaultButtonKey(key({}))).toBe(false);
    expect(isDefaultButtonKey(key({ metaKey: true, altKey: true }))).toBe(false);
    expect(isDefaultButtonKey(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isDefaultButtonKey(key({ ctrlKey: true, nativeEvent: { isComposing: true } }))).toBe(false);
    expect(isDefaultButtonKey(key({ ctrlKey: true, key: "a" }))).toBe(false);
  });
});
