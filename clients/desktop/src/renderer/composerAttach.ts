/**
 * Composer images (docs/PROTOCOL.md §24): a pasted / dropped `File` or a file the attach button's dialog read in main
 * becomes a `DraftImage` (the `SendAttachment` plus a name and a data: URL for the chip — the page's CSP allows
 * `img-src data:` only). Checked like the engine checks (src/shared/attachments.ts); a refusal is the §24 code with the
 * file named, in the same words as the engine's refusal.
 */
import type { SendAttachment } from "@reviewgate/engine";
import { attachmentRoom, checkImage, fitSize, fitTries, fitWith, MAX_ATTACHMENT_BYTES, renamedFor, sniffImageType, type AttachmentProblem, type FitTry, type ImageType, type PickedImage } from "../shared/attachments";
import { refusalCodeText } from "./errorCodes";

export type DraftImage = { id: number; name: string; bytes: number; attachment: SendAttachment; url: string
  /** r2-chats-cards M34 (§24): the size it came in at when it was scaled down to fit. */
  resizedFrom?: number };

let seq = 1;

function draftOf(name: string, attachment: SendAttachment, bytes: number, resizedFrom?: number): DraftImage {
  return { id: seq++, name, bytes, attachment, url: `data:${attachment.mediaType};base64,${attachment.dataBase64}`, ...(resizedFrom !== undefined ? { resizedFrom } : {}) };
}

/** Bytes → base64 (no data: prefix). */
function base64Of(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** How the page draws one try: a canvas of the try's size, white under a JPEG (no transparency there). */
export type ImageEncoder = (t: FitTry) => Promise<Uint8Array | null>;

function canvasEncoder(bitmap: ImageBitmap): ImageEncoder {
  return async (t) => {
    const size = fitSize(bitmap.width, bitmap.height, t.edge);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    if (t.type === "image/jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size.width, size.height);
    }
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, t.type, t.quality));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  };
}

/**
 * r2-chats-cards M34 (§24): an image over the limit (a pasted Retina screenshot) scaled down and re-encoded until it fits —
 * `fitTries` (≤ 2000 px, then 1600 / 1200; PNG while it fits, else JPEG). `encoder` stands in for the canvas in tests.
 */
export async function fitImage(name: string, type: ImageType, encoder: ImageEncoder, originalBytes: number): Promise<{ ok: true; image: DraftImage } | { ok: false; text: string }> {
  const fit = await fitWith(fitTries(type, type !== "image/jpeg"), encoder);
  if (!fit) return { ok: false, text: attachmentProblemText("attachment_too_large", name) };
  return { ok: true, image: draftOf(renamedFor(name, fit.type), { kind: "image", mediaType: fit.type, dataBase64: base64Of(fit.bytes) }, fit.bytes.length, originalBytes) };
}

/** A §24 code about one file, in words ("PNG, JPEG, GIF, WebP 이미지만 … (화면.bmp)"). */
export function attachmentProblemText(code: AttachmentProblem | "too_many_attachments", name: string): string {
  return refusalCodeText(code, code === "too_many_attachments" ? "" : name) ?? code;
}

/** Reads a browser `File` (paste / drop) as base64 — the bytes' magic number decides the type. */
export async function readImageFile(file: File): Promise<{ ok: true; image: DraftImage } | { ok: false; text: string }> {
  const name = file.name || "image";
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const v = checkImage(file.type, head, Math.min(file.size, MAX_ATTACHMENT_BYTES));
    if (!v.ok) return { ok: false, text: attachmentProblemText(v.code, name) };
    if (file.size > MAX_ATTACHMENT_BYTES) {
      // r2-chats-cards M34 (§24): scaled down to fit instead of refused.
      const type = sniffImageType(head) ?? v.mediaType;
      if (typeof createImageBitmap !== "function" || typeof document === "undefined") return { ok: false, text: attachmentProblemText("attachment_too_large", name) };
      const bitmap = await createImageBitmap(file);
      try {
        return await fitImage(name, type, canvasEncoder(bitmap), file.size);
      } finally {
        bitmap.close();
      }
    }
    const dataURL = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error ?? new Error("read failed"));
      r.readAsDataURL(file);
    });
    const comma = dataURL.indexOf(",");
    const dataBase64 = comma >= 0 ? dataURL.slice(comma + 1) : dataURL;
    if (!dataBase64) return { ok: false, text: attachmentProblemText("attachment_invalid", name) };
    return { ok: true, image: draftOf(name, { kind: "image", mediaType: v.mediaType, dataBase64 }, file.size) };
  } catch {
    return { ok: false, text: attachmentProblemText("attachment_invalid", name) };
  }
}

/** The attach button's result (main already read and checked each file). */
export function pickedToDraft(p: PickedImage): { ok: true; image: DraftImage } | { ok: false; text: string } {
  if (!p.ok) return { ok: false, text: attachmentProblemText(p.code, p.name) };
  return { ok: true, image: draftOf(p.name, { kind: "image", mediaType: p.mediaType, dataBase64: p.dataBase64 }, p.bytes, p.resizedFrom) };
}

/** An image from the transcript (fetched with `attachment_get`) put back into an editor. */
export function storedToDraft(name: string, attachment: SendAttachment, bytes: number): DraftImage {
  return draftOf(name, attachment, bytes);
}

/**
 * Adds what fits next to `current` (≤ 5); returns the new list and the error lines (one per refused file, plus
 * "at most 5" when some did not fit).
 */
export function mergeImages(current: DraftImage[], incoming: ({ ok: true; image: DraftImage } | { ok: false; text: string })[]): { list: DraftImage[]; errors: string[] } {
  const errors: string[] = [];
  const good: DraftImage[] = [];
  for (const r of incoming) {
    if (r.ok) good.push(r.image);
    else errors.push(r.text);
  }
  const room = attachmentRoom(current.length, good.length);
  if (room.dropped > 0) errors.push(attachmentProblemText("too_many_attachments", ""));
  return { list: [...current, ...good.slice(0, room.take)], errors };
}

/** Image files of a clipboard / drop (`DataTransfer`), in order. */
export function imageFilesOf(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items && dt.items.length > 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== "file") continue;
      const f = item.getAsFile();
      if (f && (f.type.startsWith("image/") || f.type === "")) out.push(f);
    }
    return out;
  }
  for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith("image/") || f.type === "") out.push(f);
  return out;
}
