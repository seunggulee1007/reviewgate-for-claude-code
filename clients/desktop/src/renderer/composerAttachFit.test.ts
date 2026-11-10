import { describe, expect, it } from "vitest";
import { fitSize, fitTries, MAX_ATTACHMENT_BYTES, renamedFor } from "../shared/attachments";
import { fitImage } from "./composerAttach";

/**
 * r2-chats-cards M34 — §24 "A big image is scaled down, not refused": the tries (≤ 2000 px, then 1600 / 1200; PNG while it
 * fits, else JPEG at falling quality), the size each is drawn at, and what is attached — the canvas stands in as an encoder.
 */
describe("big images are scaled down (§24, M34)", () => {
  it("the tries and sizes", () => {
    expect(fitTries("image/png", true).slice(0, 4)).toEqual([
      { edge: 2000, type: "image/png" },
      { edge: 2000, type: "image/jpeg", quality: 0.85 },
      { edge: 2000, type: "image/jpeg", quality: 0.7 },
      { edge: 2000, type: "image/jpeg", quality: 0.55 },
    ]);
    expect(fitTries("image/jpeg", false).every((t) => t.type === "image/jpeg")).toBe(true);
    expect(fitTries("image/jpeg", false).map((t) => t.edge)).toEqual([2000, 2000, 2000, 1600, 1600, 1600, 1200, 1200, 1200]);
    expect(fitSize(5120, 2880, 2000)).toEqual({ width: 2000, height: 1125 });
    expect(fitSize(800, 600, 2000)).toEqual({ width: 800, height: 600 });
    expect(renamedFor("clipboard.png", "image/jpeg")).toBe("clipboard.jpg");
    expect(renamedFor("shot", "image/png")).toBe("shot.png");
  });

  it("the first try that fits is attached, under its type and name; none → still too large", async () => {
    const seen: string[] = [];
    const fits = await fitImage("screen.png", "image/png", async (t) => {
      seen.push(`${t.edge} ${t.type} ${t.quality ?? ""}`.trim());
      return new Uint8Array(t.type === "image/jpeg" && t.quality === 0.7 ? 1024 : MAX_ATTACHMENT_BYTES + 1);
    }, 9_000_000);
    expect(seen).toEqual(["2000 image/png", "2000 image/jpeg 0.85", "2000 image/jpeg 0.7"]);
    expect(fits.ok && fits.image).toMatchObject({ name: "screen.jpg", bytes: 1024, resizedFrom: 9_000_000, attachment: { kind: "image", mediaType: "image/jpeg" } });
    const never = await fitImage("huge.png", "image/png", async () => new Uint8Array(MAX_ATTACHMENT_BYTES + 1), 30_000_000);
    expect(never.ok).toBe(false);
  });
});
