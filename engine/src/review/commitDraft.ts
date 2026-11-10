import type { ChangedFile } from "../git/checkpoint.js";
import { fenceFor } from "../side/context.js";
import { renderTemplate } from "./commitFormat.js";
import { fileListLines, type RoundPatch } from "./roundPatch.js";

/**
 * wave3 engine-flow — §36.11 (daily-05): `commit_draft` asks a read-only fork of the main session for a commit message in
 * the project's format. Nothing is committed: the message only fills the commit sheet's field.
 */

/** The answer is cut at this many chars. */
export const COMMIT_DRAFT_MAX = 5000;
/** The accepted diff in the prompt: at most this many lines, then the file list. */
export const COMMIT_DRAFT_DIFF_LINES = 2000;
/** `git log -20 --no-merges --format=%s`. */
export const COMMIT_DRAFT_SUBJECTS = 20;

export const COMMIT_DRAFT_HEADER = "[Commit message draft — read-only, next to the main conversation]";

/** The system-prompt append of the fork (replaces the side question's). */
export const COMMIT_DRAFT_SYSTEM =
  "You are writing a git commit message for the user, in a separate read-only session next to the coding session above. " +
  "Do not modify files, run mutating commands or start agents — those calls are refused. You may read code with read-only " +
  "tools if the diff alone is unclear. Answer with the commit message only.";

/**
 * §36.11 `{issue}` — since §41.1 the branch's number the recent subjects already use, else its longest run of digits
 * (`feature/PAY-1800-2` → `1800`); "" without one. MARK: wave4c w4c-commit
 */
export { branchIssue } from "./commitFormat.js";

/** `settings.commitTemplate` (or the learned format, §41.1) with `{issue}` and `{branch}` filled in. */
export function renderCommitTemplate(template: string, branch: string | null, usedIssues: readonly string[] = []): string {
  return renderTemplate(template, branch, usedIssues);
}

export type CommitDraftInput = {
  branch: string | null;
  /** The rendered template; null without one. */
  template: string | null;
  // MARK: wave4c w4c-commit — §41.1
  /** Where `template` comes from: the project's setting (the default) or learned from the recent subjects. */
  templateSource?: "settings" | "learned";
  /** Recent subjects that follow the format (newest first). */
  examples?: string[];
  /** Newest first. */
  subjects: string[];
  patch: RoundPatch;
  files: readonly Pick<ChangedFile, "path" | "oldPath" | "status" | "added" | "deleted" | "isBinary">[];
};

/** The fork's prompt. */
export function commitDraftPrompt(input: CommitDraftInput): string {
  const parts: string[] = [COMMIT_DRAFT_HEADER, "Write the git commit message for the accepted changes below (they are what will be committed)."];
  const head: string[] = [`Branch: ${input.branch ?? "(detached HEAD)"}`];
  if (input.template !== null && input.template.trim()) {
    const source = input.templateSource === "learned" ? "the team's format, learned from the recent subjects" : "the project's template";
    head.push(`Message format — ${source}; start the message with it and follow its pattern: ${JSON.stringify(input.template)}`);
    // MARK: wave4c w4c-commit — §41.1: what is still in braces is Claude's to fill; the rest is kept as it is.
    if (/\{[a-z]+\}/.test(input.template)) {
      head.push(
        "Replace each placeholder in braces ({title}, {summary}, {type}, {scope}, …) with words from the change, in the language of the examples; keep the rest of the format exactly (prefixes, issue numbers, separators).",
      );
    }
  }
  if (input.examples && input.examples.length > 0) {
    head.push(["Examples of this format from the repository (newest first):", ...input.examples.map((s) => `- ${s}`)].join("\n"));
  }
  parts.push(head.join("\n"));
  if (input.subjects.length > 0) {
    parts.push(["Recent commit subjects of this repository (newest first) — match their language, style and prefix:", ...input.subjects.map((s) => `- ${s}`)].join("\n"));
  }
  const files = ["Files:", ...fileListLines(input.files)].join("\n");
  if (input.patch.text) {
    const f = fenceFor(input.patch.text);
    parts.push(`Accepted changes (diff from before the review round to now${input.patch.truncated ? `; cut after ${input.patch.lines} lines` : ""}):\n${f}diff\n${input.patch.text.replace(/\n$/, "")}\n${f}`);
  }
  parts.push(files);
  parts.push(
    "Answer with the commit message only: the subject line, then optionally a blank line and a short body (what changed and why). " +
      "No preamble, no code fence, no quotes around it.",
  );
  return parts.join("\n\n");
}

/** The fork's answer as a message: one surrounding code fence (and a one-line preamble before it) removed, trimmed, ≤ 5 000 chars. */
export function cleanCommitDraft(text: string): string {
  let t = text.replace(/\r\n/g, "\n").trim();
  const whole = /^(?:[^\n`]{0,200}:\s*\n+)?(`{3,})[^\n`]*\n([\s\S]*?)\n\1\s*$/.exec(t);
  if (whole) t = whole[2]!.trim();
  return t.length > COMMIT_DRAFT_MAX ? t.slice(0, COMMIT_DRAFT_MAX) : t;
}
