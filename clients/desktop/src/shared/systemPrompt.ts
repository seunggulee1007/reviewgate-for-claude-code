/**
 * docs/PROTOCOL.md §54: the append Claude gets unless the user wrote their own — the same text as the Mac's
 * `AppSettings.defaultSystemPromptAppend`. Pure (no `electron`): main renders it for the engine, the renderer shows it as the
 * empty box's placeholder in Settings.
 */

/**
 * Nothing about small units, stopping or waiting: Claude works through a task as in the terminal. MARK: r1-git (§46): no card
 * promise for git either — only what throws work away or rewrites the remote asks (the engine's own git instruction says so).
 */
export const DEFAULT_SYSTEM_PROMPT_APPEND =
  "You are working inside a review gate. Run git commands that change the repository (commit, merge, pull, checkout, reset, stash, …) " +
  "only when the user or a skill they ran asks.";

/** What the default append adds while the change limit is on; `{maxFiles}` / `{maxLines}` are substituted. */
export const BUDGET_PROMPT_SENTENCE =
  "The user set a change limit of {maxFiles} files and about {maxLines} changed lines per reply: plan each reply to fit it. " +
  "If an edit is denied with 'REVIEW GATE', report what you changed and what remains.";

/** The built-in appends of earlier versions: the settings file kept a copy of every default, so most users have one stored. */
const LEGACY_SYSTEM_PROMPT_APPENDS = new Set([
  // r1-git: §54's first built-in append
  "You are working inside a review gate. Run git commands that change the repository (commit, merge, pull, checkout, reset, stash, …) " +
    "only when the user asks — the app shows the user an approval card for each.",
  "You are working inside a review gate. Work in small units: at most {maxFiles} files and about {maxLines} changed lines per reply. " +
    "After finishing one unit, STOP and report what you changed and what the next unit would be; wait for the user. " +
    "Run git commands that change the repository (commit, merge, pull, checkout, reset, stash, …) only when the user asks — " +
    "the app shows the user an approval card for each. If an edit is denied with 'REVIEW GATE', stop immediately and report.",
  "You are working inside a review gate. Work in small units: at most {maxFiles} files and about {maxLines} changed lines per reply. " +
    "After finishing one unit, STOP and report what you changed and what the next unit would be; wait for the user. " +
    "Never run git commit/checkout/reset/stash/clean — the app manages git. If an edit is denied with 'REVIEW GATE', stop immediately and report.",
]);

/** A stored copy of an earlier built-in append (surrounding whitespace aside): it counts as the default. */
export function isLegacySystemPromptAppend(text: unknown): boolean {
  return typeof text === "string" && LEGACY_SYSTEM_PROMPT_APPENDS.has(text.trim());
}

export function renderSystemPrompt(template: string, budget: { maxFiles: number; maxLines: number }): string {
  return template.replaceAll("{maxFiles}", String(budget.maxFiles)).replaceAll("{maxLines}", String(budget.maxLines));
}
