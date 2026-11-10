import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fenceFor } from "../side/context.js";

/**
 * §51 `pr_ai_draft`: a read-only fork of the main session writes the PR sheet's title and description. It works from the
 * branch's commits and diff since the base, the repository's pull request template and what the sheet holds. Nothing is
 * pushed or created: the answer only fills the sheet.
 */

/** The branch's diff in the prompt: at most this many lines (the file summary always goes in whole). */
export const PR_AI_DIFF_LINES = 3000;
/** The pull request template is cut at this many chars. */
export const PR_AI_TEMPLATE_MAX = 8000;
/** The commit messages (subject and body, oldest first) are cut at this many chars. */
export const PR_AI_COMMITS_MAX = 12_000;
export const PR_AI_TITLE_MAX = 256;
export const PR_AI_BODY_MAX = 20_000;

export const PR_AI_DRAFT_HEADER = "[Pull request draft — read-only, next to the main conversation]";

/** The system-prompt append of the fork (replaces the side question's). */
export const PR_AI_DRAFT_SYSTEM =
  "You are writing a pull request title and description for the user, in a separate read-only session next to the coding " +
  "session above. Do not modify files, run mutating commands or start agents — those calls are refused. You may read code " +
  "with read-only tools if the diff alone is unclear. Answer in the format asked for, nothing else.";

/** Where GitHub looks for a pull request template (the name in any case); the first found wins. */
const TEMPLATE_DIRS = [".github", "", "docs"];
const TEMPLATE_NAME = "pull_request_template.md";
const TEMPLATE_FOLDER = "pull_request_template";

/** The repository's pull request template (`.github/`, the root, `docs/`, then the first `.md` of `.github/PULL_REQUEST_TEMPLATE/`), cut at `PR_AI_TEMPLATE_MAX`; null without one. */
export async function findPRTemplate(root: string): Promise<{ path: string; text: string } | null> {
  const read = async (rel: string) => {
    const text = await readFile(join(root, rel), "utf8").catch(() => null);
    return text !== null && text.trim() ? { path: rel, text: text.length > PR_AI_TEMPLATE_MAX ? text.slice(0, PR_AI_TEMPLATE_MAX) : text } : null;
  };
  const entries = async (dir: string) => (await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dir of TEMPLATE_DIRS) {
    const file = (await entries(dir)).find((e) => e.isFile() && e.name.toLowerCase() === TEMPLATE_NAME);
    const found = file ? await read(dir ? `${dir}/${file.name}` : file.name) : null;
    if (found) return found;
  }
  const folder = (await entries(".github")).find((e) => e.isDirectory() && e.name.toLowerCase() === TEMPLATE_FOLDER);
  if (folder) {
    for (const e of await entries(`.github/${folder.name}`)) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
      const found = await read(`.github/${folder.name}/${e.name}`);
      if (found) return found;
    }
  }
  return null;
}

export type PRAiDraftInput = {
  branch: string;
  /** What the PR is compared with (`origin/<base>`, else `<base>`). */
  baseRef: string;
  /** Full commit messages, oldest first. */
  commits: string[];
  /** `git diff --stat` of the branch since the base. */
  stat: string;
  patch: { text: string; truncated: boolean; lines: number };
  template: { path: string; text: string } | null;
  /** What the sheet holds now (filled from the commits, or typed). */
  title: string;
  body: string;
};

/** The fork's prompt. */
export function prAiDraftPrompt(input: PRAiDraftInput): string {
  const parts: string[] = [
    PR_AI_DRAFT_HEADER,
    `Write the pull request title and description for branch ${input.branch}, to be merged into ${input.baseRef}. ` +
      "Use what this conversation knows about the task (why the change was made), the commits and the diff below.",
  ];
  const commits = input.commits.join("\n\n---\n\n");
  const cut = commits.length > PR_AI_COMMITS_MAX ? `${commits.slice(0, PR_AI_COMMITS_MAX)}\n…` : commits;
  if (cut.trim()) {
    const f = fenceFor(cut);
    parts.push(`Commits of the branch (oldest first):\n${f}\n${cut}\n${f}`);
  }
  if (input.title.trim() || input.body.trim()) {
    const draft = [`Title: ${input.title.trim()}`, "", input.body.trim()].join("\n");
    const f = fenceFor(draft);
    parts.push(
      `The draft in the pull request sheet now:\n${f}\n${draft}\n${f}\n` +
        "Keep the title's prefix and issue key exactly as they are (for example `#project/123: `, `ABC-123 `, `feat(x): `).",
    );
  }
  if (input.template) {
    const f = fenceFor(input.template.text);
    parts.push(
      `The repository's pull request template (${input.template.path}) — fill in its sections and keep its headings, ` +
        `checklists and order; leave out a section only when it is clearly not relevant:\n${f}markdown\n${input.template.text.replace(/\n$/, "")}\n${f}`,
    );
  }
  if (input.stat.trim()) parts.push(`Files changed:\n${input.stat.replace(/\n$/, "")}`);
  if (input.patch.text) {
    const f = fenceFor(input.patch.text);
    parts.push(`The diff${input.patch.truncated ? ` (cut after ${input.patch.lines} lines; read the files for the rest)` : ""}:\n${f}diff\n${input.patch.text.replace(/\n$/, "")}\n${f}`);
  }
  parts.push(
    [
      "Write in the language of the commit messages and the template.",
      input.template
        ? "The description follows the template."
        : "The description, in Markdown: a short summary of what changed and why, the main changes as a list, and how it was tested or should be checked.",
      "Do not invent things the commits, the diff or the conversation do not show (no ticket numbers, no test results that did not happen).",
      "Answer exactly in this form, nothing before or after it:",
      "TITLE: <one line>",
      "BODY:",
      "<the description>",
    ].join("\n"),
  );
  return parts.join("\n\n");
}

/** `TITLE:` / `**Title:**` / `**Title**:` at a line's start (any case). */
const TITLE_LABEL = /^\s*(?:\*\*)?title\s*(?::\s*\*\*|\*\*\s*:|:)\s*/i;
const BODY_LABEL = /^\s*(?:\*\*)?body\s*(?::\s*\*\*|\*\*\s*:|:)\s*/i;

/** The fork's answer as a title and a description: a surrounding code fence removed; `TITLE:` / `BODY:` read; cut at their limits. */
export function parsePRAiDraft(text: string): { title: string; body: string } {
  let t = text.replace(/\r\n/g, "\n").trim();
  const whole = /^(?:[^\n`]{0,200}:\s*\n+)?(`{3,})[^\n`]*\n([\s\S]*?)\n\1\s*$/.exec(t);
  if (whole) t = whole[2]!.trim();
  const lines = t.split("\n");
  const titleAt = lines.findIndex((l) => TITLE_LABEL.test(l));
  const bodyAt = lines.findIndex((l, i) => i > titleAt && BODY_LABEL.test(l));
  let title = "";
  let body: string;
  if (titleAt < 0) {
    body = t;
  } else {
    title = lines[titleAt]!.replace(TITLE_LABEL, "").trim();
    if (bodyAt < 0) {
      body = lines.slice(titleAt + 1).join("\n");
    } else {
      const first = lines[bodyAt]!.replace(BODY_LABEL, "");
      body = [first, ...lines.slice(bodyAt + 1)].join("\n");
    }
  }
  title = title.replace(/^["'`]+|["'`]+$/g, "").split("\n")[0]!.trim();
  body = body.trim();
  return { title: title.slice(0, PR_AI_TITLE_MAX), body: body.length > PR_AI_BODY_MAX ? body.slice(0, PR_AI_BODY_MAX) : body };
}

/** The first `maxLines` lines of a diff and whether it was cut. */
export function cutPatch(text: string, maxLines: number): { text: string; truncated: boolean; lines: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false, lines: lines.length };
  return { text: `${lines.slice(0, maxLines).join("\n")}\n`, truncated: true, lines: maxLines };
}
