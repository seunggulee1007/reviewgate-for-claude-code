import { revertHunks } from "../diff/hunks.js";
import { parseUnifiedDiff, type DiffHunk } from "../diff/parse.js";
import type { CommitFile, CommitHunk } from "../protocol.js";
import type { ChangedFile, GitCheckpoint } from "./checkpoint.js";

/**
 * §53 commits in meaningful units: the accepted changes as a commit takes them from the worktree — the hunks of
 * `git diff HEAD -- <path>` — and the content a file split by hunks gets in each commit of a series.
 */

/** A hunk's `text` is cut at this many lines. */
export const COMMIT_HUNK_TEXT_LINES = 300;

/** One accepted file as the commit sheet lists it, with the parsed hunks its split content is computed from ([]: whole only). */
export type HeadFile = { file: CommitFile; hunks: DiffHunk[] };

type ReviewFile = Pick<ChangedFile, "path" | "oldPath" | "status" | "isBinary"> & { uncaptured?: true };

/** Pathspecs are literal: a file named `*.ts` is that file. */
const LITERAL = { GIT_LITERAL_PATHSPECS: "1" };
/** Regular files: a symlink's target or a submodule's commit is not split. */
const REGULAR = new Set(["100644", "100755"]);
const PREFIX = { add: "+", del: "-", context: " " } as const;

/**
 * The hunks of `git diff HEAD -- <path>` (3 lines of context; ids 0, 1, … in file order) of each review file. An added,
 * deleted, renamed or binary file, one whose diff has a single hunk, a symlink, a submodule, a mode change, a file the
 * snapshot did not capture or any file on an unborn branch can only go whole (`hunks: []`).
 */
export async function headHunks(cp: GitCheckpoint, files: readonly ReviewFile[]): Promise<HeadFile[]> {
  const head = (await cp.head()).sha;
  const out: HeadFile[] = [];
  for (const f of files) {
    const file: CommitFile = { path: f.path, ...(f.oldPath !== null && f.oldPath !== f.path ? { oldPath: f.oldPath } : {}), status: f.status, binary: f.isBinary, hunks: [] };
    out.push({ file, hunks: [] });
    if (head === null || f.status !== "M" || f.isBinary || f.uncaptured) continue;
    const patch = await cp.git(
      ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U3", "--src-prefix=a/", "--dst-prefix=b/", "HEAD", "--", f.path],
      { env: LITERAL },
    );
    // A type change (a file that became a symlink) is a deletion and an addition: two patches.
    if (/^(?:new file mode|deleted file mode) /m.test(patch.text) || (patch.text.match(/^diff --git /gm)?.length ?? 0) > 1) continue;
    const diff = parseUnifiedDiff(patch.text);
    if (diff.isBinary) {
      file.binary = true;
      continue;
    }
    if (diff.hunks.length < 2 || (diff.oldMode ?? null) !== (diff.newMode ?? null)) continue;
    if (!REGULAR.has((await cp.treeMode("HEAD", f.path)) ?? "")) continue;
    file.hunks = diff.hunks.map(commitHunk);
    out[out.length - 1]!.hunks = diff.hunks;
  }
  return out;
}

function commitHunk(h: DiffHunk): CommitHunk {
  const body = h.lines.filter((l) => l.kind !== "hunkHeader");
  return {
    id: h.id,
    header: h.header,
    added: body.filter((l) => l.kind === "add").length,
    deleted: body.filter((l) => l.kind === "del").length,
    text: body.slice(0, COMMIT_HUNK_TEXT_LINES).map((l) => PREFIX[l.kind as keyof typeof PREFIX] + l.text).join("\n"),
  };
}

/**
 * HEAD's content (`head`) with the hunks `applied` taken over from `work` (the worktree file as `git add` stores it) and
 * the others left out. Both sides of every hunk are checked against the bytes first (`HunkMismatchError`).
 */
export function splitContent(head: Buffer, work: Buffer, hunks: DiffHunk[], applied: ReadonlySet<number>): Buffer {
  return revertHunks(head, work, hunks, new Set(hunks.map((h) => h.id).filter((id) => !applied.has(id))));
}
