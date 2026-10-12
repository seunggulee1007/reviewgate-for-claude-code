/**
 * MARK: wave4 w4-longwork
 * Store slice for docs/PROTOCOL.md §38.2 (as on the Mac, AppState+LongWork.swift): [이어서 계속] after the tool-call
 * limit, the last usage limit's reset and "풀리면 이어서 하기" — opt-in, once, by the queue rules; a turn that is not its own
 * (the user sent something), a new limit without a reset time or closing the window (state in memory only) disarms it.
 * Spread into `useStore` (store.ts).
 */
import type { StateCreator } from "zustand";
import type { ErrorEvent } from "@reviewgate/engine";
import { activeLimitReset, continueMessage, leftChat, limitResumeStep, NO_LIMIT_RESUME, RESUME_DELAY_MS, type LimitResumeState } from "./longWork";
import type { Store } from "./store";

export type LongWorkSlice = {
  limitResume: LimitResumeState;
  /** [이어서 계속]: "계속해" to this chat — now when the session takes a message, else queued. */
  continueWork(): void;
  /** "풀리면 이어서 하기" on (needs a known reset) / off. */
  armLimitResume(): void;
  cancelLimitResume(): void;
  /** Every `error` event: a usage limit's reset (a new one without a time disarms). */
  noteLongWorkError(ev: ErrorEvent): void;
  /** After every snapshot (and the timer): fire once idle past the reset, or give up when another turn started. */
  stepLimitResume(now?: number): void;
};

export const createLongWorkSlice: StateCreator<Store, [], [], LongWorkSlice> = (set, get) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = (resetAt: number) => {
    clearTimer();
    // setTimeout caps at ~24.8 days; a usage window is at most a week.
    const delay = Math.min(Math.max(0, resetAt + RESUME_DELAY_MS - Date.now()), 2_000_000_000);
    timer = setTimeout(() => {
      timer = null;
      get().stepLimitResume();
    }, delay);
  };
  const running = (s: Store) => s.state.gate.phase === "running" || s.state.gate.phase === "starting" || s.state.session.starting;
  const idle = (s: Store) =>
    s.state.gate.canSend && !s.queue.inflight && (s.state.session.pendingPermissions ?? []).length === 0 && !s.state.session.pendingPermission && !s.state.session.pendingPlan;

  return {
    limitResume: { ...NO_LIMIT_RESUME },

    continueWork() {
      get().enqueueMessage(continueMessage());
    },

    armLimitResume() {
      const s = get();
      const reset = activeLimitReset(s.state.hud.rateLimits, s.limitResume.limitResetAt, Date.now());
      if (reset === null) return;
      set({ limitResume: { limitResetAt: reset, armed: true, idleSinceArmed: !running(s), chatId: s.state.sessions?.currentId ?? null } }); // chatId: wave4b w4b-check4 (§40.1)
      schedule(reset);
    },

    cancelLimitResume() {
      clearTimer();
      set((s) => ({ limitResume: { ...s.limitResume, armed: false, idleSinceArmed: false, chatId: null } }));
    },

    noteLongWorkError(ev) {
      if (ev.code !== "usage_limit") return;
      const reset = ev.resetAt ? Date.parse(ev.resetAt) : Number.NaN;
      if (Number.isFinite(reset)) {
        set((s) => ({ limitResume: { ...s.limitResume, limitResetAt: reset } }));
        if (get().limitResume.armed) schedule(reset);
      } else if (get().limitResume.armed) {
        get().cancelLimitResume();
      }
    },

    stepLimitResume(now = Date.now()) {
      const s = get();
      if (!s.limitResume.armed) return;
      // MARK: wave4b w4b-check4 — §40.1: "계속해" only to the chat that stopped at the limit.
      if (leftChat(s.limitResume.chatId, s.state.sessions?.currentId)) {
        get().cancelLimitResume();
        return;
      }
      const isRunning = running(s);
      switch (limitResumeStep(s.limitResume, { running: isRunning, idle: idle(s), now })) {
        case "wait":
          if (!isRunning && !s.limitResume.idleSinceArmed) set({ limitResume: { ...s.limitResume, idleSinceArmed: true } });
          return;
        case "cancel":
          get().cancelLimitResume();
          return;
        case "fire":
          get().cancelLimitResume();
          // "계속해" ahead of whatever waits; a queue the limit stopped goes on after it.
          get().enqueueMessage(continueMessage(), true);
          if (get().queue.paused) get().resumeQueue();
          return;
      }
    },
  };
};
