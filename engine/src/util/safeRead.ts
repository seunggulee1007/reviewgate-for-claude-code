/**
 * MARK: wave6 w6-statusline — reading a settings-like file a repository (or anyone) may have put there: only a regular
 * file (a symlink is followed) of at most `max` bytes is read — never a device (`/dev/zero` fills memory), a FIFO or
 * `/dev/stdin` (a read blocks the engine and its command pipe). The file is opened non-blocking and checked through its
 * own descriptor, so swapping it for a FIFO after a check cannot block the read.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export const SETTINGS_FILE_MAX = 1024 * 1024;

export type SafeRead = { text: string } | { error: "absent" | "not_file" | "too_large" | "unreadable"; detail?: string };

export function safeReadText(path: string, max = SETTINGS_FILE_MAX): SafeRead {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { error: "absent" } : { error: "unreadable", detail: code ?? String(e) };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: "not_file" };
    if (st.size > max) return { error: "too_large", detail: String(st.size) };
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buf, read, st.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buf.toString("utf8", 0, read) };
  } catch (e) {
    return { error: "unreadable", detail: (e as NodeJS.ErrnoException).code ?? String(e) };
  } finally {
    closeSync(fd);
  }
}

/** The text of a small regular file, else null (absent, not a file, too large, unreadable). */
export function safeReadOrNull(path: string, max = SETTINGS_FILE_MAX): string | null {
  const r = safeReadText(path, max);
  return "text" in r ? r.text : null;
}

/** `s` with every lone surrogate half replaced by U+FFFD (String.prototype.toWellFormed; ES2022 has no type for it). */
export function wellFormed(s: string): string {
  return /[\uD800-\uDFFF]/.test(s) ? s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�") : s;
}

/**
 * One NDJSON line's JSON text with every escaped lone surrogate (`\udc00`, which JSON.stringify writes for one) made
 * U+FFFD: Swift's JSONDecoder refuses the whole line for one. A pair is written as the characters, never escaped.
 */
export function wellFormedJson(json: string): string {
  return json.includes("\\ud") || json.includes("\\uD") ? json.replace(/(?<!\\)((?:\\\\)*)\\u[dD][89a-fA-F][0-9a-fA-F]{2}/g, "$1\\ufffd") : json;
}
