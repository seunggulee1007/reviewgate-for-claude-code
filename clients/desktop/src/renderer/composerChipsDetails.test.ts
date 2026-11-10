import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n } from "./i18n";

/**
 * r2-chats-cards — polish P4-composer-40 / 42 (docs/PROTOCOL.md §55.6), in English so the words do not wait for ko.json:
 * the image viewer copies the image (as the Mac's preview does), a mention chip's × says what it does in the Mac's words,
 * and an image chip says a click shows it larger.
 */
async function load(copyImage?: (url: string) => Promise<boolean>) {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true, addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), notify: async () => true, onEvent: () => () => undefined, platform: "darwin", ...(copyImage ? { copyImage } : {}) },
  };
  return import("./components/chat/ComposerChips");
}

describe("composer chips' details (§55.6)", () => {
  beforeAll(() => initI18n("en", "darwin"));

  it("the image viewer has 복사 with its key; a mention chip's × and an image chip say what they do", async () => {
    const m = await load(async () => true);
    const viewer = renderToStaticMarkup(createElement(m.ImageViewer, { url: "data:image/png;base64,AA==", name: "shot.png", onClose: () => undefined }));
    expect(viewer).toContain('data-testid="Copy image"');
    expect(viewer).toContain('title="Copy the image to the clipboard (⌘C)"');
    const chip = renderToStaticMarkup(createElement(m.MentionChip, { path: "src/app.ts", onRemove: () => undefined }));
    expect(chip).toContain('title="Remove the mention"');
    const image = { id: 1, name: "shot.png", bytes: 2048, url: "data:image/png;base64,AA==", attachment: { kind: "image" as const, mediaType: "image/png" as const, dataBase64: "AA==" } };
    expect(renderToStaticMarkup(createElement(m.ImageChip, { image }))).toContain("shot.png · 2 KB — click to preview");
    const scaled = renderToStaticMarkup(createElement(m.ImageChip, { image: { ...image, resizedFrom: 9_000_000 } }));
    expect(scaled).toContain("(scaled down from");
  });
});
