/**
 * Composer images (docs/PROTOCOL.md §24): a pasted / dropped `File` or a file the attach button's dialog read in main
 * becomes a `DraftImage` (the `SendAttachment` plus a name and a data: URL for the chip — the page's CSP allows
 * `img-src data:` only). Checked like the engine checks (src/shared/attachments.ts); a refusal is the §24 code with the
 * file named, in the same words as the engine's refusal.
 */
import type { SendAttachment } from "@reviewgate/engine";
import { attachmentRoom, checkImage, type AttachmentProblem, type PickedImage } from "../shared/attachments";
import { refusalCodeText } from "./errorCodes";

export type DraftImage = { id: number; name: string; bytes: number; attachment: SendAttachment; url: string };

let seq = 1;

function draftOf(name: string, attachment: SendAttachment, bytes: number): DraftImage {
  return { id: seq++, name, bytes, attachment, url: `data:${attachment.mediaType};base64,${attachment.dataBase64}` };
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
    const v = checkImage(file.type, head, file.size);
    if (!v.ok) return { ok: false, text: attachmentProblemText(v.code, name) };
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
  return { ok: true, image: draftOf(p.name, { kind: "image", mediaType: p.mediaType, dataBase64: p.dataBase64 }, p.bytes) };
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
