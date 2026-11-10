/**
 * MARK: wave3 desktop-flow
 * What the daily-flow screens hand from one window to another through main (pure, no `electron`; unit-tested):
 * §36.12 a new workbench's failed setup report — the window that ran `workbench_create` passes it with
 * `rg:openWorkbenchWindow`, the new window takes it once its project is open (`rg:takeWorkbenchSetupReport`) and shows the
 * exit and the log; §36.14 "Send to Claude" puts PR comments into the composer of the PR head's workbench window
 * (`rg:composeInWindow` → that window's `rg:menu` `composer_draft`). Nothing is ever sent to Claude from here.
 */
import { resolve } from "node:path";
import { isWorkbenchSetupReport, type WorkbenchSetupReport } from "../shared/flowSettings.js";

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
