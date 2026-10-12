/**
 * Image attachment rules of docs/PROTOCOL.md §24, shared by main (the attach button's file dialog) and the renderer
 * (paste / drag-drop): at most 5 images, each at most 5 MiB decoded, png / jpeg / gif / webp whose magic number matches.
 * The engine checks the same again; these checks only give the user the reason before anything is sent.
 * Pure (no DOM, no Node) so both tsconfigs compile it.
 */

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
/** File-dialog filter extensions for those types. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;
export const MAX_ATTACHMENTS = 5;
/** 5 MiB decoded (§24: 5 242 880 bytes). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export function isImageType(v: unknown): v is ImageType {
  return typeof v === "string" && (IMAGE_TYPES as readonly string[]).includes(v);
}

/** The image type the bytes' magic number says, or null (also for too few bytes). */
export function sniffImageType(b: Uint8Array): ImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** The type a file name's extension declares (null for anything else). */
export function imageTypeOfName(name: string): ImageType | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

/** Why one image is refused — the §24 refusal code — or null when it may be attached. */
export type AttachmentProblem = "attachment_type" | "attachment_too_large" | "attachment_invalid";

/**
 * Checks one image: `declared` is the clipboard / file MIME type (or "" when unknown), `head` at least its first 12 bytes,
 * `size` its decoded length. The magic number decides the type; a declared type that disagrees is `attachment_type`.
 */
export function checkImage(declared: string, head: Uint8Array, size: number): { ok: true; mediaType: ImageType } | { ok: false; code: AttachmentProblem } {
  if (size <= 0) return { ok: false, code: "attachment_invalid" };
  const sniffed = sniffImageType(head);
  if (!sniffed) return { ok: false, code: "attachment_type" };
  if (declared && declared !== sniffed && !(declared === "image/jpg" && sniffed === "image/jpeg")) return { ok: false, code: "attachment_type" };
  if (size > MAX_ATTACHMENT_BYTES) return { ok: false, code: "attachment_too_large" };
  return { ok: true, mediaType: sniffed };
}

/** How many of `incoming` still fit next to `current` attachments (the rest is `too_many_attachments`). */
export function attachmentRoom(current: number, incoming: number): { take: number; dropped: number } {
  const take = Math.max(0, Math.min(incoming, MAX_ATTACHMENTS - current));
  return { take, dropped: incoming - take };
}

/** Decoded size of a base64 string (padding-aware; whitespace ignored). */
export function base64Bytes(b64: string): number {
  const s = b64.replace(/\s+/g, "");
  if (s.length === 0) return 0;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/** "1.2 MB" / "820 KB" / "512 B". */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** What the attach button's dialog returns per picked file (main → renderer). */
export type PickedImage = { name: string } & ({ ok: true; mediaType: ImageType; dataBase64: string; bytes: number } | { ok: false; code: AttachmentProblem });
