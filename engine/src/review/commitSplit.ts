import type { CommitFile, CommitPart, CommitPlan } from "../protocol.js";
import { fenceFor } from "../side/context.js";
import { COMMIT_DRAFT_MAX } from "./commitDraft.js";
import type { RoundPatch } from "./roundPatch.js";

/**
 * §53 `commit_split_draft`: a read-only fork of the main session proposes how the accepted changes split into the smallest
 * meaningful commits (one behavior each), down to hunks. Nothing is committed: the plan fills the commit sheet.
 */

/** Hunk lines (and whole-file diff lines) in the prompt, in all; then only the file list. */
export const COMMIT_SPLIT_LINES = 3000;
/** A plan's `why` is cut at this many chars. */
export const COMMIT_SPLIT_WHY_MAX = 500;

export const COMMIT_SPLIT_HEADER = "[Commit split draft — read-only, next to the main conversation]";

export const COMMIT_SPLIT_SYSTEM =
  "You are splitting the user's accepted changes into git commits, in a separate read-only session next to the coding session above. " +
  "Do not modify files, run mutating commands or start agents — those calls are refused. You may read code with read-only tools " +
  "if the hunks alone are unclear. Answer with the JSON plan only.";

export type CommitSplitInput = {
  branch: string | null;
  /** `settings.commitTemplate` (or the learned format, §41.1) with `{issue}` / `{branch}` filled in; null without one. */
  template: string | null;
  templateSource?: "settings" | "learned";
  examples?: string[];
  /** Newest first. */
  subjects: string[];
  /** As `commit_hunks` lists them. */
  files: readonly CommitFile[];
  /** The review diff of the files that go whole (their content for the plan), cut to the lines the hunks left. */
  wholePatch: RoundPatch | null;
};

/** Lines the hunks of `files` take in the prompt (≤ `COMMIT_SPLIT_LINES`). */
export function hunkLines(files: readonly CommitFile[]): number {
  let n = 0;
  for (const f of files) for (const h of f.hunks) n += 1 + h.text.split("\n").length;
  return Math.min(n, COMMIT_SPLIT_LINES);
}

/** The fork's prompt. */
export function commitSplitPrompt(input: CommitSplitInput): string {
  const parts: string[] = [
    COMMIT_SPLIT_HEADER,
    "Split the accepted changes below into the smallest meaningful git commits — one behavior per commit, so that any commit can be " +
      "reverted or cherry-picked alone. Nothing is committed now: the user reviews and adjusts the split first.",
    [
      "Rules:",
      "- Make each commit the smallest meaningful unit; each one must build and pass its tests on its own.",
      "- Order them so that dependencies come first (a helper, type or schema before the code that uses it).",
      "- Docs go in the commit of the change they describe, not in a commit of their own.",
      "- An unrelated fix gets its own commit. So does a regenerated file (lock files, generated i18n / translation files, golden fixtures, snapshots), after the change that made it.",
      "- A hunk goes into exactly one commit; a file marked \"whole file only\" goes whole into one commit. Put every hunk and file into a commit.",
      "- Write each message in the project's format and language (the format and the recent subjects below): the subject line, then optionally a blank line and a short body.",
    ].join("\n"),
  ];
  const head: string[] = [`Branch: ${input.branch ?? "(detached HEAD)"}`];
  if (input.template !== null && input.template.trim()) {
    const source = input.templateSource === "learned" ? "the team's format, learned from the recent subjects" : "the project's template";
    head.push(`Message format — ${source}; start every subject with it and follow its pattern: ${JSON.stringify(input.template)}`);
    if (/\{[a-z]+\}/.test(input.template)) {
      head.push("Replace each placeholder in braces ({title}, {summary}, {type}, {scope}, …) with words from the change; keep the rest of the format exactly.");
    }
  }
  if (input.examples && input.examples.length > 0) head.push(["Examples of this format from the repository (newest first):", ...input.examples.map((s) => `- ${s}`)].join("\n"));
  parts.push(head.join("\n"));
  if (input.subjects.length > 0) {
    parts.push(["Recent commit subjects of this repository (newest first) — match their language, style and prefix:", ...input.subjects.map((s) => `- ${s}`)].join("\n"));
  }
  // Every hunk with its text while the budget lasts; after it, the files with their hunk ids and headers only.
  const shown: string[] = [];
  const rest: string[] = [];
  let budget = COMMIT_SPLIT_LINES;
  for (const f of input.files) {
    if (f.hunks.length === 0) continue;
    const what = `${f.path} (${f.status})`;
    if (budget <= 0) {
      rest.push(`- ${what}: ${f.hunks.map((h) => `hunk ${h.id} ${h.header}`).join("; ")}`);
      continue;
    }
    const block: string[] = [`### ${what} — hunks ${f.hunks.map((h) => h.id).join(", ")}`];
    for (const h of f.hunks) {
      const lines = h.text.split("\n");
      if (budget <= 0) {
        block.push(`hunk ${h.id}: ${h.header} (text left out)`);
        continue;
      }
      const text = lines.slice(0, budget).join("\n");
      budget -= 1 + Math.min(lines.length, budget);
      const fence = fenceFor(text);
      block.push(`hunk ${h.id}:\n${fence}diff\n${h.header}\n${text}\n${fence}`);
    }
    shown.push(block.join("\n"));
  }
  if (shown.length > 0) parts.push(["Accepted changes as hunks of `git diff HEAD` (what the commits take from the working tree):", ...shown].join("\n\n"));
  if (rest.length > 0) parts.push([`More files (cut after ${COMMIT_SPLIT_LINES} lines; the hunk ids are valid):`, ...rest].join("\n"));
  const whole = input.files.filter((f) => f.hunks.length === 0);
  if (whole.length > 0) {
    const list = whole.map((f) => {
      const what = f.status === "R" && f.oldPath ? `R from ${f.oldPath}` : f.status;
      return `- ${f.path} (${what}${f.binary ? ", binary" : ""}) — whole file only`;
    });
    parts.push(["Files that can only go whole (give them no \"hunks\"):", ...list].join("\n"));
    const patch = input.wholePatch;
    if (patch && patch.text) {
      const f = fenceFor(patch.text);
      parts.push(`Their changes${patch.truncated ? ` (cut after ${patch.lines} lines)` : ""}:\n${f}diff\n${patch.text.replace(/\n$/, "")}\n${f}`);
    }
  }
  parts.push(
    "Answer with JSON only — no prose, no code fence — in this shape:\n" +
      '{"commits":[{"message":"…","why":"…","parts":[{"path":"…","hunks":[0,2]}]}]}\n' +
      'The commits in the order they are to be made. A part without "hunks" takes the whole file. "why": one short line on why these changes belong together.',
  );
  return parts.join("\n\n");
}

/** The answer's list of commits: the JSON itself, inside a code fence, or after a preamble; null when there is none. */
export function parseCommitSplit(text: string): unknown[] | null {
  const t = text.replace(/\r\n/g, "\n").trim();
  const candidates = [t, ...[...t.matchAll(/(`{3,})[^\n`]*\n([\s\S]*?)\n\1/g)].map((m) => m[2]!)];
  for (const c of [...candidates]) {
    const a = c.indexOf("{");
    const b = c.lastIndexOf("}");
    if (a >= 0 && b > a) candidates.push(c.slice(a, b + 1));
    const l = c.indexOf("[");
    const r = c.lastIndexOf("]");
    if (l >= 0 && r > l) candidates.push(c.slice(l, r + 1));
  }
  for (const c of candidates) {
    let v: unknown;
    try {
      v = JSON.parse(c.trim());
    } catch {
      continue;
    }
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object" && Array.isArray((v as { commits?: unknown }).commits)) return (v as { commits: unknown[] }).commits;
  }
  return null;
}

/**
 * Only valid parts are kept: a known path of `files`, known hunk ids (a whole-only file goes whole whatever hunks the answer
 * named), no hunk twice (a later commit's repeat is dropped); a part that names every hunk of its file is the whole file.
 * A commit without a message or without a part left is dropped. What no commit took is `unassigned`.
 */
export function validateSplit(raw: readonly unknown[], files: readonly CommitFile[]): { commits: CommitPlan[]; unassigned: CommitPart[] } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const used = new Map<string, Set<number>>();
  const commits: CommitPlan[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as { message?: unknown; why?: unknown; parts?: unknown };
    const message = typeof o.message === "string" ? o.message.trim().slice(0, COMMIT_DRAFT_MAX) : "";
    if (!message || !Array.isArray(o.parts)) continue;
    const taken = new Map<string, number[]>();
    for (const p of o.parts) {
      const part = p && typeof p === "object" ? (p as { path?: unknown; hunks?: unknown }) : {};
      const f = typeof part.path === "string" ? byPath.get(part.path) : undefined;
      if (!f) continue;
      const done = used.get(f.path) ?? new Set<number>();
      used.set(f.path, done);
      const all = f.hunks.length === 0 ? [-1] : f.hunks.map((h) => h.id);
      const want = f.hunks.length > 0 && Array.isArray(part.hunks) ? part.hunks.filter((id): id is number => all.includes(id as number)) : all;
      const fresh = [...new Set(want)].filter((id) => !done.has(id));
      for (const id of fresh) done.add(id);
      if (fresh.length > 0) taken.set(f.path, [...(taken.get(f.path) ?? []), ...fresh]);
    }
    if (taken.size === 0) continue;
    const parts = [...taken.entries()].map(([path, ids]): CommitPart => {
      const f = byPath.get(path)!;
      return f.hunks.length === 0 || ids.length === f.hunks.length ? { path } : { path, hunks: ids.sort((a, b) => a - b) };
    });
    const why = typeof o.why === "string" ? o.why.trim().slice(0, COMMIT_SPLIT_WHY_MAX) : "";
    commits.push({ message, parts, ...(why ? { why } : {}) });
  }
  const unassigned: CommitPart[] = [];
  for (const f of files) {
    const done = used.get(f.path) ?? new Set<number>();
    if (f.hunks.length === 0) {
      if (!done.has(-1)) unassigned.push({ path: f.path });
      continue;
    }
    const left = f.hunks.map((h) => h.id).filter((id) => !done.has(id));
    if (left.length === f.hunks.length) unassigned.push({ path: f.path });
    else if (left.length > 0) unassigned.push({ path: f.path, hunks: left });
  }
  return { commits, unassigned };
}
