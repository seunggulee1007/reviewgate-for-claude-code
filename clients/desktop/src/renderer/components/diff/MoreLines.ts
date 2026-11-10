/**
 * MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3: "20줄 더 보기" for a past round's diff and a PR's diff. The diff's new
 * side comes from the engine (`history_file_lines` / `pr_file_lines` → `file_lines`), asked on the first click only and
 * kept for the shown diff; `UnifiedDiff` checks it against the hunks (diffContext.ts) before it shows a line. A refusal
 * (an older engine: `unknown_command`) or a binary / too large file says why on the expander rows.
 */
import { useCallback, useMemo, useState } from "react";
import type { FileLinesEvent } from "@reviewgate/engine";
import { refusalOf } from "../../engineRequest";
import { refusalMessage } from "../../errorCodes";
import { t } from "../../i18n";
import { fileLinesUnavailable } from "../../reviewLeftovers";
import type { DiffContextSource } from "../UnifiedDiff";

type Box = { key: string | null; lines: readonly string[] | null; loading: boolean; unavailable: string | null };

/** The new side of the shown diff for "20줄 더 보기"; `key` null (no diff, or one without unchanged lines) → none. */
export function useFileLinesContext(key: string | null, load: () => Promise<FileLinesEvent>): DiffContextSource | undefined {
  const [box, setBox] = useState<Box>({ key: null, lines: null, loading: false, unavailable: null });
  const cur: Box = box.key === key ? box : { key, lines: null, loading: false, unavailable: null };
  const loader = useCallback(() => {
    if (key === null) return;
    setBox({ key, lines: null, loading: true, unavailable: null });
    load()
      .then((reply) => {
        const unavailable = fileLinesUnavailable(reply);
        setBox((b) => (b.key === key ? { key, lines: unavailable ? null : reply.lines, loading: false, unavailable } : b));
      })
      .catch((e: unknown) => {
        const why = `${t("Could not load file")} — ${refusalMessage(refusalOf(e))}`;
        setBox((b) => (b.key === key ? { key, lines: null, loading: false, unavailable: why } : b));
      });
    // `load` is a fresh closure per render; the key names what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(
    () => (key === null ? undefined : { lines: cur.lines, loading: cur.loading, unavailable: cur.unavailable, load: loader }),
    [key, cur.lines, cur.loading, cur.unavailable, loader],
  );
}
