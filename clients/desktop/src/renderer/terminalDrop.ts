/**
 * §57.5 / §57.17: what a drop on a terminal chat's terminal pastes (one bracketed paste, never Enter) — files from the
 * Explorer / Finder as their paths, the way the platform's own terminal writes them, and files dragged from the review list
 * as `@path` mentions. The Mac's Core `TerminalPathText`.
 */

/** POSIX: the characters a shell reads specially get a backslash, as Terminal.app writes a dropped path. */
const POSIX_SPECIAL = /[ \t!"#$&'()*,;<=>?[\\\]^`{|}~]/g;

/** Windows: a path holding one of these goes in double quotes, as Windows Terminal writes a dropped path. */
const WINDOWS_QUOTE = /[\s&()[\]{}^=;!'+,`~%]/;

/** One dropped path as one word of the platform's shell. */
export function dropWord(path: string, platform: string): string {
  if (platform === "win32") return WINDOWS_QUOTE.test(path) ? `"${path}"` : path;
  // A control character (a newline) cannot be backslash-escaped: the whole path single-quoted.
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(path)) return `'${path.replace(/'/g, "'\\''")}'`;
  return path.replace(POSIX_SPECIAL, (c) => `\\${c}`);
}

/** Dropped files: their paths separated by spaces, with one space after (empty for none). */
export function dropText(paths: string[], platform: string): string {
  const words = paths.filter((p) => p.length > 0).map((p) => dropWord(p, platform));
  return words.length === 0 ? "" : `${words.join(" ")} `;
}

/** Files dragged from the review list: `@path` each (`@"…"` when it holds whitespace), with one space after. */
export function mentionText(paths: string[]): string {
  const words = paths.filter((p) => p.length > 0).map((p) => (/\s/.test(p) ? `@"${p.replace(/"/g, '\\"')}"` : `@${p}`));
  return words.length === 0 ? "" : `${words.join(" ")} `;
}
