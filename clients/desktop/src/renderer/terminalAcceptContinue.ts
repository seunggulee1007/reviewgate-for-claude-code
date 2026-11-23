/**
 * §58 / §57.17: "Accept N & Continue" in a terminal chat — the Mac's rule (Core TerminalFriction.swift). The user's click
 * accepts the pending files (`accept_all`, its reply awaited), then `Continue.` goes into Claude Code as one bracketed
 * paste and Enter follows as its own write — the only Enter the app types, and only on that click. The engine adopts the
 * prompt as any: the review summary ("[Review gate] Accepted: …") reaches Claude as its additionalContext.
 */
import type { ReviewState } from "@reviewgate/engine";
import { t } from "./i18n";

/** What the click sends (Claude's words, never translated — the Mac's `AcceptContinueRules.message`). */
export const CONTINUE_MESSAGE = "Continue.";
/** Enter follows the paste after this long, so the TUI reads it as the key and not as part of the paste. */
export const ENTER_DELAY_MS = 150;

/** The live terminal chat's PTY as the button needs it. */
export type ContinueTarget = {
  /** The live chat is a terminal chat and it is the one on screen (not another chat shown read-only). */
  shown: boolean;
  /** Its PTY runs and the engine that reviews it was not reset. */
  running: boolean;
  /** Claude Code turned bracketed paste on (its prompt shows). */
  bracketed: boolean;
};

/**
 * Why the button is off (null: on). Claude Code must be idle at its prompt — no turn running or adopted, nothing collected
 * or reverted, nothing it waits for in the TUI — with files pending and none sent back for changes.
 */
export function terminalAcceptContinueBlocker(s: Pick<ReviewState, "gate" | "session">, target: ContinueTarget): string | null {
  if (!target.shown) return t("The chat on screen is not a live terminal chat");
  if (s.gate.pendingCount === 0) return t("No file waits for review");
  if (s.gate.changesRequestedCount > 0) return t("Send your change request ({0} file(s)) to continue", s.gate.changesRequestedCount);
  const info = s.session.terminal ?? null;
  if (s.gate.phase === "running" || info?.promptId) return t("Claude Code is still working — this is offered once the turn ends");
  if (info?.waiting) return t("Claude Code waits for you in the terminal — answer it there first");
  if (s.gate.phase === "collecting") return t("Collecting changes…");
  if (!s.gate.canSend) return t("Claude Code is still working — this is offered once the turn ends");
  if (!target.running) return t("Claude Code is not running in this terminal — restart it first");
  if (!target.bracketed) return t("Claude Code is not ready for a paste yet — try again once its prompt shows");
  return null;
}

/**
 * The click, once `terminalAcceptContinueBlocker` said yes: accept, then paste and Enter. Returns why it stopped (null:
 * Claude continues). Nothing is typed when the accept was refused or the paste could not go.
 */
export async function runTerminalAcceptContinue(d: {
  accept(): Promise<void>;
  paste(text: string): boolean;
  enter(): void;
  refusal(err: unknown): string;
  wait?(ms: number): Promise<void>;
}): Promise<string | null> {
  try {
    await d.accept();
  } catch (err) {
    return d.refusal(err);
  }
  if (!d.paste(CONTINUE_MESSAGE)) return t("Claude Code is not ready for a paste yet — try again once its prompt shows");
  await (d.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(ENTER_DELAY_MS);
  d.enter();
  return null;
}
