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

function subjectFrom(text: string | null): string {
  const line = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("[Review gate]"));
  if (!line) return FALLBACK_SUBJECT;
  if (line.length <= COMMIT_SUBJECT_MAX) return line;
  return line.slice(0, COMMIT_SUBJECT_MAX - 1).trimEnd() + "…";
}
