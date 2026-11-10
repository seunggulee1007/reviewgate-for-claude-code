/**
 * MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3 "Review leftovers": what the review screens still lacked after 0.2.7.
 * - "20줄 더 보기" in a past round's diff and a PR's diff: the diff's new side read from the history entry's tree
 *   (`history_file_lines`) or the PR's head commit (`pr_file_lines`), both answered `file_lines`.
 * - The whitespace-ignoring diff (`select_file {ignoreWhitespace}` → `file_diff {ignoreWhitespace: true}`, git's `-w`).
 * - Up to N matches per chat in the chat search (`transcript_search {perChat}` → `more` / `total` on a match).
 * - An image's two sides (`file_image`: png / jpg / gif, each ≤ 2 MB).
 * Pure reads: nothing here changes the review, the worktree or a ref.
 */
import { FULL_FILE_MAX_BYTES, FULL_FILE_MAX_LINES } from "../diff/fullfile.js";
import { CommandRefused } from "../errors.js";
import type { GitCheckpoint } from "../git/checkpoint.js";
import type { FileImageEvent, FileImageSide, ReviewHistoryEntry, ReviewHistoryFile, TranscriptItem, TranscriptSearchHit } from "../protocol.js";
import { matchedLine, type SearchMatch } from "./transcriptHistory.js";

// ---------------------------------------------------------------- "20줄 더 보기" in the history and PR diffs

export type FileLines = { lines: string[]; isBinary: boolean; isTooLarge: boolean };

/** A file's bytes as `file_lines` / `full_file_content` split them: `\r?\n`, the last empty line dropped. */
export function fileLinesOf(bytes: Buffer): FileLines {
  if (bytes.subarray(0, 8192).includes(0)) return { lines: [], isBinary: true, isTooLarge: false };
  if (bytes.length > FULL_FILE_MAX_BYTES) return { lines: [], isBinary: false, isTooLarge: true };
  const lines = bytes.toString("utf8").split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length > FULL_FILE_MAX_LINES) return { lines: [], isBinary: false, isTooLarge: true };
  return { lines, isBinary: false, isTooLarge: false };
}

/** The tree `history_diff` diffs a history file to: with `final` the round's last B, else the file's proposal tree. */
export function historyEndTree(entry: Pick<ReviewHistoryEntry, "turnEndTree">, file: Pick<ReviewHistoryFile, "endTree">, final: boolean): string {
  return final ? entry.turnEndTree : (file.endTree ?? entry.turnEndTree);
}

/**
 * `history_file_lines`: the new side of a history file's diff. Refused `history_trees_gone` (the round's trees were
 * pruned) and `no_new_side:<path>` (a deleted file, or a file the final tree no longer holds).
 */
export async function historyFileLines(cp: GitCheckpoint, entry: ReviewHistoryEntry, file: ReviewHistoryFile, final: boolean): Promise<FileLines> {
  if (file.status === "D") throw new CommandRefused(`no_new_side:${file.path}`);
  const end = historyEndTree(entry, file, final);
  if (!(await cp.hasObjects([end]))) throw new CommandRefused("history_trees_gone");
  const size = await cp.blobSize(end, file.path);
  if (size === null) throw new CommandRefused(`no_new_side:${file.path}`);
  if (size > FULL_FILE_MAX_BYTES) return { lines: [], isBinary: false, isTooLarge: true };
  return fileLinesOf(await cp.fileContent(file.path, end));
}

/**
 * The bytes of `path` at a PR's head commit `sha`: from this repository when it has the commit (a fetched branch), else
 * through `fetchRemote` (GitHub's contents API). Over 2 MB → null (too large).
 */
export async function prHeadContent(cp: GitCheckpoint | null, sha: string, path: string, fetchRemote: () => Promise<Buffer>): Promise<Buffer | null> {
  if (cp && /^[0-9a-f]{7,64}$/i.test(sha) && (await cp.hasObjects([sha]).catch(() => false))) {
    const size = await cp.blobSize(sha, path);
    if (size !== null) return size > FULL_FILE_MAX_BYTES ? null : cp.fileContent(path, sha);
  }
  const bytes = await fetchRemote();
  return bytes.length > FULL_FILE_MAX_BYTES ? null : bytes;
}

// ---------------------------------------------------------------- the whitespace-ignoring diff

/** `git diff-tree -p -w` of one file between two trees (renames followed as the review's own patch does). */
export async function ignoreWhitespacePatch(cp: GitCheckpoint, base: string, end: string, path: string, oldPath: string | null | undefined): Promise<string> {
  const args = ["diff-tree", "-r", "-M", "-p", "--no-color", "-w", base, end, "--", path];
  if (oldPath && oldPath !== path) args.push(oldPath);
  return (await cp.git(args)).text;
}

// ---------------------------------------------------------------- the chat search, several matches per chat

export const SEARCH_PER_CHAT_MAX = 10;

/** `transcript_search.perChat`: 1–10 (default 1 — one match per chat, as before §41.3). */
export function perChatOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(SEARCH_PER_CHAT_MAX, Math.max(1, Math.floor(v))) : 1;
}

/** The newest match of a chat with its next older ones (`more`, at most `perChat − 1`) and how many rows match in all. */
export type ChatMatches = SearchMatch & { more: TranscriptSearchHit[]; total: number };

function parseRow(line: string): TranscriptItem | null {
  try {
    const o = JSON.parse(line) as TranscriptItem;
    return o && typeof o === "object" && typeof o.kind === "string" ? o : null;
  } catch {
    return null;
  }
}

/**
 * Every user message / Claude answer of `text` (a session's NDJSON) containing `query` (case-insensitive, trimmed),
 * newest first: the first `perChat` are returned, all are counted. A line whose raw text cannot contain the query is not
 * parsed (the query has no character JSON escapes); null when nothing matches.
 */
export function searchTranscriptMany(text: string, query: string, perChat: number): ChatMatches | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const raw = !/["\\\u0000-\u001f]/.test(needle);
  if (raw && !text.toLowerCase().includes(needle)) return null;
  const lines = text.split("\n").filter((l) => l.length > 0 && l !== "\r");
  const hits: TranscriptSearchHit[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (raw && !l.toLowerCase().includes(needle)) continue;
    const row = parseRow(l);
    if (!row || (row.kind !== "user_message" && row.kind !== "assistant_text") || typeof row.text !== "string") continue;
    const line = matchedLine(row.text, needle);
    if (line === null) continue;
    total++;
    if (hits.length < perChat) hits.push({ row: i, turn: row.turn, at: row.at, kind: row.kind, line });
  }
  const [first, ...more] = hits;
  return first ? { ...first, more, total } : null;
}

// ---------------------------------------------------------------- an image's two sides

export const IMAGE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** png / jpg / jpeg / gif by extension (case-insensitive); null for anything else. */
export function imageMediaType(path: string): FileImageEvent["mediaType"] | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  return null;
}

/** One side of the image in `tree` (null when the tree has no such file); over 2 MB only its size. */
export async function imageSide(cp: GitCheckpoint, tree: string, path: string): Promise<FileImageSide | null> {
  const size = await cp.blobSize(tree, path);
  if (size === null) return null;
  if (size > IMAGE_PREVIEW_MAX_BYTES) return { size, tooLarge: true };
  const bytes = await cp.fileContent(path, tree);
  return { size: bytes.length, dataBase64: bytes.toString("base64") };
}
