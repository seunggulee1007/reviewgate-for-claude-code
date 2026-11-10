import { describe, expect, it } from "vitest";
import { isImageDataURL, MAX_IMAGE_DATA_URL } from "./ipcGuard";

// polish p-foundation — P4-composer-40: `rg:copyImage` puts an image the renderer shows on the clipboard, nothing else.

describe("rg:copyImage", () => {
  it("takes an image the renderer shows, nothing else", () => {
    expect(isImageDataURL("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isImageDataURL("data:image/webp;base64,UklGRg==")).toBe(true);
    expect(isImageDataURL("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isImageDataURL("data:text/html;base64,PGgxPg==")).toBe(false);
    expect(isImageDataURL("file:///etc/passwd")).toBe(false);
    expect(isImageDataURL("data:image/png;base64,abc def")).toBe(false);
    expect(isImageDataURL(42)).toBe(false);
    expect(isImageDataURL("data:image/png;base64," + "A".repeat(MAX_IMAGE_DATA_URL))).toBe(false);
  });
});
