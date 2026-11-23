/**
 * §65.8 on Windows — the pure parts of the peek band: what Ctrl+click does (the setting), the band's header, its lines
 * with the definition line marked, and which candidate the keys pick.
 */
import type { DefinitionCandidate, NavSymbol, SymbolPreviewEvent } from "@reviewgate/engine";
import { splitPath } from "./navModel";

// ---- Ctrl+click

/** Settings › Review › Code navigation "Ctrl+click": peek the definition in place (the default) or jump to it (§62). */
export type CtrlClickAction = "peek" | "jump";

export function ctrlClickAction(setting: unknown): CtrlClickAction {
  return setting === "jump" ? "jump" : "peek";
}

// ---- the band

/** A candidate of the band: §62's row plus its container (§65.6). */
export type BandRow = { path: string; name: string; folder: string; line: number; column: number; kind: DefinitionCandidate["kind"]; preview: string; container?: string };

export function bandRows(candidates: readonly DefinitionCandidate[]): BandRow[] {
  return candidates.map((c) => ({ path: c.path, ...splitPath(c.path), line: c.line, column: c.column, kind: c.kind, preview: c.preview, ...(c.container ? { container: c.container } : {}) }));
}

/**
 * "File.kt:42 — Container.member": the file and line, then the declaration's qualified name — the preview's symbol when
 * the engine read one on that line, else the candidate's container and the searched word.
 */
export function bandTitle(row: BandRow, symbol: NavSymbol | undefined, word: string): string {
  const name = symbol?.name ?? word;
  const container = symbol ? symbol.container : row.container;
  const qualified = container ? `${container}.${name}` : name;
  return `${row.name}:${row.line} — ${qualified}`;
}

export type BandLine = { no: number; text: string; target: boolean };

/** The preview's lines numbered from `startLine`, the definition's line (`line`) marked. */
export function bandLines(preview: Pick<SymbolPreviewEvent, "startLine" | "lines" | "line">): BandLine[] {
  return preview.lines.map((text, i) => ({ no: preview.startLine + i, text, target: preview.startLine + i === preview.line }));
}

/** How many lines the band shows before it scrolls. */
export const BAND_VISIBLE_LINES = 15;

/** The first line to scroll to so the definition line shows with up to 3 lines of what is above it. */
export function bandScrollLine(lines: readonly BandLine[]): number {
  const at = lines.findIndex((l) => l.target);
  return at < 0 ? 0 : Math.max(0, at - 3);
}

export type BandKeyResult = { kind: "select"; index: number } | { kind: "open" } | { kind: "close" } | null;

/** In the band: ↑ / ↓ switch the candidate (wrapping; the preview follows), Enter opens it, Esc closes the band. */
export function bandKey(key: string, selected: number, count: number): BandKeyResult {
  if (key === "Escape") return { kind: "close" };
  if (count === 0) return null;
  if (key === "Enter") return { kind: "open" };
  if (count < 2) return null;
  if (key === "ArrowDown") return { kind: "select", index: (selected + 1) % count };
  if (key === "ArrowUp") return { kind: "select", index: (selected - 1 + count) % count };
  return null;
}
