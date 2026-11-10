/**
 * Unified diff model + parser (port of Core `Diff/UnifiedDiffParser.swift` / `Diff/DiffModels.swift`).
 * Line numbers are 1-based; `id` is the index within `allLines(diff)` (hunk header rows included).
 */
import { addSegments } from "./segments.js";

export type DiffLineKind = "context" | "add" | "del" | "hunkHeader";

export type DiffLine = {
  /** Index within `allLines(diff)`. */
  id: number;
  kind: DiffLineKind;
  /** null for add / hunkHeader */
  oldNo: number | null;
  /** null for del / hunkHeader */
  newNo: number | null;
  /** Without the leading +/-/space. */
  text: string;
  /**
   * §34.7 (add / del lines paired with a line of the other side only): the changed parts of `text` as half-open
   * `[start, end)` ranges in UTF-16 code units (JS string indices; Swift `String.utf16` offsets), ascending, never
   * splitting a code point. Absent = the whole line changed (or the line was not paired / over the limits).
   */
  segments?: [number, number][];
  /** §34.7: this add / del line and its pair differ only in whitespace. */
  wsOnly?: true;
};

export type DiffHunk = {
  id: number;
  header: string;
  lines: DiffLine[];
};

export type FileDiff = {
  oldPath: string | null;
  newPath: string | null;
  isBinary: boolean;
  hunks: DiffHunk[];
  /** §34.7: `segments` were computed for part of the diff only (a size limit was hit); the rest has none. */
  segmentsLimited?: true;
  // MARK: wave4b w4b-files — §40.2 (comp-11): what a diff without lines is.
  /** `old mode` / `deleted file mode` (`100644`, `100755`, `120000`), when the patch names it. */
  oldMode?: string;
  /** `new mode` / `new file mode`, when the patch names it. */
  newMode?: string;
  /** A rename's `similarity index` in percent (100: moved without a content change). */
  similarity?: number;
  /** A binary file's size in bytes on each side (`file_diff` of a binary; null: that side has no file). */
  binarySize?: { old: number | null; new: number | null };
};

/** Every line of every hunk in order (hunkHeader rows included). */
export function allLines(diff: FileDiff): DiffLine[] {
  return diff.hunks.flatMap((h) => h.lines);
}

/**
 * Parses a single-file unified patch (output of `git diff-tree -p -- <path>` or the `patch`
 * field of GitHub's `pulls/N/files`, which carries no `diff --git`/`---`/`+++` headers).
 */
export function parseUnifiedDiff(patch: string): FileDiff {
  const rawLines = patch.split("\n");
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();

  const header: ParsedHeader = { oldPath: null, newPath: null, isBinary: false };
  const hunks: DiffHunk[] = [];

  let hunkHeader: string | null = null;
  let hunkLines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let lineIndex = 0;

  const closeHunk = () => {
    if (hunkHeader !== null) {
      hunks.push({ id: hunks.length, header: hunkHeader, lines: hunkLines });
    }
    hunkHeader = null;
    hunkLines = [];
  };

  for (const line of rawLines) {
    if (header.isBinary) continue; // "GIT binary patch" payload / nothing textual follows "Binary files ... differ"
    const hh = parseHunkHeader(line);
    if (hh) {
      closeHunk();
      hunkHeader = line;
      oldNo = hh[0];
      oldRemaining = hh[1];
      newNo = hh[2];
      newRemaining = hh[3];
      hunkLines.push({ id: lineIndex, kind: "hunkHeader", oldNo: null, newNo: null, text: line });
      lineIndex += 1;
      continue;
    }

    if (hunkHeader !== null && (oldRemaining > 0 || newRemaining > 0)) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      const first = line.length === 0 ? null : line[0];
      const text = first === null ? "" : line.slice(1);
      switch (first) {
        case "+":
          hunkLines.push({ id: lineIndex, kind: "add", oldNo: null, newNo, text });
          newNo += 1;
          newRemaining -= 1;
          break;
        case "-":
          hunkLines.push({ id: lineIndex, kind: "del", oldNo, newNo: null, text });
          oldNo += 1;
          oldRemaining -= 1;
          break;
        case " ":
        case null:
          hunkLines.push({ id: lineIndex, kind: "context", oldNo, newNo, text });
          oldNo += 1;
          newNo += 1;
          oldRemaining -= 1;
          newRemaining -= 1;
          break;
        default:
          // Malformed / counts lied: treat as end of hunk and fall through to header parsing.
          closeHunk();
          oldRemaining = 0;
          newRemaining = 0;
          parseHeaderLine(line, header);
          continue;
      }
      lineIndex += 1;
      continue;
    }

    parseHeaderLine(line, header);
  }
  closeHunk();

  // §34.7: every parsed diff (file_diff of each scope, history_diff) carries the in-line segments of its paired lines.
  const meta = {
    ...(header.oldMode !== undefined ? { oldMode: header.oldMode } : {}),
    ...(header.newMode !== undefined ? { newMode: header.newMode } : {}),
    ...(header.similarity !== undefined ? { similarity: header.similarity } : {}),
  };
  return addSegments({ oldPath: header.oldPath, newPath: header.newPath, isBinary: header.isBinary, hunks, ...meta });
}

/** The header fields a patch names (wave4b w4b-files: the modes and a rename's similarity too). */
type ParsedHeader = { oldPath: string | null; newPath: string | null; isBinary: boolean; oldMode?: string; newMode?: string; similarity?: number };

// MARK: - Helpers

/** `@@ -a[,b] +c[,d] @@ ...` → [a, b, c, d]; omitted counts mean 1. */
function parseHunkHeader(line: string): [number, number, number, number] | null {
  if (!line.startsWith("@@ -")) return null;
  const body = line.slice(4);
  const close = body.indexOf(" @@");
  if (close < 0) return null;
  const ranges = body.slice(0, close).split(" ");
  if (ranges.length !== 2 || !ranges[1].startsWith("+")) return null;
  const a = parseRange(ranges[0]);
  const c = parseRange(ranges[1].slice(1));
  if (!a || !c) return null;
  return [a[0], a[1], c[0], c[1]];
}

function parseRange(s: string): [number, number] | null {
  const parts = s.split(",");
  const start = parseIntStrict(parts[0]);
  if (start === null) return null;
  if (parts.length === 1) return [start, 1];
  if (parts.length !== 2) return null;
  const count = parseIntStrict(parts[1]);
  if (count === null) return null;
  return [start, count];
}

/** Swift `Int(String)` semantics: optional sign, digits only. */
function parseIntStrict(s: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

function parseHeaderLine(
  line: string,
  header: ParsedHeader,
): void {
  // MARK: wave4b w4b-files — §40.2: a mode change (`old mode` / `new mode`) or a new executable file; an ordinary new /
  // deleted file's mode says nothing worth showing.
  const mode = /^(old mode|new mode|new file mode) ([0-7]{6})$/.exec(line);
  if (mode) {
    if (mode[1] === "old mode") header.oldMode = mode[2];
    else if (mode[1] === "new mode" || mode[2] === "100755") header.newMode = mode[2];
    return;
  }
  const similarity = /^similarity index (\d{1,3})%$/.exec(line);
  if (similarity) {
    header.similarity = Number.parseInt(similarity[1]!, 10);
    return;
  }
  if (line.startsWith("diff --git ")) {
    // `diff --git a/x b/y` — only a hint; `---`/`+++`/`rename` lines override when present.
    const spec = line.slice("diff --git ".length);
    const sep = spec.indexOf(" b/");
    if (spec.startsWith("a/") && sep >= 0) {
      header.oldPath = spec.slice(2, sep);
      header.newPath = spec.slice(sep + " b/".length);
    }
  } else if (line.startsWith("--- ")) {
    header.oldPath = filePath(line.slice(4), "a/");
  } else if (line.startsWith("+++ ")) {
    header.newPath = filePath(line.slice(4), "b/");
  } else if (line.startsWith("rename from ")) {
    header.oldPath = line.slice("rename from ".length);
  } else if (line.startsWith("rename to ")) {
    header.newPath = line.slice("rename to ".length);
  } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
    header.isBinary = true;
  }
}

/** `a/path`, `b/path`, `/dev/null` (→ null); strips a GNU-style `\t<timestamp>` suffix. */
function filePath(s: string, prefix: string): string | null {
  let p = s;
  const tab = p.indexOf("\t");
  if (tab >= 0) p = p.slice(0, tab);
  if (p === "/dev/null") return null;
  if (p.startsWith(prefix)) p = p.slice(prefix.length);
  return p;
}
