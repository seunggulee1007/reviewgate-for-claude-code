/**
 * MARK: wave4b w4b-files — docs/PROTOCOL.md §40.2 (comp-11): above a diff that has lines, what the lines cannot show — the
 * rename's similarity, a mode change ("실행 권한 추가 644→755"). A diff without lines says it in its own body (UnifiedDiff).
 */
import type { FileDiff } from "@reviewgate/engine";
import { fileMetaLines } from "../../fileMeta";

export function FileMetaRow({ diff }: { diff: FileDiff }) {
  if (diff.isBinary || diff.hunks.length === 0) return null;
  const lines = fileMetaLines(diff);
  if (lines.length === 0) return null;
  return (
    <div className="file-notices" data-testid="File meta">
      <div className="notice gray">
        <span aria-hidden="true">ⓘ</span>
        <span>{lines.join(" · ")}</span>
      </div>
    </div>
  );
}
