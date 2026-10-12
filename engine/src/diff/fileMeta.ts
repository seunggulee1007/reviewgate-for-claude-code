/**
 * MARK: wave4b w4b-files — §40.2 (comp-11): what a `file_diff` without lines is. A text patch names its own mode change and a
 * rename's similarity (parse.ts); a binary file runs no patch, so its modes / similarity come from the changed file (review
 * range only — they describe A → B) and its size on each side from the trees ("바이너리 · 12KB → 14KB").
 */
import type { ChangedFile, GitCheckpoint } from "../git/checkpoint.js";
import type { FileDiff } from "./parse.js";

export async function withFileMeta(
  cp: Pick<GitCheckpoint, "blobSize"> | null,
  file: Pick<ChangedFile, "path" | "oldPath" | "status" | "oldMode" | "newMode" | "similarity"> | undefined,
  diff: FileDiff,
  range: { baseTree: string; endTree: string; review: boolean },
): Promise<FileDiff> {
  if (!file || !diff.isBinary) return diff;
  const out: FileDiff = { ...diff };
  if (range.review) {
    if (out.oldMode === undefined && file.oldMode !== undefined) out.oldMode = file.oldMode;
    if (out.newMode === undefined && file.newMode !== undefined) out.newMode = file.newMode;
    if (out.similarity === undefined && file.similarity !== undefined) out.similarity = file.similarity;
  }
  if (cp) {
    const [before, after] = await Promise.all([
      file.status === "A" ? null : cp.blobSize(range.baseTree, file.oldPath ?? file.path).catch(() => null),
      file.status === "D" ? null : cp.blobSize(range.endTree, file.path).catch(() => null),
    ]);
    if (before !== null || after !== null) out.binarySize = { old: before, new: after };
  }
  return out;
}
