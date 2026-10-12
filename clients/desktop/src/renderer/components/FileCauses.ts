/**
 * MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3: the review list's "원인별" sections — each changed file's subagent ·
 * Bash command · turn (`fileCause`), from the running chat's rows and the §39.3 authors. Kept in the "묶기" store too, so
 * ⌘] / ⌘[ and the move after a verdict follow the sections (`displayOrder`).
 */
import { useEffect, useMemo } from "react";
import type { ChangedFileState } from "@reviewgate/engine";
import type { FileAuthor } from "../agentGlance";
import { indexTranscript } from "../agents";
import { useGroupBy } from "../fileGroups";
import { fileCause } from "../reviewLeftovers";
import { useStore } from "../store";

export function useFileCauses(files: readonly ChangedFileState[], authors: Map<string, FileAuthor[]>): Map<string, string> {
  const rows = useStore((s) => s.transcript.length);
  const causes = useMemo(() => {
    const index = indexTranscript(useStore.getState().transcript);
    return new Map(files.map((f) => [f.path, fileCause(f, authors.get(f.path), index)] as const));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, authors, rows]);
  const setCauses = useGroupBy((s) => s.setCauses);
  useEffect(() => setCauses(Object.fromEntries(causes)), [causes, setCauses]);
  return causes;
}
