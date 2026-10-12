import { randomBytes } from "node:crypto";
import type { ChangedFile } from "../git/checkpoint.js";
import { CommandRefused } from "../errors.js";
import type { PreReviewEffort, PreReviewEvent, PreReviewFinding, PreReviewRun, PreReviewScope } from "../protocol.js";
import type { SessionLog } from "../session/events.js";
import { fenceFor } from "../side/context.js";
import type { SideQueryEvent, SideQueryResult } from "../side/sideQuery.js";
import type { DetachedHandle, DetachedRun } from "../side/threads.js";
import type { ReviewGate } from "./gate.js";
import { fileListLines, roundPatch, type RoundPatch } from "./roundPatch.js";

/**
 * wave3 engine-flow — §36.13 (market-04): AI pre-review. `prereview_start` runs the CLI's `/code-review <effort>` in a
 * read-only fork of the main session with `CLAUDE_CODE_REPORT_FINDINGS=1`, told to review only this round's change; its
 * `ReportFindings` calls become findings on the diff lines. The main chat's own `ReportFindings` calls (a `/code-review`
 * the user typed there) become runs too (`source: "main"`). Runs live in `gate.prereviews` (newest first, ≤ 5), are
 * stored with the review and go when the round ends.
 */

/** `state.gate.prereviews` keeps at most this many runs. */
export const PREREVIEW_MAX_RUNS = 5;
/** The round's patch in the prompt: at most this many lines, then the file list. */
export const PREREVIEW_PATCH_LINES = 3000;
/** The fork may also run these (they report, they change nothing). */
export const PREREVIEW_TOOLS = ["ReportFindings"];
export const PREREVIEW_MAX_TURNS = 60;
/** `error` of a run the engine stopped (closing the project or the app, switching the chat: the fork belongs to the chat). */
export const PREREVIEW_INTERRUPTED = "interrupted";
/** `error` of a run a restored review file still had running (the app went away mid-run). */
export const PREREVIEW_CLOSED = "interrupted (ReviewGate was closed)";

export const PREREVIEW_SYSTEM =
  "You are reviewing the changes of the coding session above for the user, in a separate read-only session. Do not modify " +
  "files, run mutating commands or start agents — those calls are refused. Read code with read-only tools when you need " +
  "context, and report what you find with the ReportFindings tool.";

export function isPreReviewScope(v: unknown): v is PreReviewScope {
  return v === "round" || v === "files";
}

export function isPreReviewEffort(v: unknown): v is PreReviewEffort {
  return v === "low" || v === "medium" || v === "high";
}

type Found = Omit<PreReviewFinding, "id">;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * One `ReportFindings` input (`{level, findings: [{file, line, summary, short_summary, failure_scenario, category?}]}`) as
 * findings: `file` through `rel` (repo-relative), `line` a positive integer or null (the whole file), a finding without a
 * file or any summary skipped; an empty `summary` takes the short one.
 */
export function parseReportFindings(input: unknown, rel: (file: string) => string): Found[] {
  const list = input && typeof input === "object" ? (input as { findings?: unknown }).findings : undefined;
  if (!Array.isArray(list)) return [];
  const out: Found[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    const file = str(f.file);
    const short = str(f.short_summary);
    const summary = str(f.summary) || short;
    if (!file || !summary) continue;
    const n = typeof f.line === "number" ? f.line : typeof f.line === "string" && /^\d+$/.test(f.line.trim()) ? Number(f.line.trim()) : NaN;
    const category = str(f.category);
    out.push({ file: rel(file), line: Number.isInteger(n) && n > 0 ? n : null, summary, shortSummary: short, failureScenario: str(f.failure_scenario), ...(category ? { category } : {}) });
  }
  return out;
}

const sameFinding = (a: Found, b: Found): boolean => a.file === b.file && a.line === b.line && a.summary === b.summary;

/** `found` appended to `existing` with ids `f<next>`, `f<next+1>`, … (a run's counter: a dismissed id is never reused); repeats dropped. */
export function withIds(existing: readonly PreReviewFinding[], found: readonly Found[], next: number): { findings: PreReviewFinding[]; next: number } {
  const findings = [...existing];
  let n = next;
  for (const f of found) {
    if (findings.some((x) => sameFinding(x, f))) continue;
    findings.push({ id: `f${n++}`, ...f });
  }
  return { findings, next: n };
}

/** The fork's prompt: the slash command first (its arguments are the rest of the message), then the scope and the patch. */
export function prereviewPrompt(input: { effort: PreReviewEffort; files: readonly Pick<ChangedFile, "path" | "oldPath" | "status" | "added" | "deleted" | "isBinary">[]; patch: RoundPatch }): string {
  const parts = [
    `/code-review ${input.effort}`,
    "[ReviewGate AI pre-review — read-only]",
    "Review ONLY the change in the patch below: the files Claude changed in this review round (from the snapshot taken " +
      "before the round to now). Other uncommitted changes in the working tree are not part of it — do not report on them. " +
      "Report every finding with the ReportFindings tool (file paths relative to the repository root, line numbers on the " +
      "new side of the patch). Do not change any file.",
  ];
  if (input.patch.text) {
    const f = fenceFor(input.patch.text);
    parts.push(`${input.patch.truncated ? `Patch (cut after ${input.patch.lines} lines — read the files for the rest):` : "Patch:"}\n${f}diff\n${input.patch.text.replace(/\n$/, "")}\n${f}`);
  }
  parts.push(["Files in this round:", ...fileListLines(input.files)].join("\n"));
  return parts.join("\n\n");
}

export function cloneRun(r: PreReviewRun): PreReviewRun {
  return { ...r, ...(r.paths ? { paths: [...r.paths] } : {}), findings: r.findings.map((f) => ({ ...f })) };
}

/** `run` first (replacing a run with its id), at most `PREREVIEW_MAX_RUNS`: the oldest that are not running go. */
export function upsertRun(runs: readonly PreReviewRun[], run: PreReviewRun): PreReviewRun[] {
  const i = runs.findIndex((r) => r.prereviewId === run.prereviewId);
  const next = i >= 0 ? runs.map((r, j) => (j === i ? run : r)) : [run, ...runs];
  for (let j = next.length - 1; next.length > PREREVIEW_MAX_RUNS && j >= 0; j--) if (next[j]!.status !== "running") next.splice(j, 1);
  return next;
}

function isFinding(v: unknown): v is PreReviewFinding {
  const f = v as PreReviewFinding;
  return !!f && typeof f === "object" && typeof f.id === "string" && typeof f.file === "string" && (f.line === null || typeof f.line === "number")
    && typeof f.summary === "string" && typeof f.shortSummary === "string" && typeof f.failureScenario === "string";
}

/** The runs of a review file (lenient: malformed entries dropped); a run that was still running has failed. */
export function restoreRuns(raw: unknown): PreReviewRun[] {
  if (!Array.isArray(raw)) return [];
  const out: PreReviewRun[] = [];
  for (const v of raw) {
    const r = v as PreReviewRun;
    if (!r || typeof r !== "object" || typeof r.prereviewId !== "string" || !r.prereviewId) continue;
    if (!["running", "done", "failed", "cancelled"].includes(r.status) || (r.source !== "round" && r.source !== "main")) continue;
    if (typeof r.startedAt !== "string" || !Array.isArray(r.findings)) continue;
    const run: PreReviewRun = {
      prereviewId: r.prereviewId,
      status: r.status,
      source: r.source,
      ...(isPreReviewScope(r.scope) ? { scope: r.scope } : {}),
      ...(Array.isArray(r.paths) ? { paths: r.paths.filter((p): p is string => typeof p === "string") } : {}),
      ...(isPreReviewEffort(r.effort) ? { effort: r.effort } : {}),
      endTree: typeof r.endTree === "string" ? r.endTree : null,
      startedAt: r.startedAt,
      ...(typeof r.endedAt === "string" ? { endedAt: r.endedAt } : {}),
      findings: r.findings.filter(isFinding).map((f) => ({ ...f })),
      ...(typeof r.error === "string" ? { error: r.error } : {}),
      ...(typeof r.costUSD === "number" && Number.isFinite(r.costUSD) ? { costUSD: r.costUSD } : {}),
    };
    if (run.status === "running") {
      run.status = "failed";
      run.error = PREREVIEW_CLOSED;
      run.endedAt ??= new Date().toISOString();
    }
    out.push(run);
  }
  return out.slice(0, PREREVIEW_MAX_RUNS);
}

/** What the runner needs from the engine. */
export type PreReviewHost = {
  gate: ReviewGate;
  /** `SideThreads.startDetached` (throws `side_limit` / `cli_not_found` / `cli_not_executable` / `no_project`). */
  startFork(run: DetachedRun): Promise<DetachedHandle>;
  /** A finding's file as the review names it (repo-relative when inside the repository). */
  rel(file: string): string;
  emit(ev: PreReviewEvent): void;
  /** `gate.prereviews` changed: persist the review, schedule a state snapshot. */
  changed(): void;
  log: SessionLog;
  now(): number;
};

/** A running round run: its fork, its id counter, a user cancel, findings reported before `start` stored it. */
type Live = { handle: DetachedHandle | null; next: number; cancelled: boolean; early: Found[] };

/** Starts, tracks, cancels and dismisses pre-reviews; records the main chat's `ReportFindings`. */
export class PreReviewRunner {
  private readonly live = new Map<string, Live>();

  constructor(private readonly host: PreReviewHost) {}

  private iso(): string {
    return new Date(this.host.now()).toISOString();
  }

  private find(prereviewId: string): PreReviewRun {
    const run = this.host.gate.prereviews.find((r) => r.prereviewId === prereviewId);
    if (!run) throw new CommandRefused(`unknown_prereview:${prereviewId}`, { code: "unknown_prereview" });
    return run;
  }

  /** Replaces the stored run (when it is still there: the round may have ended meanwhile) and sends it. */
  private publish(run: PreReviewRun, keep = true): void {
    const g = this.host.gate;
    if (keep) {
      g.prereviews = upsertRun(g.prereviews, run);
      this.host.changed();
    }
    this.host.emit({ type: "prereview", ...cloneRun(run) });
  }

  /** `prereview_start`: resolves with the running run once the fork runs (the reply). */
  async start(scope: unknown, paths: unknown, effort: unknown): Promise<PreReviewEvent> {
    if (!isPreReviewScope(scope) || !isPreReviewEffort(effort)) throw new CommandRefused("invalid_prereview");
    const wanted = scope === "files" ? (Array.isArray(paths) ? [...new Set(paths.filter((p): p is string => typeof p === "string" && p.length > 0))] : []) : [];
    if (scope === "files" && wanted.length === 0) throw new CommandRefused("invalid_prereview");
    const g = this.host.gate;
    const cp = g.checkpoint;
    if (!cp) throw new CommandRefused("no_project");
    const start = g.turnStartTree;
    const end = g.reviewEndTree;
    if (start === null || end === null || g.changedFiles.length === 0) throw new CommandRefused("no_review");
    if (g.prereviews.some((r) => r.source === "round" && r.status === "running")) throw new CommandRefused("prereview_running");
    for (const p of wanted) if (!g.changedFiles.some((f) => f.path === p)) throw new CommandRefused(`not_a_changed_file:${p}`);
    const files = scope === "round" ? [...g.changedFiles] : g.changedFiles.filter((f) => wanted.includes(f.path));
    const patch = await roundPatch(cp, start, end, files, PREREVIEW_PATCH_LINES);
    const prereviewId = `pr-${randomBytes(4).toString("hex")}`;
    const run: PreReviewRun = {
      prereviewId,
      status: "running",
      source: "round",
      scope,
      ...(scope === "files" ? { paths: files.map((f) => f.path) } : {}),
      effort,
      endTree: end,
      startedAt: this.iso(),
      findings: [],
    };
    const live: Live = { handle: null, next: 1, cancelled: false, early: [] };
    this.live.set(prereviewId, live);
    let handle: DetachedHandle;
    try {
      handle = await this.host.startFork({
        key: `prereview:${prereviewId}`,
        prompt: prereviewPrompt({ effort, files, patch }),
        // No web (as commit_draft): the patch under review is untrusted text, and WebFetch / WebSearch could carry it out.
        options: { env: { CLAUDE_CODE_REPORT_FINDINGS: "1" }, extraTools: [...PREREVIEW_TOOLS], persistSession: false, allowWeb: false, maxTurns: PREREVIEW_MAX_TURNS, system: PREREVIEW_SYSTEM },
        onEvent: (ev) => this.onForkEvent(prereviewId, ev),
      });
    } catch (e) {
      this.live.delete(prereviewId);
      throw e;
    }
    live.handle = handle;
    // Findings reported before the run was stored ride along with the reply.
    const first = withIds([], live.early, live.next);
    live.next = first.next;
    live.early = [];
    const stored: PreReviewRun = { ...run, findings: first.findings };
    const g2 = this.host.gate;
    g2.prereviews = upsertRun(g2.prereviews, stored);
    this.host.changed();
    void handle.done.then((result) => this.finish(prereviewId, result));
    return { type: "prereview", ...cloneRun(stored) };
  }

  private onForkEvent(prereviewId: string, ev: SideQueryEvent): void {
    if (ev.type !== "tool_use" || !PREREVIEW_TOOLS.includes(ev.name)) return;
    const live = this.live.get(prereviewId);
    const found = parseReportFindings(ev.input, (f) => this.host.rel(f));
    if (!live || found.length === 0) return;
    const run = live.handle ? this.host.gate.prereviews.find((r) => r.prereviewId === prereviewId) : undefined;
    if (!live.handle) {
      live.early.push(...found);
      return;
    }
    if (!run) return; // the round ended meanwhile
    const { findings, next } = withIds(run.findings, found, live.next);
    live.next = next;
    this.publish({ ...cloneRun(run), findings });
  }

  private finish(prereviewId: string, result: SideQueryResult): void {
    const live = this.live.get(prereviewId);
    this.live.delete(prereviewId);
    const run = this.host.gate.prereviews.find((r) => r.prereviewId === prereviewId);
    if (!run) return; // the round ended meanwhile
    const ended: PreReviewRun = { ...cloneRun(run), endedAt: this.iso(), ...(result.costUSD > 0 ? { costUSD: result.costUSD } : {}) };
    if (live?.cancelled) ended.status = "cancelled";
    else if (result.stopReason === "interrupted") {
      ended.status = "failed";
      ended.error = PREREVIEW_INTERRUPTED;
    } else if (result.error) {
      ended.status = "failed";
      ended.error = firstLine(result.error);
    } else ended.status = "done";
    if (ended.status === "failed") this.host.log("warn", `prereview ${prereviewId} failed: ${ended.error}`);
    this.publish(ended);
  }

  /** `prereview_cancel`: stops a running run (it ends `cancelled`). */
  async cancel(prereviewId: string): Promise<void> {
    const run = this.find(prereviewId);
    const live = this.live.get(prereviewId);
    if (run.status !== "running" || !live?.handle) throw new CommandRefused("not_running");
    live.cancelled = true;
    await live.handle.cancel();
  }

  /** `prereview_dismiss`: removes a finding. */
  dismiss(prereviewId: string, findingId: string): void {
    const run = this.find(prereviewId);
    if (!run.findings.some((f) => f.id === findingId)) throw new CommandRefused(`unknown_finding:${findingId}`, { code: "unknown_finding" });
    this.publish({ ...cloneRun(run), findings: run.findings.filter((f) => f.id !== findingId) });
  }

  /**
   * The main chat's `ReportFindings` call: a done run keyed by its tool_use id, kept while a review is in progress. One
   * made in a turn that starts a review (no review yet: Claude reviewed its own edits) waits for that turn's collection
   * and joins the review it created, on its B (`sync`).
   */
  onMainReport(toolUseId: string, input: unknown): void {
    const found = parseReportFindings(input, (f) => this.host.rel(f));
    const g = this.host.gate;
    const now = this.iso();
    const run: PreReviewRun = {
      prereviewId: toolUseId,
      status: "done",
      source: "main",
      endTree: g.reviewEndTree,
      startedAt: now,
      endedAt: now,
      findings: withIds([], found, 1).findings,
    };
    const inReview = g.reviewEndTree !== null && g.changedFiles.length > 0;
    if (!inReview && g.running && found.length > 0) this.pendingMain.push({ run, start: g.turnStartTree });
    this.publish(run, inReview);
  }

  /** Main-chat runs of a turn that had no review yet, with the A it started from (`onMainReport`). */
  private pendingMain: { run: PreReviewRun; start: string | null }[] = [];

  /**
   * Called on every review change (the engine's persist): forks of runs no longer stored (their round ended) are stopped
   * — nothing would show their findings —, and the pending main-chat runs join the review their turn's collection
   * created (same A, files listed) or go.
   */
  sync(): void {
    const g = this.host.gate;
    for (const [id, live] of this.live) {
      if (!live.handle || live.cancelled || g.prereviews.some((r) => r.prereviewId === id)) continue;
      live.cancelled = true;
      void live.handle.cancel().catch(() => undefined);
    }
    if (this.pendingMain.length === 0 || g.running || g.turnEndTree === null) return;
    const pending = this.pendingMain.splice(0);
    if (g.changedFiles.length === 0) return;
    for (const p of pending) {
      if (p.start !== g.turnStartTree) continue;
      const run: PreReviewRun = { ...cloneRun(p.run), endTree: g.reviewEndTree };
      g.prereviews = upsertRun(g.prereviews, run);
      this.host.emit({ type: "prereview", ...cloneRun(run) });
    }
  }

  get runningCount(): number {
    return this.live.size;
  }
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? s).trim().slice(0, 300);
}
