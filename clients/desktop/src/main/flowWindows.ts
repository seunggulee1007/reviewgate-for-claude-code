/**
 * MARK: wave3 desktop-flow
 * What the daily-flow screens hand from one window to another through main (pure, no `electron`; unit-tested):
 * §36.12 a new workbench's failed setup report — the window that ran `workbench_create` passes it with
 * `rg:openWorkbenchWindow`, the new window takes it once its project is open (`rg:takeWorkbenchSetupReport`) and shows the
 * exit and the log; §36.14 "Send to Claude" puts PR comments into the composer of the PR head's workbench window
 * (`rg:composeInWindow` → that window's `rg:menu` `composer_draft`); §9 a message held for a new chat goes with the window
 * of the workbench opened instead (`rg:takeWorkbenchDraft`). Nothing is ever sent to Claude from here.
 */
import { resolve } from "node:path";
import { isComposerDraft, isWorkbenchSetupReport, type WorkbenchSetupReport } from "../shared/flowSettings.js";

/** At most this many reports wait for their window (a window that never opens must not grow the list). */
const MAX_REPORTS = 20;

export type SetupReports = {
  /** Keeps `report` for the window of `path`; false when it is not a report. */
  remember(path: unknown, report: unknown): boolean;
  /** The report of the first of `paths` that has one (and forgets it); null when none has. */
  take(paths: unknown): WorkbenchSetupReport | null;
};

const key = (p: string) => resolve(p).replace(/[\\/]+$/, "");

export function createSetupReports(): SetupReports {
  const reports = new Map<string, WorkbenchSetupReport>();
  return {
    remember(path, report) {
      if (typeof path !== "string" || path.length === 0 || path.length > 4096 || !isWorkbenchSetupReport(report)) return false;
      const k = key(path);
      reports.delete(k);
      reports.set(k, { branch: report.branch, exitCode: report.exitCode, log: report.log });
      while (reports.size > MAX_REPORTS) reports.delete(reports.keys().next().value!);
      return true;
    },
    take(paths) {
      if (!Array.isArray(paths)) return null;
      for (const p of paths.slice(0, 5)) {
        if (typeof p !== "string" || p.length === 0 || p.length > 4096) continue;
        const k = key(p);
        const hit = reports.get(k);
        if (hit) {
          reports.delete(k);
          return hit;
        }
      }
      return null;
    },
  };
}

/** §9 "New Chat in a Workbench": a held message waits this long for its workbench's window (as a §49 task's handoff). */
export const COMPOSER_HANDOFF_MS = 15 * 60_000;

export type ComposerHandoffs = {
  /** Keeps `text` for the window of `path` (the newer one for a folder wins); false when it is no composer text. */
  remember(path: unknown, text: unknown, now?: number): boolean;
  /** A text waits for `path` (its window's first chat is then a chat: a terminal chat has no composer, §57.7). */
  waits(path: unknown, now?: number): boolean;
  /** The text of the first of `paths` that has one (and forgets it); null when none has, or it waited too long. */
  take(paths: unknown, now?: number): string | null;
};

/**
 * §9 "New Chat in a Workbench": the message held for a new chat moves to the new workbench's window — the window that ran
 * `workbench_create` passes it with `rg:openWorkbenchWindow`, the new window takes it once its project is open
 * (`rg:takeWorkbenchDraft`) and puts it into its composer. Never sent.
 */
export function createComposerHandoffs(): ComposerHandoffs {
  const texts = new Map<string, { text: string; at: number }>();
  const pathOk = (p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length <= 4096;
  const fresh = (at: number, now: number) => Math.abs(now - at) <= COMPOSER_HANDOFF_MS;
  return {
    remember(path, text, now = Date.now()) {
      if (!pathOk(path) || !isComposerDraft(text)) return false;
      const k = key(path);
      texts.delete(k);
      texts.set(k, { text, at: now });
      while (texts.size > MAX_REPORTS) texts.delete(texts.keys().next().value!);
      return true;
    },
    waits(path, now = Date.now()) {
      if (!pathOk(path)) return false;
      const hit = texts.get(key(path));
      return hit !== undefined && fresh(hit.at, now);
    },
    take(paths, now = Date.now()) {
      if (!Array.isArray(paths)) return null;
      for (const p of paths.slice(0, 5)) {
        if (!pathOk(p)) continue;
        const k = key(p);
        const hit = texts.get(k);
        if (hit) {
          texts.delete(k);
          return fresh(hit.at, now) ? hit.text : null;
        }
      }
      return null;
    },
  };
}
