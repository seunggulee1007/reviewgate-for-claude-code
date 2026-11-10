import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandRefused } from "../errors.js";
import { IMAGE_MEDIA_TYPES, type AttachmentRef, type ImageMediaType } from "../protocol.js";

/** §24 limits: at most this many images per message, each at most this many bytes once decoded. */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const ATTACHMENTS_DIR = join("reviewgate", "attachments");

const EXT: Record<ImageMediaType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** A validated image: what the session sends (`dataBase64`) and what the transcript keeps (`ref`). */
export type PreparedImage = { ref: AttachmentRef; mediaType: ImageMediaType; dataBase64: string; data: Buffer };

/**
 * Validates `send.attachments` (§24). Refused: `too_many_attachments` (> 5), `attachment_type` (not an image of
 * png / jpeg / gif / webp, or bytes that are not that type), `attachment_too_large` (> 5 MiB decoded),
 * `attachment_invalid` (not base64, empty).
 */
export function prepareAttachments(raw: unknown): PreparedImage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new CommandRefused("attachment_invalid:attachments must be an array", { code: "attachment_invalid" });
  if (raw.length > MAX_ATTACHMENTS) throw new CommandRefused(`too_many_attachments:${raw.length} > ${MAX_ATTACHMENTS}`, { code: "too_many_attachments" });
  return raw.map((a, i) => prepareOne(a, i));
}

function prepareOne(a: unknown, i: number): PreparedImage {
  const o = (a && typeof a === "object" ? a : {}) as { kind?: unknown; mediaType?: unknown; dataBase64?: unknown };
  if (o.kind !== "image") throw new CommandRefused(`attachment_type:#${i} kind ${String(o.kind)}`, { code: "attachment_type" });
  const mediaType = o.mediaType;
  if (typeof mediaType !== "string" || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw new CommandRefused(`attachment_type:#${i} ${String(mediaType)}`, { code: "attachment_type" });
  }
  if (typeof o.dataBase64 !== "string") throw new CommandRefused(`attachment_invalid:#${i} no data`, { code: "attachment_invalid" });
  const b64 = o.dataBase64.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
  // Decoded size from the length: refuse a huge payload before decoding it.
  if (Math.floor((b64.length * 3) / 4) - 2 > MAX_ATTACHMENT_BYTES) {
    throw new CommandRefused(`attachment_too_large:#${i} > ${MAX_ATTACHMENT_BYTES} bytes`, { code: "attachment_too_large" });
  }
  if (b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new CommandRefused(`attachment_invalid:#${i} not base64`, { code: "attachment_invalid" });
  }
  const data = Buffer.from(b64, "base64");
  if (data.length === 0) throw new CommandRefused(`attachment_invalid:#${i} empty`, { code: "attachment_invalid" });
  if (data.length > MAX_ATTACHMENT_BYTES) throw new CommandRefused(`attachment_too_large:#${i} ${data.length} > ${MAX_ATTACHMENT_BYTES} bytes`, { code: "attachment_too_large" });
  const sniffed = sniffImage(data);
  if (sniffed !== mediaType) throw new CommandRefused(`attachment_type:#${i} bytes are ${sniffed ?? "not an image"}, not ${mediaType}`, { code: "attachment_type" });
  const hash = createHash("sha256").update(data).digest("hex");
  return { ref: { kind: "image", hash, mediaType, bytes: data.length }, mediaType, dataBase64: b64, data };
}

/** The image type the magic bytes say (PNG, JPEG, GIF, WebP), or null. */
export function sniffImage(b: Buffer): ImageMediaType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export function attachmentPath(gitDir: string, hash: string, mediaType: ImageMediaType): string {
  return join(gitDir, ATTACHMENTS_DIR, `${hash}.${EXT[mediaType]}`);
}

/** Writes each image once (content-addressed, atomic temp + rename). */
export async function storeAttachments(gitDir: string, images: readonly PreparedImage[]): Promise<void> {
  if (images.length === 0) return;
  await mkdir(join(gitDir, ATTACHMENTS_DIR), { recursive: true });
  for (const img of images) {
    const file = attachmentPath(gitDir, img.ref.hash, img.mediaType);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tmp, img.data, { flag: "wx" });
      await rename(tmp, file);
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}

/** `attachment_get`: the stored image of `hash`, or null (unknown hash, not a sha-256). */
export async function loadAttachment(gitDir: string, hash: string): Promise<{ mediaType: ImageMediaType; data: Buffer } | null> {
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
  for (const mediaType of IMAGE_MEDIA_TYPES) {
    try {
      const data = await readFile(attachmentPath(gitDir, hash, mediaType));
      return { mediaType, data };
    } catch {
      // try the next extension
    }
  }
  return null;
}
