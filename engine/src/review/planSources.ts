import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { MAX_PLAN_BYTES, type PlanSourceKind, type PlanStepBrief, type PlanVsActual } from "../protocol.js";
import { matchPlan, mentionsPath, parsePlanSteps, plainText, type PlanStep } from "./summary.js";

/**
 * MARK: wave4d w4d-plan — docs/PROTOCOL.md §42.1: plans you can review and follow. The steps of a proposed plan for the
 * plan card's per-step notes (market-08), and where "plan vs actual" (§15) gets its plan when none was approved in
 * ReviewGate (comp-17): a plan file the user chose or named in the chat, Claude's own to-do list (TodoWrite / the Task
 * tools), the first message's numbered list — and without any of them, the files the first request named ("outside the
 * request"). Pure functions (the file reads are capped and never throw).
 */

/** Longest step text in `pendingPlan.steps` (the card shows it in one line). */
export const PLAN_STEP_TEXT_MAX = 300;
/** At most this many steps are listed for notes. */
export const PLAN_STEPS_MAX = 200;
/** At most this many plan files are offered to choose from. */
export const PLAN_CANDIDATES_MAX = 12;

/** The steps a plan card lists (index 0-based, the clients number them index + 1). */
export function planStepBriefs(markdown: string): PlanStepBrief[] {
  return parsePlanSteps(markdown)
    .slice(0, PLAN_STEPS_MAX)
    .map((s, index) => ({ index, text: s.text.slice(0, PLAN_STEP_TEXT_MAX) }));
}

/** A Markdown file that is a plan by its place or its name: under a `plans/` folder or named `plan…` / `…-plan…`. */
export function isPlanFilePath(p: string): boolean {
  const s = p.replace(/\\/g, "/").toLowerCase();
  if (!s.endsWith(".md")) return false;
  if (/(^|\/)plans\//.test(s)) return true;
  return /(^|[^a-z])plan/.test(basename(s));
}

const MD_PATH_RE = /[~\w.\-/\\:]*\.md(?![\w])/gi;

/** Plan files a user message names — its @mentions first, then path-like words — in the order they appear, deduped. */
export function planFilesNamed(text: string, mentions: readonly string[] = []): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const p = raw.trim();
    if (p.length > 3 && p.length < 1024 && isPlanFilePath(p) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(p) && !out.includes(p)) out.push(p);
  };
  for (const m of mentions) add(m);
  for (const m of text.matchAll(MD_PATH_RE)) add(m[0]);
  return out;
}

/** `raw` (repo-relative, absolute or `~/…`) as an absolute path. */
export function resolvePlanPath(raw: string, root: string, home: string): string {
  const p = raw.trim();
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return isAbsolute(p) ? p : resolve(root, p);
}

/** The plan file's text (capped at `MAX_PLAN_BYTES`), or null when it is no readable Markdown file. */
export function readPlanFile(abs: string): string | null {
  try {
    if (!abs.toLowerCase().endsWith(".md")) return null;
    const st = statSync(abs);
    if (!st.isFile()) return null;
    return readFileSync(abs, "utf8").slice(0, MAX_PLAN_BYTES);
  } catch {
    return null;
  }
}

/** Repo-relative when inside `root`, else as given (the clients show the name; the path is the tooltip). */
export function displayPlanPath(abs: string, root: string): string {
  const rel = relative(root, abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replace(/\\/g, "/") : abs;
}

/**
 * Plan files to choose from: the repository's `.omc/plans/*.md` and `.claude/plans/*.md`, plan-named Markdown under `docs/`
 * (two levels), then the five newest files of Claude Code's own plans folder (`userPlansDir`, plan mode) — newest first
 * within each place.
 */
export function planCandidates(root: string, userPlansDir: string | null, limit = PLAN_CANDIDATES_MAX): string[] {
  const out: string[] = [];
  const list = (dir: string, depth: number, onlyPlanNames: boolean): { path: string; mtime: number }[] => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const found: { path: string; mtime: number }[] = [];
    for (const n of names.slice(0, 500)) {
      if (n.startsWith(".") && n !== ".omc") continue;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth > 0 && n !== "node_modules") found.push(...list(p, depth - 1, onlyPlanNames));
      } else if (st.isFile() && n.toLowerCase().endsWith(".md") && (!onlyPlanNames || isPlanFilePath(p))) {
        found.push({ path: p, mtime: st.mtimeMs });
      }
    }
    return found;
  };
  const add = (found: { path: string; mtime: number }[], max: number) => {
    for (const f of found.sort((a, b) => b.mtime - a.mtime).slice(0, max)) if (!out.includes(f.path)) out.push(f.path);
  };
  add(list(join(root, ".omc", "plans"), 1, false), limit);
  add(list(join(root, ".claude", "plans"), 0, false), limit);
  add(list(join(root, "docs"), 2, true), limit);
  if (userPlansDir && existsSync(userPlansDir)) add(list(userPlansDir, 0, false), 5);
  return out.slice(0, limit);
}

/** A TodoWrite call's list as steps (`done` = completed); null when the input carries no list. */
export function todoWriteSteps(input: unknown): PlanStep[] | null {
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return null;
  const steps: PlanStep[] = [];
  for (const t of todos) {
    const o = t as { content?: unknown; activeForm?: unknown; status?: unknown } | null;
    const content = typeof o?.content === "string" ? o.content : "";
    const text = plainText(content);
    if (!text) continue;
    const active = typeof o?.activeForm === "string" ? o.activeForm : "";
    steps.push({ text: text.slice(0, PLAN_STEP_TEXT_MAX), done: o?.status === "completed", body: active ? `${content}\n${active}` : content });
  }
  return steps;
}

/** One task of the Task tools' list (`TaskCreate` / `TaskUpdate`). */
export type TaskItem = { id: string; text: string; body: string; done: boolean };

/**
 * The task list after a `TaskCreate` / `TaskUpdate` call (null: not a task tool). A created task gets the next number
 * as its id (the CLI numbers them 1, 2, …); an update names it by `taskId` (status `completed` marks it done, `deleted`
 * drops it, a new subject / description replaces the old one).
 */
export function applyTaskTool(list: readonly TaskItem[], name: string, input: unknown): TaskItem[] | null {
  const o = (input ?? {}) as { subject?: unknown; description?: unknown; taskId?: unknown; status?: unknown };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (name === "TaskCreate") {
    const subject = str(o.subject);
    const text = plainText(subject);
    if (!text) return [...list];
    const next = list.reduce((n, t) => Math.max(n, Number.parseInt(t.id, 10) || 0), 0) + 1;
    return [...list, { id: String(next), text: text.slice(0, PLAN_STEP_TEXT_MAX), body: `${subject}\n${str(o.description)}`, done: false }];
  }
  if (name === "TaskUpdate") {
    const id = typeof o.taskId === "number" ? String(o.taskId) : str(o.taskId);
    if (!id) return [...list];
    if (o.status === "deleted") return list.filter((t) => t.id !== id);
    return list.map((t) => {
      if (t.id !== id) return t;
      const subject = str(o.subject);
      const description = str(o.description);
      return {
        ...t,
        ...(subject ? { text: plainText(subject).slice(0, PLAN_STEP_TEXT_MAX) } : {}),
        ...(subject || description ? { body: `${subject || t.text}\n${description}` } : {}),
        ...(o.status === "completed" ? { done: true } : o.status === "pending" || o.status === "in_progress" ? { done: false } : {}),
      };
    });
  }
  return null;
}

/** The first message's numbered or checklist items (two or more) as steps; null when it has no such list. */
export function messageSteps(text: string): PlanStep[] | null {
  const listed = text.split(/\r?\n/).filter((l) => /^\s*(?:\d+[.)]|[-*+]\s+\[[ xX]\])\s+\S/.test(l)).length;
  if (listed < 2) return null;
  const steps = parsePlanSteps(text);
  return steps.length >= 2 ? steps : null;
}

/** The request's first sentence (≤ 120 chars, inline markdown and @mentions kept as words). */
export function firstSentence(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const plain = plainText(line);
  const end = plain.search(/[.!?。？！](\s|$)/);
  const s = end >= 0 ? plain.slice(0, end + 1) : plain;
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

const stemOf = (p: string): string => {
  const b = basename(p.replace(/\\/g, "/")).toLowerCase();
  const dot = b.lastIndexOf(".");
  return dot > 0 ? b.slice(0, dot) : b;
};

/** Whether the request covers `file`: its text names it, or an @mention is the file, a folder above it or its name's stem. */
function requestCovers(text: string, mentions: readonly string[], file: string): boolean {
  if (mentionsPath(text, file)) return true;
  const f = file.replace(/\\/g, "/").toLowerCase();
  for (const raw of mentions) {
    const m = raw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!m) continue;
    if (f === m || f.startsWith(`${m}/`) || f.endsWith(`/${m}`)) return true;
    if (mentionsPath(raw, file)) return true;
    // A mentioned file's companions: FooService.java → FooServiceImpl.java, FooServiceTest.java.
    const ms = stemOf(m);
    if (ms.length >= 5 && m.includes(".") && stemOf(f).startsWith(ms)) return true;
  }
  return false;
}

/**
 * Without a plan: the first request (its first sentence, shown as the one "step") against the files it named with an
 * @mention. `unplannedFiles` are the changed files the request does not cover. Null when the request @mentions nothing
 * (every change would be "outside" it — noise, not a signal).
 */
export function requestScope(text: string, mentions: readonly string[], files: readonly string[]): PlanVsActual | null {
  if (mentions.length === 0) return null;
  const title = firstSentence(text) || mentions[0]!;
  const covered = files.filter((f) => requestCovers(text, mentions, f));
  return { path: null, source: "request", title, steps: [{ index: 0, text: title, files: covered }], unplannedFiles: files.filter((f) => !covered.includes(f)) };
}

/** Steps → plan vs actual with its source. */
export function planView(steps: PlanStep[], files: readonly string[], source: PlanSourceKind, path: string | null, title?: string): PlanVsActual {
  return { ...matchPlan(steps, [...files], path), source, ...(title ? { title } : {}) };
}
