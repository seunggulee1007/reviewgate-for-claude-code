/**
 * MARK: wave4b w4b-auto
 * docs/PROTOCOL.md §39.5 in Electron (as on the Mac, AutoMode.swift / AppState+AutoMode.swift) — pure, unit-tested: auto
 * mode leaves commands to Claude Code's own judgment (its classifier) while file changes are still reviewed; what it blocked
 * is a gray chat row, an auto mode the CLI cannot run says why, a mode picked while Claude works applies from its next step
 * (plan mode, into or out of it, when the turn ends).
 */
import type { PermissionMode } from "@reviewgate/engine";
import { t } from "./i18n";

/** The §39.5 notice codes: chat rows only (gray, no banner, never a stopped queue). */
export const AUTO_MODE_ROW_CODES: ReadonlySet<string> = new Set(["auto_mode_denied", "auto_mode_unavailable"]);

export function isAutoModeRow(code: string | undefined): boolean {
  return code !== undefined && AUTO_MODE_ROW_CODES.has(code);
}

/** The one-line description of auto mode (the mode menu, the HUD chip, Settings). */
export function autoModeHelp(): string {
  return t("Commands run on Claude Code's own judgment. File changes are still reviewed.");
}

/** The row text of a §39.5 code; null for any other code (errorCodes.ts falls back to its own). */
export function autoModeErrorText(ev: { code?: string; message: string; detail?: string }): string | null {
  switch (ev.code) {
    case "auto_mode_denied": {
      const what = (ev.detail ?? "").trim();
      return what ? t("Auto mode blocked: {0}", what) : t("Auto mode blocked a call");
    }
    case "auto_mode_unavailable":
      return t("Auto mode is not available for this model (or is turned off), so Claude Code asks before commands");
    default:
      return null;
  }
}

/** `set_permission_mode auto` refused because the CLI cannot run auto mode for the model. */
export function autoModeRefusalText(): string {
  return t("Auto mode is not available for this model. Pick another model or mode.");
}

/** The menu / HUD line while a picked mode waits for the turn to end. */
export function scheduledModeText(label: string): string {
  return t("From the next turn: {0}", label);
}

export function scheduledModeHelp(): string {
  return t("Claude is working — the mode changes when this turn ends");
}

/** The menu's last line while Claude works (§39.5): a pick applies from Claude's next step — unless plan mode is involved (`switchesNow` false). */
export function busyModeHelp(switchesNow: boolean): string {
  return switchesNow ? t("Claude is working — a new mode applies from its next step (plan mode: when this turn ends)") : scheduledModeHelp();
}

/**
 * What a pick from the mode menu does: switch now (`send`) when the engine takes it (`busy` false: idle, or §39.5 a switch
 * among default / acceptEdits / auto during a turn), else wait for the turn to end (`scheduled`; picking the mode the
 * session already runs drops the waiting one). Nothing without an open session.
 */
export function pickMode(
  picked: PermissionMode,
  s: { open: boolean; busy: boolean; current: PermissionMode },
): { send: PermissionMode | null; scheduled: PermissionMode | null } {
  if (!s.open) return { send: null, scheduled: null };
  if (!s.busy) return { send: picked === s.current ? null : picked, scheduled: null };
  return { send: null, scheduled: picked === s.current ? null : picked };
}

/**
 * After a state snapshot: the waiting mode to send now (the session is idle again), or `drop` (the session closed / another
 * project), or nothing yet.
 */
export function dueScheduledMode(
  scheduled: PermissionMode | null,
  s: { open: boolean; busy: boolean; current: PermissionMode; projectChanged: boolean },
): { send: PermissionMode | null; keep: boolean } {
  if (scheduled === null) return { send: null, keep: false };
  if (!s.open || s.projectChanged) return { send: null, keep: false };
  if (s.busy) return { send: null, keep: true };
  return { send: scheduled === s.current ? null : scheduled, keep: false };
}
