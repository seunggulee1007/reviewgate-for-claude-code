/**
 * A one-line toast at the bottom of the window ("지금은 거절할 수 없어요 — …"): short-lived feedback for a key or click
 * that could not do anything right now. One at a time; a new one replaces the shown one and restarts its timer.
 */
import { create } from "zustand";

export const TOAST_MS = 2600;

type ToastState = {
  text: string | null;
  /** Bumped by every `show` (the same text again restarts the timer and the fade-in). */
  seq: number;
  show(text: string): void;
  hide(): void;
};

let timer: ReturnType<typeof setTimeout> | null = null;

export const useToast = create<ToastState>((set) => ({
  text: null,
  seq: 0,
  show(text) {
    if (timer) clearTimeout(timer);
    set((s) => ({ text, seq: s.seq + 1 }));
    timer = setTimeout(() => {
      timer = null;
      set({ text: null });
    }, TOAST_MS);
  },
  hide() {
    if (timer) clearTimeout(timer);
    timer = null;
    set({ text: null });
  },
}));

/** Shows `text` as the toast (outside React too). */
export const showToast = (text: string): void => useToast.getState().show(text);

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
