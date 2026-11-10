/**
 * MARK: polish p-lifecycle — P1-chrome-08 / P5-sheets-45 / P5-sheets-49: the project's own pages the Help menu and the
 * update check use (its public GitHub repository — the Mac's `AppUpdate.repository`).
 */
export const REPOSITORY = "seunggulee1007/reviewgate-for-claude-code";
const BASE = `https://github.com/${REPOSITORY}`;

/** Help › ReviewGate Help (the README in the UI language), Release Notes and Report an Issue…. */
export function helpLinks(language: string): { help: string; releases: string; newIssue: string } {
  return {
    help: language === "ko" ? `${BASE}/blob/main/README.ko.md` : `${BASE}#readme`,
    releases: `${BASE}/releases`,
    newIssue: `${BASE}/issues/new`,
  };
}
