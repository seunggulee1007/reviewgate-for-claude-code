/**
 * MARK: polish p-foundation — P1-chrome-01 / P2-review-21: what closing this window (or quitting) would lose — a review
 * note being written, a queued message, an edited commit message. Each piece of work registers a line it says while there
 * is something to lose; the close / quit confirmation lists them (it reads `unsavedWorkLines()`).
 *
 *   useUnsavedWork("noteDraft", () => (draft.trim() ? t("You are writing a review note. Closing discards it.") : null));
 *
 * Outside React: `const off = registerUnsavedWork(key, line)`, and `off()` when the work is gone. One line per key: a
 * second registration of a key replaces the first.
 */
import { useEffect, useRef } from "react";

type Line = () => string | null;

const registry = new Map<string, Line>();

/** Registers `key`'s line; the returned function removes it (only if it is still this registration). */
export function registerUnsavedWork(key: string, line: Line): () => void {
  registry.set(key, line);
  return () => {
    if (registry.get(key) === line) registry.delete(key);
  };
}

/** The lines of what closing would lose now, in key order (a line that throws is left out). */
export function unsavedWorkLines(): string[] {
  const lines: string[] = [];
  for (const key of [...registry.keys()].sort()) {
    try {
      const line = registry.get(key)?.();
      if (line) lines.push(line);
    } catch {
      // A provider that fails must not block closing.
    }
  }
  return lines;
}

/** While the component is mounted, `line()` (the latest one it rendered with) is listed under `key`. */
export function useUnsavedWork(key: string, line: Line): void {
  const latest = useRef(line);
  latest.current = line;
  useEffect(() => registerUnsavedWork(key, () => latest.current()), [key]);
}
