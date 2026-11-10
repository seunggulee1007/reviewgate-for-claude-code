/**
 * MARK: polish p-foundation — P3-transcript-25: when each chat row was written, for the time on a message (its tooltip,
 * "오후 3:42" before a turn's end line, the day separators). A side table by row id: `ChatItem` keeps its shapes (every
 * view switches over them). store.ts stamps a row when it makes it (`uid()`: now) and a restored row — the chat's record,
 * an older page — with its `TranscriptItem.at` (`stampRestored`). The Mac keeps the same table (Core `RowClock.swift`).
 *
 *   const at = rowTime(item.id);   // ms since the epoch, or undefined
 *   <div title={at !== undefined ? formatDate(new Date(at).toISOString()) : undefined}>
 */

/** Rows per generation: the table keeps the last two (the newest rows), so it never grows without end. */
export const ROW_TIMES_GENERATION = 50_000;

let current = new Map<number, number>();
let previous = new Map<number, number>();

/** Row `id` was written at `at` (ms since the epoch, or an ISO-8601 time; one that does not read leaves it without one). */
export function stampRow(id: number, at: number | string = Date.now()): void {
  const ms = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) {
    current.delete(id);
    previous.delete(id);
    return;
  }
  if (!current.has(id) && current.size >= ROW_TIMES_GENERATION) {
    previous = current;
    current = new Map();
  }
  current.set(id, ms);
}

/** The rows a restored record item became (`rows[from…]`) get the item's time. */
export function stampRestored(rows: readonly { id: number }[], from: number, at: string): void {
  for (let i = from; i < rows.length; i++) stampRow(rows[i]!.id, at);
}

/** When row `id` was written (ms since the epoch); undefined for a row without a time. */
export function rowTime(id: number): number | undefined {
  return current.get(id) ?? previous.get(id);
}

/** Tests: an empty table. */
export function resetRowTimes(): void {
  current = new Map();
  previous = new Map();
}
