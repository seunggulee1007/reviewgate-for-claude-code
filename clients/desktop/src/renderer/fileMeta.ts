/**
 * MARK: wave4b w4b-files — docs/PROTOCOL.md §40.2 (comp-11): what a diff without lines is — a pure move, a rename, a mode
 * change, a binary's sizes — from the `FileDiff` fields an engine since §40.2 sends (`similarity`, `oldMode` / `newMode`,
 * `binarySize`). The same lines as Core `FileMetaText` (Mac); an older engine sends none of them and nothing is added.
 */
import type { FileDiff } from "@reviewgate/engine";
import { t } from "./i18n";

const EXEC = "100755";
const PLAIN = "100644";

/** 12 288 → "12KB", 500 → "500B", 5.3 MB → "5.3MB" (1024 steps; KB whole, MB one decimal). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** "644" for a regular file's mode, the raw mode otherwise. */
const short = (mode: string) => (mode.startsWith("100") ? mode.slice(3) : mode);

/** One line per thing the diff's lines cannot show, in this order: the move, the mode, the binary's sizes. */
export function fileMetaLines(diff: Pick<FileDiff, "isBinary" | "oldPath" | "newPath" | "similarity" | "oldMode" | "newMode" | "binarySize" | "hunks">): string[] {
  const out: string[] = [];
  if (diff.similarity !== undefined) {
    out.push(diff.similarity >= 100 ? t("Moved without a content change (similarity {0}%)", diff.similarity) : t("Renamed (similarity {0}%)", diff.similarity));
  }
  const { oldMode, newMode } = diff;
  if (oldMode !== undefined && newMode !== undefined && oldMode !== newMode) {
    if (oldMode === PLAIN && newMode === EXEC) out.push(t("Executable permission added {0}→{1}", short(oldMode), short(newMode)));
    else if (oldMode === EXEC && newMode === PLAIN) out.push(t("Executable permission removed {0}→{1}", short(oldMode), short(newMode)));
    else out.push(t("File mode changed {0}→{1}", oldMode, newMode));
  } else if (oldMode === undefined && newMode === EXEC) {
    out.push(t("New executable file ({0})", short(newMode)));
  }
  const size = diff.isBinary ? diff.binarySize : undefined;
  if (size) {
    if (size.old !== null && size.new !== null) out.push(t("Binary · {0} → {1}", formatBytes(size.old), formatBytes(size.new)));
    else if (size.new !== null) out.push(t("Binary · new file {0}", formatBytes(size.new)));
    else if (size.old !== null) out.push(t("Binary · deleted {0}", formatBytes(size.old)));
  }
  return out;
}
