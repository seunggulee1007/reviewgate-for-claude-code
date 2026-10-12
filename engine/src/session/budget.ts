import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { diffLines } from "diff";
import type { Budget } from "../protocol.js";

export const DEFAULT_HARD_MULTIPLIER = 1.5;

/** Per-turn change-budget state. Reset on every user_message / turn_end. */
export class BudgetState {
  files = new Set<string>();
  lines = 0;
  denied = false;
  callsAfterDeny = 0;
  /** soft (100%) warning already emitted this turn */
  warned = false;
  budget: Budget;

  constructor(budget: Budget) {
    this.budget = budget;
  }

  reset(): void {
    this.files = new Set();
    this.lines = 0;
    this.denied = false;
    this.callsAfterDeny = 0;
    this.warned = false;
  }

  setBudget(budget: Budget): void {
    this.budget = budget;
  }

  get hardMultiplier(): number {
    return this.budget.hardMultiplier ?? DEFAULT_HARD_MULTIPLIER;
  }

  /** True if the given (projected) totals exceed the hard limit (budget × hardMultiplier). */
  wouldExceedHard(files: number, lines: number): boolean {
    const m = this.hardMultiplier;
    return files > this.budget.maxFiles * m || lines > this.budget.maxLines * m;
  }

  /** True if current totals are at/over 100% of the soft budget. */
  exceedsSoft(): boolean {
    return this.files.size >= this.budget.maxFiles || this.lines >= this.budget.maxLines;
  }

  snapshot(): { files: number; lines: number; denied: boolean } {
    return { files: this.files.size, lines: this.lines, denied: this.denied };
  }
}

/** Number of lines in a string ("" → 0; trailing newline does not add a line). */
export function countLines(s: string): number {
  if (s.length === 0) return 0;
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function readFileOrNull(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/** Resolve a tool file path against cwd. */
export function resolveToolPath(p: string, cwd: string): string {
  return resolvePath(cwd, p);
}

function estimateEdit(
  edit: { old_string?: unknown; new_string?: unknown; replace_all?: unknown },
  filePath: string | null,
): number {
  const oldS = str(edit.old_string);
  const newS = str(edit.new_string);
  let base = countLines(oldS) + countLines(newS);
  if (edit.replace_all === true && filePath) {
    const content = readFileOrNull(filePath);
    if (content !== null) {
      const occ = countOccurrences(content, oldS);
      if (occ > 1) base *= occ;
    }
  }
  return base;
}

/**
 * Estimate the number of changed lines a file-editing tool call would produce.
 * Edit: lines(old)+lines(new) (× occurrences if replace_all).
 * Write: diffLines(existing, content) added+removed, or lines(content) for a new file.
 * MultiEdit: sum of edits. NotebookEdit: lines(new_source).
 */
export function estimateEditLines(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): number {
  const rawPath = str(input.file_path) || str(input.notebook_path);
  const filePath = rawPath ? resolveToolPath(rawPath, cwd) : null;

  switch (toolName) {
    case "Edit":
      return estimateEdit(input, filePath);
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      let total = 0;
      for (const e of edits) {
        if (e && typeof e === "object") total += estimateEdit(e as Record<string, unknown>, filePath);
      }
      return total;
    }
    case "Write": {
      const content = str(input.content);
      const existing = filePath ? readFileOrNull(filePath) : null;
      if (existing === null) return countLines(content);
      let changed = 0;
      for (const part of diffLines(existing, content)) {
        if (part.added || part.removed) changed += part.count ?? countLines(part.value);
      }
      return changed;
    }
    case "NotebookEdit":
      return countLines(str(input.new_source));
    default:
      return 0;
  }
}

