/**
 * MARK: wave3 desktop-flow
 * docs/PROTOCOL.md §36.13 — which AI pre-review findings show where, kept free of React so they are tested (the Mac's
 * `PreReviewDisplay`): the newest round run and the main chat's ReportFindings runs are shown (an older round run is replaced
 * by the newer one), per file and per new-side line; a run whose `endTree` is not the review's B looked at an earlier
 * version (its findings are dimmed); the Changes head's status; and what "Add as note" / "Ask in a side thread" carry.
 */
import type { PreReviewFinding, PreReviewRun } from "@reviewgate/engine";
import { t } from "./i18n";
import { preReviewFailure } from "./flowLogic";

/** A shown finding with the run it came from (its id, its B, its source). */
export type PreReviewItem = { run: PreReviewRun; finding: PreReviewFinding; key: string };

export type PreReviewHeadStatus =
  | { kind: "idle" }
  | { kind: "running"; prereviewId: string }
  /** `count` shown findings (round + main chat); `stale`: the round run looked at an earlier B. */
  | { kind: "done"; count: number; stale: boolean }
  | { kind: "failed"; reason: string };

export const findingKey = (prereviewId: string, findingId: string): string => `${prereviewId}#${findingId}`;

/** The runs whose findings are shown: the newest round run and the main chat's runs, newest first as the engine keeps them. */
export function shownRuns(runs: readonly PreReviewRun[]): PreReviewRun[] {
  let roundSeen = false;
  return runs.filter((run) => {
    if (run.source === "main") return true;
    if (roundSeen) return false;
    roundSeen = true;
    return true;
  });
}

/** The newest round run (what the head button reports on). */
export const latestRound = (runs: readonly PreReviewRun[]): PreReviewRun | null => runs.find((r) => r.source === "round") ?? null;

/** The run looked at another B than the review shows now: its lines may have moved. */
export function isStaleRun(run: PreReviewRun, reviewEndTree: string | null | undefined): boolean {
  return !!run.endTree && !!reviewEndTree && run.endTree !== reviewEndTree;
}

export function shownFindings(runs: readonly PreReviewRun[]): PreReviewItem[] {
  return shownRuns(runs).flatMap((run) => (Array.isArray(run.findings) ? run.findings : []).map((finding) => ({ run, finding, key: findingKey(run.prereviewId, finding.id) })));
}

export const findingsOfFile = (runs: readonly PreReviewRun[], path: string): PreReviewItem[] => shownFindings(runs).filter((i) => i.finding.file === path);

/** Findings of `path` per new-side line (the diff's inline cards and marks). */
export function findingsByLine(items: readonly PreReviewItem[]): Map<number, PreReviewItem[]> {
  const map = new Map<number, PreReviewItem[]>();
  for (const item of items) {
    const line = item.finding.line;
    if (typeof line !== "number") continue;
    map.set(line, [...(map.get(line) ?? []), item]);
  }
  return map;
}

/** Findings of `path` no shown diff line carries: the whole file (no line) or a line outside the hunks. */
export function unplacedFindings(items: readonly PreReviewItem[], newLines: ReadonlySet<number> | null): PreReviewItem[] {
  return items.filter((i) => typeof i.finding.line !== "number" || newLines === null || !newLines.has(i.finding.line));
}

/** Files with findings and how many, for the changed-files list. */
export function findingCounts(runs: readonly PreReviewRun[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of shownFindings(runs)) out[item.finding.file] = (out[item.finding.file] ?? 0) + 1;
  return out;
}

export function headStatus(runs: readonly PreReviewRun[], reviewEndTree: string | null | undefined): PreReviewHeadStatus {
  const count = shownFindings(runs).length;
  const round = latestRound(runs);
  if (!round) return count > 0 ? { kind: "done", count, stale: false } : { kind: "idle" };
  switch (round.status) {
    case "running":
      return { kind: "running", prereviewId: round.prereviewId };
    case "failed":
      return { kind: "failed", reason: preReviewFailure(round.error) };
    case "cancelled":
      return count > 0 ? { kind: "done", count, stale: isStaleRun(round, reviewEndTree) } : { kind: "idle" };
    default:
      return { kind: "done", count, stale: isStaleRun(round, reviewEndTree) };
  }
}

/** The first file (in the list's order) with a shown finding — where "N findings" leads. */
export function firstFindingPath(order: readonly string[], counts: Record<string, number>): string | null {
  return order.find((p) => (counts[p] ?? 0) > 0) ?? Object.keys(counts).sort()[0] ?? null;
}

/** The text of a review note made from a finding ("Add as note"). */
export function noteBody(f: PreReviewFinding): string {
  const summary = (f.summary ?? "").trim();
  const scenario = (f.failureScenario ?? "").trim();
  const head = summary || (f.shortSummary ?? "").trim();
  return scenario ? `${head}\n${scenario}` : head;
}

/** The side question asked about a finding ("Ask in a side thread"). */
export function findingQuestion(f: PreReviewFinding): string {
  const summary = (f.summary ?? "").trim() || (f.shortSummary ?? "").trim();
  return t("The AI pre-review flagged this: “{0}” — is it right, and what would you change?", summary);
}

/** A run from the wire with its lists read leniently (an engine may leave `findings` out of a running run). */
export function normalizeRun(run: PreReviewRun): PreReviewRun {
  return Array.isArray(run.findings) ? run : { ...run, findings: [] };
}

/** A `prereview` event (or reply): the run replaces the one with its id; a new one goes first. */
export function applyRun(runs: readonly PreReviewRun[], run: PreReviewRun): PreReviewRun[] {
  if (!run.prereviewId) return [...runs];
  const next = normalizeRun(run);
  const i = runs.findIndex((r) => r.prereviewId === next.prereviewId);
  if (i < 0) return [next, ...runs];
  const out = [...runs];
  out[i] = next;
  return out;
}

/** The finding leaves its run (dismiss, or a note made from it). */
export function withoutFinding(runs: readonly PreReviewRun[], prereviewId: string, findingId: string): PreReviewRun[] {
  return runs.map((r) => (r.prereviewId === prereviewId ? { ...r, findings: r.findings.filter((f) => f.id !== findingId) } : r));
}
