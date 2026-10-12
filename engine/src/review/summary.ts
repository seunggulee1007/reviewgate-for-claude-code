import type { ChangedFile } from "../git/checkpoint.js";
import type { FileWhy, PlanVsActual, RationaleSource, TestOutcome, TurnSummaryCommand, TurnSummaryEvent, TurnSummaryFile } from "../protocol.js";
import { originOf } from "../session/provenance.js";
import { lastTestOf } from "./tests.js";
import { fileWhy } from "./why.js";
import { fileRiskFields } from "./fileRisk.js"; // MARK: wave4b w4b-files

/**
 * `turn_summary` (docs/PROTOCOL.md §15): what the turn changed and why, the commands it ran and — when
 * a plan was approved in the session — which plan steps the changed files belong to. Pure functions.
 */

/** What the engine remembers about one tool call (tool_use + its tool_result). */
export type ToolCallInfo = {
  name: string;
  rationale?: string;
  parentToolUseId?: string;
  /** Bash only. */
  command?: string;
  /** Compact input preview (side-question anchor context, §21); never on the wire. */
  inputPreview?: string;
  isError?: boolean;
  testOutcome?: TestOutcome;
  // MARK: wave2 engine-why
  /** §34.8: where `rationale` came from and the agent's calls between that text and this call. */
  rationaleSource?: RationaleSource;
  rationaleAge?: number;
  /** §34.8 / §34.9: the engine turn the call ran in, and its tool_use order in the session ("the latest call"). */
  turn?: number;
  seq?: number;
  /** Agent / Task calls: the subagent type and its report (the call's result, ≤ 4 000 chars). */
  subagentType?: string;
  report?: string;
  /** §34.9: the order and time (ISO-8601) its tool_result arrived. */
  resultSeq?: number;
  resultAt?: string;
  /** §34.9: the call changed files — an edit tool with a successful result, a Bash call the post-Bash snapshot attributed files to. */
  fileChanging?: true;
};

export type PlanStep = { text: string; done: boolean | null; body: string };

const CHECK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const NUMBERED_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const STEP_HEADING_RE = /^#{1,6}\s+(?:(?:step|phase|단계)\s*\d+\s*[:.)\-–—]?\s*|\d+[.)]\s+)(.*)$/i;
const HEADING_RE = /^#{1,6}\s+/;
const BULLET_RE = /^[-*+]\s+(.*)$/;

/** Strips inline markdown (`**`, `__`, backticks, links) for display. */
export function plainText(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Plan steps: checklist items (`- [ ] …` / `- [x] …`), numbered items (`1. …` / `1) …`) and step
 * headings (`## Step 2: …`, `### 3. …`). Each step's `body` is its own line plus the lines under it
 * up to the next step or heading (sub-bullets often name the files). Without any of those, the
 * top-level bullets are the steps. Nested numbered items under a checklist / numbered item stay in
 * its body only when they are indented deeper than the item.
 */
export function parsePlanSteps(markdown: string): PlanStep[] {
  const lines = markdown.split(/\r?\n/);
  type Anchor = { line: number; indent: number; text: string; done: boolean | null };
  const anchors: Anchor[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let m = CHECK_RE.exec(line);
    if (m) {
      anchors.push({ line: i, indent: m[1]!.length, text: m[3]!, done: m[2] !== " " });
      continue;
    }
    m = NUMBERED_RE.exec(line);
    if (m) {
      anchors.push({ line: i, indent: m[1]!.length, text: m[3]!, done: null });
      continue;
    }
    m = STEP_HEADING_RE.exec(line);
    if (m) anchors.push({ line: i, indent: -1, text: m[1]!, done: null });
  }
  // Nested items belong to the item above them: keep only the shallowest level of each run.
  const top: Anchor[] = [];
  for (const a of anchors) {
    const parent = top[top.length - 1];
    if (parent && a.indent > parent.indent && parent.indent >= 0 && !hasHeadingBetween(lines, parent.line, a.line)) continue;
    top.push(a);
  }
  if (top.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      const m = BULLET_RE.exec(lines[i]!);
      if (m) top.push({ line: i, indent: 0, text: m[1]!, done: null });
    }
  }
  return top
    .map((a, k) => {
      const end = k + 1 < top.length ? top[k + 1]!.line : lines.length;
      const bodyLines = [lines[a.line]!];
      for (let i = a.line + 1; i < end; i++) {
        if (HEADING_RE.test(lines[i]!)) break;
        bodyLines.push(lines[i]!);
      }
      return { text: plainText(a.text), done: a.done, body: bodyLines.join("\n") };
    })
    .filter((s) => s.text.length > 0);
}

function hasHeadingBetween(lines: string[], from: number, to: number): boolean {
  for (let i = from + 1; i < to; i++) if (HEADING_RE.test(lines[i]!)) return true;
  return false;
}

/** Stems too generic to count as a mention on their own (the basename with extension still matches). */
const GENERIC_STEMS = new Set(["index", "main", "utils", "util", "types", "style", "styles", "config", "test", "tests", "readme", "setup", "helpers", "common", "package"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `text` mentions repo-relative `path`: the full path, a trailing sub-path (`src/a.ts` for
 * `pkg/src/a.ts`), the basename with its extension as a token, or — for distinctive names (≥ 5
 * chars, not `index`/`utils`/…) — the basename without extension as a whole word. Case-insensitive.
 */
export function mentionsPath(text: string, path: string): boolean {
  // MARK: wave3 check-engine — §37.6: a path written with its folders names that file only (a Windows `\` reads as `/`):
  // `acme-api/pom.xml` is not `acme-core/pom.xml`, `acme-core/pom.xml` does not contain `core/pom.xml`.
  const hay = text.toLowerCase().replace(/\\/g, "/");
  const p = path.toLowerCase();
  // The whole path, alone or as the tail of a longer one (an absolute path).
  if (occursAsName(hay, p, true)) return true;
  const parts = p.split("/");
  for (let k = 1; k < parts.length - 1; k++) {
    // A trailing sub-path only where the mention starts with it (`api/src/Svc.java` is another folder's `src/Svc.java`).
    if (occursAsName(hay, parts.slice(k).join("/"), false)) return true;
  }
  const base = parts[parts.length - 1]!;
  // The bare basename / stem — not after a `/`: a qualified mention names its own folder's file (taken above when it is this one).
  if (base.includes(".") && new RegExp(`(^|[^a-z0-9_.\\-/])${escapeRe(base)}($|[^a-z0-9_\\-])`).test(hay)) return true;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  if (stem.length >= 5 && !GENERIC_STEMS.has(stem) && new RegExp(`(^|[^a-z0-9_/])${escapeRe(stem)}($|[^a-z0-9_])`).test(hay)) return true;
  return false;
}

/**
 * MARK: wave3 check-engine — §37.6: `needle` (a path) in `hay` as a whole name: no name character right before it (a `/`
 * only when `afterSlash`: the tail of a longer path) and none right after it (a `.` may end the sentence).
 */
function occursAsName(hay: string, needle: string, afterSlash: boolean): boolean {
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = i > 0 ? hay[i - 1]! : "";
    const after = hay[i + needle.length] ?? "";
    const startsName = before === "" || !/[a-z0-9_.\-/]/.test(before) || (afterSlash && before === "/");
    if (startsName && !/[a-z0-9_\-]/.test(after)) return true;
  }
  return false;
}

/** Plan steps ↔ changed files: every step with the files it mentions, and the files no step mentions. */
export function matchPlan(steps: PlanStep[], files: string[], path: string | null): PlanVsActual {
  const matched = new Set<string>();
  const out = steps.map((s, index) => {
    const hits = files.filter((f) => mentionsPath(s.body, f));
    for (const f of hits) matched.add(f);
    return { index, text: s.text, ...(s.done !== null ? { done: s.done } : {}), files: hits };
  });
  return { path, steps: out, unplannedFiles: files.filter((f) => !matched.has(f)) };
}

/**
 * Why the file changed: §34.8 — the `FileWhy` the collection set on the file (`whyDetail`; `why` / `whyToolUseId`
 * mirror its text / call); a file without one (an older caller) gets it from its touching calls (§12).
 */
function whyOf(file: ChangedFile & { why?: FileWhy }, calls: ReadonlyMap<string, ToolCallInfo>): { why: string | null; whyToolUseId: string | null; whyDetail: FileWhy } {
  const detail = file.why ?? fileWhy(file, { calls, turn: -1, mainReport: "" }, true);
  return { why: detail.text, whyToolUseId: detail.toolUseId ?? null, whyDetail: detail };
}

export function buildTurnSummary(input: {
  turn: number;
  files: ChangedFile[];
  calls: ReadonlyMap<string, ToolCallInfo>;
  /** Bash tool_use ids of the turn, in order. */
  commandIds: string[];
  plan: { path: string | null; plan: string } | null;
}): Omit<TurnSummaryEvent, "type"> {
  const files: TurnSummaryFile[] = input.files.map((f) => ({
    path: f.path,
    status: f.status,
    state: f.state,
    adds: f.added,
    dels: f.deleted,
    ...whyOf(f, input.calls),
    tools: [...f.tools],
    toolUseIds: [...f.toolUseIds],
    origin: originOf(f),
    ...fileRiskFields(f), // MARK: wave4b w4b-files — §40.2: the card shows the list's badges
  }));
  const commands: TurnSummaryCommand[] = [];
  for (const id of input.commandIds) {
    const c = input.calls.get(id);
    if (!c || c.command === undefined) continue;
    commands.push({
      toolUseId: id,
      command: c.command,
      isError: c.isError === true,
      ...(c.testOutcome !== undefined ? { testOutcome: c.testOutcome } : {}),
      ...(c.parentToolUseId !== undefined ? { parentToolUseId: c.parentToolUseId } : {}),
    });
  }
  const plan = input.plan ? matchPlan(parsePlanSteps(input.plan.plan), files.map((f) => f.path), input.plan.path) : null;
  return { turn: input.turn, files, commands, plan, lastTest: lastTestOf(input.calls, input.turn) };
}
