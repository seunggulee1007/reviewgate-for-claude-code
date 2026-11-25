import type { OtherChange } from "../protocol.js";

/** Longest subject line `suggestCommitMessage` produces. */
export const COMMIT_SUBJECT_MAX = 72;

const FALLBACK_SUBJECT = "Apply accepted changes";

/**
 * Default commit message (docs/M12-COMMIT.md): the first line of the last user instruction —
 * `[Review gate] …` prefix lines dropped, cut to ≤ 72 chars — then a blank line and the file list.
 */
export function suggestCommitMessage(lastUserText: string | null, files: string[]): string {
  const subject = subjectFrom(lastUserText);
  if (files.length === 0) return subject;
  return `${subject}\n\nFiles:\n${files.map((f) => `- ${f}`).join("\n")}`;
}

/**
 * §68.5: the suggested message of a commit of only changes outside the review (the commit sheet with no review file) —
 * the user's own edits, which Claude's last instruction does not describe. A neutral subject from the files the sheet
 * lists first (the tracked ones; the untracked ones when there are no others): one file is named by what happened to it
 * ("Update README.md", "Add notes.md", "Delete old.ts", "Rename a.ts to b.ts"), more are counted ("Update 3 files").
 */
export function suggestOthersMessage(files: readonly Pick<OtherChange, "path" | "oldPath" | "status" | "untracked">[]): string {
  const tracked = files.filter((f) => !f.untracked);
  const pool = tracked.length > 0 ? tracked : files;
  if (pool.length !== 1) return pool.length === 0 ? "Update files" : `Update ${pool.length} files`;
  const f = pool[0]!;
  const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const subject = f.status === "R" && f.oldPath ? `Rename ${name(f.oldPath)} to ${name(f.path)}`
    : f.untracked || f.status === "A" ? `Add ${name(f.path)}`
    : f.status === "D" ? `Delete ${name(f.path)}`
    : `Update ${name(f.path)}`;
  return subject.length <= COMMIT_SUBJECT_MAX ? subject : subject.slice(0, COMMIT_SUBJECT_MAX - 1).trimEnd() + "…";
}

function subjectFrom(text: string | null): string {
  const line = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("[Review gate]"));
  if (!line) return FALLBACK_SUBJECT;
  if (line.length <= COMMIT_SUBJECT_MAX) return line;
  return line.slice(0, COMMIT_SUBJECT_MAX - 1).trimEnd() + "…";
}
