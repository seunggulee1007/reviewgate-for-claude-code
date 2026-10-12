/**
 * MARK: wave4c w4c-commit — docs/PROTOCOL.md §41.1 (market-10): the team's commit subject format learned from the
 * repository's recent subjects (`#acme/4821/제목 - 설명`, `[ABC-123] …`, `#12 …`, `feat(x): …`), the branch's issue
 * number and the PR draft from the branch's commits. Pure functions; `engine.ts` feeds them `git log`.
 */

/** `git log -50 --no-merges --format=%s`. */
export const COMMIT_FORMAT_SUBJECTS = 50;
/** Examples of the learned format given to the draft and shown by the clients. */
export const COMMIT_FORMAT_EXAMPLES = 5;
/** Subjects of the branch's commits a PR draft lists. */
export const PR_DRAFT_COMMITS = 50;

export type CommitFormatKind = "path" | "key" | "number" | "conventional";

export type LearnedCommitFormat = {
  /** The format as a commit template: `{issue}` / `{branch}` filled by the engine, `{title}` / `{summary}` / `{type}` / `{scope}` by Claude. */
  template: string;
  kind: CommitFormatKind;
  /** The subjects that follow it, newest first (≤ 5). */
  examples: string[];
  /** The issue numbers those subjects used, newest first (none for `conventional`). */
  issues: string[];
  /** How many subjects follow it, of how many read (merges, reverts and fixups are not read). */
  matched: number;
  total: number;
};

const SKIPPED = /^(?:Revert "|Merge (?:branch|pull request|remote-tracking branch|tag) |fixup! |squash! |amend! )/;
const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|tests|build|ci|chore|revert|merge)(\([^)\n]*\))?!?: \S/;

type Hit = { shape: string; kind: CommitFormatKind; issue: string | null; rest: string; scoped?: boolean };

/** The shape of one subject: what stays the same between subjects of one format (`#acme/{issue}/`, `[PAY-{issue}] `, …). */
function hitOf(subject: string): Hit | null {
  let m = /^#([A-Za-z0-9._-]+)\/(\d+)(\/|:\s*|\s+)(\S.*)$/.exec(subject);
  if (m) {
    const sep = m[3] === "/" ? "/" : m[3]!.startsWith(":") ? ": " : " ";
    return { shape: `#${m[1]}/{issue}${sep}`, kind: "path", issue: m[2]!, rest: m[4]! };
  }
  m = /^\[([A-Z][A-Z0-9]+)-(\d+)\]\s*(\S.*)$/.exec(subject);
  if (m) return { shape: `[${m[1]}-{issue}] `, kind: "key", issue: m[2]!, rest: m[3]! };
  m = /^([A-Z][A-Z0-9]+)-(\d+)(:\s*|\s+)(\S.*)$/.exec(subject);
  if (m) return { shape: `${m[1]}-{issue}${m[3]!.startsWith(":") ? ": " : " "}`, kind: "key", issue: m[2]!, rest: m[4]! };
  m = /^\[#(\d+)\]\s*(\S.*)$/.exec(subject);
  if (m) return { shape: "[#{issue}] ", kind: "number", issue: m[1]!, rest: m[2]! };
  m = /^#(\d+)(:\s*|\s+)(\S.*)$/.exec(subject);
  if (m) return { shape: `#{issue}${m[2]!.startsWith(":") ? ": " : " "}`, kind: "number", issue: m[1]!, rest: m[3]! };
  m = CONVENTIONAL.exec(subject);
  if (m) return { shape: "conventional", kind: "conventional", issue: null, rest: subject, scoped: m[2] !== undefined };
  return null;
}

/**
 * The format most of `subjects` (newest first) follow, or null: the shape used by the most subjects, kept when it covers
 * at least 40 % of them and at least two (one when only one subject was read). `{title} - {summary}` when most of those
 * subjects have " - " after the title; a conventional `{type}({scope}): {summary}` when most have a scope.
 */
export function learnCommitFormat(subjects: readonly string[]): LearnedCommitFormat | null {
  const read = subjects.map((s) => s.trim()).filter((s) => s.length > 0 && !SKIPPED.test(s));
  const groups = new Map<string, { hits: Hit[]; subjects: string[] }>();
  for (const s of read) {
    const hit = hitOf(s);
    if (!hit) continue;
    const g = groups.get(hit.shape) ?? { hits: [], subjects: [] };
    g.hits.push(hit);
    g.subjects.push(s);
    groups.set(hit.shape, g);
  }
  let best: { hits: Hit[]; subjects: string[] } | null = null;
  for (const g of groups.values()) if (!best || g.hits.length > best.hits.length) best = g;
  if (!best) return null;
  const matched = best.hits.length;
  if (matched * 5 < read.length * 2 || (matched < 2 && read.length > 1)) return null;
  const first = best.hits[0]!;
  const most = (pred: (h: Hit) => boolean) => best!.hits.filter(pred).length * 2 > matched;
  const template =
    first.kind === "conventional"
      ? most((h) => h.scoped === true)
        ? "{type}({scope}): {summary}"
        : "{type}: {summary}"
      : `${first.shape}{title}${most((h) => h.rest.includes(" - ")) ? " - {summary}" : ""}`;
  const issues = [...new Set(best.hits.map((h) => h.issue).filter((i): i is string => i !== null))];
  return { template, kind: first.kind, examples: best.subjects.slice(0, COMMIT_FORMAT_EXAMPLES), issues, matched, total: read.length };
}

/**
 * `{issue}`: the branch name's run of digits that the recent subjects already use as an issue number (the branch has
 * commits), else its longest run of digits — the first of equally long ones (`feature/acme/4821-17` → `4821`,
 * `fix/PROJ-12-part-3` → `12`); "" without one. §36.11 took the last run, which made `-17` the issue.
 */
export function branchIssue(branch: string | null, usedIssues: readonly string[] = []): string {
  const runs = (branch ?? "").match(/\d+/g) ?? [];
  const used = runs.find((r) => usedIssues.includes(r));
  if (used !== undefined) return used;
  let best = "";
  for (const r of runs) if (r.length > best.length) best = r;
  return best;
}

/** A template with `{issue}` and `{branch}` filled in (the issue as `branchIssue`). */
export function renderTemplate(template: string, branch: string | null, usedIssues: readonly string[] = []): string {
  return template.replace(/\{issue\}/g, branchIssue(branch, usedIssues)).replace(/\{branch\}/g, branch ?? "");
}

/**
 * A PR title and body from the branch's commit subjects (oldest first): one commit — its subject; several — the title they
 * share before " - " (`#acme/4821/재고 동기화 - 중복 방지` + `… - 테스트 추가` → `#acme/4821/재고 동기화`), else the oldest
 * subject. The body lists the subjects, oldest first.
 */
export function prDraftFrom(subjects: readonly string[]): { title: string; body: string } {
  const list = subjects.map((s) => s.trim()).filter((s) => s.length > 0);
  if (list.length === 0) return { title: "", body: "" };
  let title = list[0]!;
  if (list.length > 1) {
    const heads = list.map((s) => (s.includes(" - ") ? s.slice(0, s.indexOf(" - ")).trim() : null));
    if (heads[0] && heads.every((h) => h === heads[0])) title = heads[0];
  }
  return { title, body: list.map((s) => `- ${s}`).join("\n") };
}
