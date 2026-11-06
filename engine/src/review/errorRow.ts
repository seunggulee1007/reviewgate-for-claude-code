import type { ErrorDetails, ErrorRowDetails, ErrorScope, TranscriptItem } from "../protocol.js";

// MARK: wave2 check-engine (docs/PROTOCOL.md §35.3)

/** A `kind: "error"` transcript row before the store stamps `at` / `turn`. */
export type ErrorRow = Omit<Extract<TranscriptItem, { kind: "error" }>, "at" | "turn">;

/** The details a row keeps besides `code` / `detail`: what the clients' banners read (§33.4, §30, the API errors). */
const ROW_DETAILS = ["toolName", "path", "branch", "exitCode", "signal", "sessionId", "resetAt", "status", "files"] as const satisfies readonly (keyof ErrorRowDetails)[];
/** MARK: wave4 w4-longwork — §38.2 details a row keeps as well. */
const LONG_WORK_ROW_DETAILS = ["maxTurns", "hookName"] as const satisfies readonly (keyof ErrorDetails)[];

/**
 * The row of an `error` event the user saw (§30): its text, `fatal` / `scope`, `code` / `detail` when set, and of the
 * other details those of `ErrorRowDetails` the event carried — a `null` exit code / signal / status included, nothing
 * it did not carry — so the banner restored after a restart reads like the live one (the §33.4 tool / folder / branch,
 * how the CLI ended, the chat a resume notice is about, when a usage limit resets, the HTTP status).
 */
export function errorRow(message: string, fatal: boolean, scope: ErrorScope, extra: ErrorDetails): ErrorRow {
  const row: ErrorRow = { kind: "error", message, fatal, scope, ...(extra.code ? { code: extra.code } : {}), ...(extra.detail ? { detail: extra.detail } : {}) };
  const out = row as Record<string, unknown>;
  for (const key of ROW_DETAILS) {
    if (extra[key] !== undefined) out[key] = extra[key];
  }
  // MARK: wave4 w4-longwork — §38.2: the limit a `max_turns` row names, the hook of a `hook_failed` row.
  for (const key of LONG_WORK_ROW_DETAILS) {
    if (extra[key] !== undefined) out[key] = extra[key];
  }
  return row;
}
