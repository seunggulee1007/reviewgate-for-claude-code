/**
 * MARK: wave4 w4-safety — pure rules of "safety while Claude works", the Mac's Core rules with the same keys:
 * - daily-11: the reject shortcut (⌘⇧R / Ctrl+Shift+R) asks first, one line on what happens to the file (RejectConfirm.swift);
 * - daily-14: a turn that stopped on a usage limit, a login, an API error or a crash says so in its notification
 *   (TurnStopReason.swift) — add a reason by adding a kind, its code in `stopFromError` and a rank;
 * - robustness-07: "Force restart" when a stop did not end the turn in 10 s (AppState+Safety.swift);
 * - polish-12: the composer draft is kept per chat, not per window (AppState+Safety.swift `ChatDraft`).
 */
import type { EngineEvent } from "@reviewgate/engine";
import { errorEventText, resetTimeText, type ErrorInfo } from "./errorCodes";
import { t } from "./i18n";

// ---------------------------------------------------------------- daily-11

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** What rejecting `file` does to it, in one line. */
export function rejectConfirmMessage(file: { path: string; oldPath?: string | null; status: string }): string {
  const name = baseName(file.path);
  switch (file.status) {
    case "A":
      return t("{0} was created in this turn — it will be deleted.", name);
    case "D":
      return t("{0} will be restored as it was before this turn.", name);
    case "R":
      return t("{0} goes back to {1} as it was before this turn.", name, baseName(file.oldPath ?? file.path));
    default:
      return t("{0} goes back to how it was before this turn.", name);
  }
}

// ---------------------------------------------------------------- daily-14

/** The one list of stop reasons (as the Mac's TurnStopReason.swift) — §38.2's tool-call limit (`max_turns`) included. */
export type TurnStopKind = "usageLimit" | "rateLimited" | "loginRequired" | "apiError" | "crashed" | "maxTurns";
export type TurnStop = {
  kind: TurnStopKind;
  /** The notification's line: "사용량 한도로 멈췄어요 — 15:00에 풀려요". */
  text: string;
  /** Posted on its own already (a fatal error): the turn's end adds no second notification. */
  alreadyNotified: boolean;
};

const RANK: Record<TurnStopKind, number> = { loginRequired: 6, usageLimit: 5, crashed: 4, maxTurns: 3, rateLimited: 2, apiError: 1 };

type StopError = ErrorInfo & { fatal: boolean };

/** The reason an `error` event gives a running turn; null for codes that do not stop it. */
export function stopFromError(ev: StopError, opts: { now?: Date; timeZone?: string } = {}): TurnStop | null {
  const at = ev.resetAt ? resetTimeText(ev.resetAt, opts) : null;
  const make = (kind: TurnStopKind, text: string): TurnStop => ({ kind, text, alreadyNotified: ev.fatal });
  switch (ev.code) {
    case "usage_limit":
      return make("usageLimit", at ? t("Stopped at the usage limit — it resets at {0}", at) : t("Stopped at the usage limit"));
    case "rate_limited":
      return make("rateLimited", at ? t("Stopped by the API rate limit — try again after {0}", at) : t("Stopped by the API rate limit"));
    case "auth_required":
      return make("loginRequired", t("Login required"));
    case "api_error":
      return make("apiError", t("Stopped by an error: {0}", errorEventText(ev, opts)));
    case "session_crashed":
      return make("crashed", t("Claude Code quit unexpectedly"));
    case "max_turns": // §38.2: the tool-call limit of one message ([이어서 계속] on the banner goes on)
      return make("maxTurns", t("Stopped at the tool-call limit"));
    default:
      return null;
  }
}

/** Keeps the stronger of two reasons; equal ranks keep the first. */
export function mergeStop(current: TurnStop | null, next: TurnStop | null): TurnStop | null {
  if (!next) return current;
  if (!current) return next;
  return RANK[next.kind] > RANK[current.kind] ? next : current;
}

/** Codes whose own notification waits for the turn's end (non-fatal ones; a fatal error is posted at once). */
export function defersNotification(ev: { code?: string; fatal: boolean }): boolean {
  return !ev.fatal && ev.code !== undefined && ["usage_limit", "rate_limited", "auth_required", "api_error", "max_turns"].includes(ev.code);
}

/**
 * Follows one window's events: the stop reason of the running turn (from its `error` events) is handed to that turn's
 * `turn_end` notification. `observe` returns what the notification of this event should do.
 */
export class TurnStopTracker {
  private stop: TurnStop | null = null;

  observe(ev: EngineEvent, running: boolean): { stop: TurnStop | null; suppress: boolean } {
    if (ev.type === "error") {
      if (!running) return { stop: null, suppress: false };
      const reason = stopFromError(ev);
      if (!reason) return { stop: null, suppress: false };
      this.stop = mergeStop(this.stop, reason);
      return { stop: null, suppress: defersNotification(ev) };
    }
    if (ev.type === "turn_end") {
      // §38.2: a turn that ended at the tool-call limit says so even when its notice came while no turn was seen running.
      const stop = this.stop ?? (ev.stopReason === "error_max_turns" ? { kind: "maxTurns" as const, text: t("Stopped at the tool-call limit"), alreadyNotified: false } : null);
      this.stop = null;
      return { stop, suppress: stop?.alreadyNotified === true };
    }
    return { stop: null, suppress: false };
  }

  reset(): void {
    this.stop = null;
  }
}

// ---------------------------------------------------------------- robustness-07

/** How long a turn may keep running after "Stop" before "Force restart" is offered. */
export const STUCK_INTERRUPT_MS = 10_000;

// ---------------------------------------------------------------- polish-12

/** The storage key of a draft (sessionKeep's localStorage): per project and, with an engine that has chats (`state.sessions`), per chat. */
export function chatDraftKey(projectHash: string | null, chatId: string | null | undefined): string | null {
  if (!projectHash) return null;
  return chatId ? `${projectHash}:${chatId}` : projectHash;
}

/**
 * The composer's text after its draft key changed: another chat (or project) shows its own draft; the first time the
 * chat becomes known (key `project` → `project:chat`) what is typed stays.
 */
export function draftAfterKeyChange(previousKey: string | null, nextKey: string | null, current: string, kept: string): string {
  return isFirstIdentification(previousKey, nextKey) || previousKey === null ? (current.length === 0 ? kept : current) : kept;
}

/** The key went from the project alone to the project's chat (the chat id arrived after the composer mounted). */
export function isFirstIdentification(previousKey: string | null, nextKey: string | null): boolean {
  return previousKey !== null && nextKey !== null && !previousKey.includes(":") && nextKey.startsWith(previousKey + ":");
}

/** The chips (mentions, images) of chats not on screen, by draft key — this window only (the draft itself is kept in localStorage). */
const chipStash = new Map<string, unknown>();

/** Keeps `chips` for draft key `key` (nothing to keep forgets it). */
export function stashChips<T extends { mentions: unknown[]; images: unknown[] }>(key: string | null, chips: T): void {
  if (!key) return;
  if (chips.mentions.length === 0 && chips.images.length === 0) chipStash.delete(key);
  else chipStash.set(key, chips);
}

/** The chips kept for `key` (taken), or null. */
export function takeChips<T>(key: string | null): T | null {
  if (!key) return null;
  const chips = chipStash.get(key) as T | undefined;
  chipStash.delete(key);
  return chips ?? null;
}
