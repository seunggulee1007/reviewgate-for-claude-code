import type { ChangedFile, GitCheckpoint } from "../git/checkpoint.js";

/**
 * wave3 engine-flow — §36.11 / §36.13: the review round's change as text for a read-only fork's prompt (the commit
 * draft's accepted files, the pre-review's round or files): the files' A → B patches in order, cut after a line budget.
 */

export type RoundPatch = {
  /** The patches (`git diff-tree -p -M`), cut at a line boundary. */
  text: string;
  lines: number;
  /** Something was left out (a cut patch, files after the cut). */
  truncated: boolean;
};

type PatchFile = Pick<ChangedFile, "path" | "oldPath" | "status" | "added" | "deleted" | "isBinary">;

/** `- path (M, +3 −1)`, `- new (R from old, +0 −0)`, `- img.png (A, binary)` per file. */
export function fileListLines(files: readonly PatchFile[]): string[] {
  return files.map((f) => {
    const what = f.status === "R" && f.oldPath && f.oldPath !== f.path ? `R from ${f.oldPath}` : f.status;
    return `- ${f.path} (${what}, ${f.isBinary ? "binary" : `+${f.added} −${f.deleted}`})`;
  });
}

/** The A (`start`) → B (`end`) patch of `files`, in their order, cut after `maxLines` lines. */
export async function roundPatch(cp: Pick<GitCheckpoint, "patch">, start: string, end: string, files: readonly PatchFile[], maxLines: number): Promise<RoundPatch> {
  const out: string[] = [];
  let truncated = false;
  for (const f of files) {
    if (out.length >= maxLines) {
      truncated = true;
      break;
    }
    const patch = f.isBinary ? `Binary file ${f.path} changed\n` : await cp.patch(start, end, f.path, f.oldPath);
    const lines = patch.replace(/\n$/, "").split("\n");
    const room = maxLines - out.length;
    if (lines.length > room) {
      out.push(...lines.slice(0, room));
      truncated = true;
      break;
    }
    out.push(...lines);
  }
  return { text: out.length > 0 ? out.join("\n") + "\n" : "", lines: out.length, truncated };
}
