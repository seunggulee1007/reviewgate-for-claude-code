/**
 * Composer @-mentions (docs/PROTOCOL.md §23), the pure parts: the `@query` token at the caret, picking an item
 * (the token leaves the text, the path becomes a chip), the "@변경된 파일" shortcut and the 20-mention cap.
 * The engine expands each mention natively (`Referenced files: @path`); the transcript shows them as chips.
 */
import type { ChangedFileState, FileItem } from "@reviewgate/engine";

/** §23: at most 20 mentions per message. */
export const MAX_MENTIONS = 20;
/** `list_files` debounce while typing (ms). */
export const MENTION_DEBOUNCE_MS = 120;
/** The drag payload a ChangedFiles row carries into the composer (one repo-relative path per line). */
export const MENTION_DRAG_TYPE = "application/x-reviewgate-paths";

/** The `@query` the caret is in: `@` at the start or after whitespace, no whitespace up to the caret. */
export function mentionToken(text: string, caret: number): { start: number; query: string } | null {
  if (caret < 1 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** `text` without the token `[start, caret)` — the caret goes where the token was. */
export function removeToken(text: string, start: number, caret: number): { text: string; caret: number } {
  const after = text.slice(caret);
  // One space after a removed token in the middle of the text is dropped too ("see @foo bar" → "see bar").
  const tail = start > 0 && /^\s/.test(after) && /\s$/.test(text.slice(0, start)) ? after.slice(1) : after;
  return { text: text.slice(0, start) + tail, caret: start };
}

/** Adds `paths` (deduplicated, trailing `/` dropped) up to the cap; `overflow` = how many did not fit. */
export function addMentions(current: string[], paths: string[], max = MAX_MENTIONS): { list: string[]; overflow: number } {
  const list = [...current];
  let overflow = 0;
  for (const raw of paths) {
    const p = normalizeMention(raw);
    if (!p || list.includes(p)) continue;
    if (list.length >= max) {
      overflow++;
      continue;
    }
    list.push(p);
  }
  return { list, overflow };
}

/** Repo-relative POSIX path of a mention (`src\\a.ts` → `src/a.ts`, `docs/` → `docs`); "" for nothing usable. */
export function normalizeMention(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** The files of the current review a mention can name (deleted ones excepted, as `list_files` does). */
export function changedMentionPaths(files: Pick<ChangedFileState, "path" | "status">[]): string[] {
  return files.filter((f) => f.status !== "D").map((f) => f.path);
}

/** Case-insensitive subsequence (the engine's matching, without its scoring). */
export function subsequence(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i >= q.length;
}

/** Whether the "@변경된 파일" item belongs in the popover for `query`. */
export function showChangedShortcut(query: string, changedCount: number, label: string): boolean {
  if (changedCount === 0) return false;
  const q = query.trim();
  return q.length === 0 || subsequence(q, label) || subsequence(q, "changed files");
}

/** One row of the popover: the shortcut, or a `list_files` item. */
export type MentionOption = { kind: "changed"; paths: string[] } | { kind: "item"; item: FileItem };

export function mentionOptions(query: string, items: FileItem[], changed: string[], label: string): MentionOption[] {
  const out: MentionOption[] = [];
  if (showChangedShortcut(query, changed.length, label)) out.push({ kind: "changed", paths: changed });
  for (const item of items) out.push({ kind: "item", item });
  return out;
}

/** `src/app/` style display of a list item (directories end in `/`). */
export function mentionLabel(item: Pick<FileItem, "path" | "kind">): string {
  return item.kind === "dir" ? `${normalizeMention(item.path)}/` : item.path;
}

/** Basename + parent for a chip: `{ name: "a.ts", dir: "src/" }`. */
export function splitMention(path: string): { name: string; dir: string } {
  const p = normalizeMention(path);
  const i = p.lastIndexOf("/");
  return i < 0 ? { name: p, dir: "" } : { name: p.slice(i + 1), dir: p.slice(0, i + 1) };
}

/** Paths carried by a drop (our own drag type first, then plain text lines that look like repo paths). */
export function droppedMentionPaths(data: { getData(type: string): string; types: readonly string[] }): string[] {
  if (data.types.includes(MENTION_DRAG_TYPE)) {
    return data
      .getData(MENTION_DRAG_TYPE)
      .split("\n")
      .map(normalizeMention)
      .filter((p) => p.length > 0);
  }
  return [];
}
