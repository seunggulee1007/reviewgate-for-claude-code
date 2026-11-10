import type { ChangedFile } from "../git/checkpoint.js";

// MARK: wave3 check-engine (docs/PROTOCOL.md §37.3)

/**
 * The paths a turn's own delta (its start tree → B, `GitCheckpoint.changes`, renames detected) touched: every path, and a
 * rename's old path too — exactly what `diff-tree --name-only --no-renames` of the same two trees lists, so the §34.8
 * "this turn's files" and the §34.3 `changedThisTurn` read one diff.
 */
export function turnPaths(own: readonly Pick<ChangedFile, "path" | "oldPath">[]): Set<string> {
  const out = new Set<string>();
  for (const f of own) {
    out.add(f.path);
    if (f.oldPath !== null && f.oldPath !== f.path) out.add(f.oldPath);
  }
  return out;
}

/**
 * A collection's own delta of the turn: its start tree `base` → B `end`, ignore patterns NOT applied, as `turnPaths`
 * (sorted). The engine's §26 record of the same turn keeps exactly these paths — it reuses them instead of diffing the
 * same two trees again.
 */
export type TurnDelta = { base: string; end: string; paths: string[] };

/** `turnPaths` of the unfiltered delta, sorted like the §26 record's `files`. */
export function turnDelta(base: string, end: string, all: readonly Pick<ChangedFile, "path" | "oldPath">[]): TurnDelta {
  return { base, end, paths: [...turnPaths(all)].sort() };
}
