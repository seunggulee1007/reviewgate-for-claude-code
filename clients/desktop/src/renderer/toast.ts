/**
 * A one-line toast at the bottom of the window ("지금은 거절할 수 없어요 — …"): short-lived feedback for a key or click
 * that could not do anything right now. One at a time; a new one replaces the shown one and restarts its timer.
 *
 * MARK: polish p-foundation (P4-composer-09): a toast may carry one action — "대기열에서 2개를 지웠어요 · [실행 취소]":
 *
 *   showToast(t("Removed {0} from the queue", n), { action: { label: t("Undo"), run: restore } });
 *
 * It then stays longer (`TOAST_ACTION_MS`); its button is the one part that takes the pointer, and the action runs once.
 */
import { create } from "zustand";

export const TOAST_MS = 2600;
/** A toast with an action stays this long — time to reach its button. */
export const TOAST_ACTION_MS = 6000;

export type ToastAction = { label: string; run: () => void };
export type ToastOptions = { action?: ToastAction };

type ToastState = {
  text: string | null;
  action: ToastAction | null;
  /** Bumped by every `show` (the same text again restarts the timer and the fade-in). */
  seq: number;
  show(text: string, options?: ToastOptions): void;
  hide(): void;
  /** Closes the toast and runs its action (once). */
  runAction(): void;
};

let timer: ReturnType<typeof setTimeout> | null = null;

export const useToast = create<ToastState>((set, get) => ({
  text: null,
  action: null,
  seq: 0,
  show(text, options) {
    if (timer) clearTimeout(timer);
    const action = options?.action ?? null;
    set((s) => ({ text, action, seq: s.seq + 1 }));
    timer = setTimeout(
      () => {
        timer = null;
        set({ text: null, action: null });
      },
      action ? TOAST_ACTION_MS : TOAST_MS,
    );
  },
  hide() {
    if (timer) clearTimeout(timer);
    timer = null;
    set({ text: null, action: null });
  },
  runAction() {
    const action = get().action;
    get().hide();
    action?.run();
  },
}));

/** Shows `text` as the toast (outside React too); `options.action` gives it one button. */
export const showToast = (text: string, options?: ToastOptions): void => useToast.getState().show(text, options);

// MARK: wave2 check-clients
/**
 * Where the toast floats: 12px above the bottom of the chat transcript (so above the HUD strip, the cards and the
 * composer — never over the composer's hint row or buttons), centred on the chat column and no wider than it.
 * `transcript`: its bounding box; null (no transcript on screen: the PR tab, no project) → the stylesheet's place, the
 * window's bottom centre.
 */
export function toastPlacement(transcript: { left: number; width: number; bottom: number } | null, viewportHeight: number): { left: number; bottom: number; maxWidth: number } | null {
  if (!transcript || transcript.width <= 0 || transcript.bottom <= 0) return null;
  return { left: transcript.left + transcript.width / 2, bottom: Math.max(0, viewportHeight - transcript.bottom) + 12, maxWidth: Math.max(160, Math.min(560, transcript.width - 24)) };
}

/** MARK: polish p-foundation — `text` with its middle replaced by "…" past `limit` characters ("복사됨: src/…/Svc.java"). */
export function middleTruncate(text: string, limit: number): string {
  const chars = Array.from(text);
  if (chars.length <= limit || limit < 2) return text;
  const head = Math.floor((limit - 1) / 2);
  const tail = limit - 1 - head;
  return chars.slice(0, head).join("") + "…" + chars.slice(chars.length - tail).join("");
}
