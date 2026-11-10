/**
 * MARK: wave4b w4b-auto
 * Store slice for docs/PROTOCOL.md §39.5 (as on the Mac, AppState+AutoMode.swift): a mode picked from the menu or the HUD
 * chip switches now — while Claude works too, from its next step — except plan mode during a turn (into or out of it) and
 * anything while the turn's changes are collected: those wait for the turn's end, as does a switch the engine refused
 * `session_busy`. A refused switch (auto mode the model cannot run) keeps the banner `setPermissionMode` already shows.
 * MARK: wave6 w6-terminal — §44.1: Shift+Tab in the composer cycles the mode like the terminal (`cyclePermissionMode`),
 * skipping auto where the engine said it cannot run (`autoModeUnavailable`).
 * Spread into `useStore` (store.ts).
 */
import type { StateCreator } from "zustand";
import type { PermissionMode, ReviewState } from "@reviewgate/engine";
import { dueScheduledMode, pickMode } from "./autoMode";
import type { Store } from "./store";
import { autoModeMayRunAgain, nextPermissionMode } from "./terminalMode";

export type AutoModeSlice = {
  /** The mode picked while the engine takes no switch (plan mode during a turn, a collection); sent when the turn ends (null: none waiting). */
  scheduledPermissionMode: PermissionMode | null;
  /** The mode menu / HUD chip: switch now when the engine takes it (`modeSwitchesNow`), else wait for the turn's end. */
  pickPermissionMode(mode: PermissionMode): void;
  /** After every snapshot: send the waiting mode once idle; drop it when the session closed or the project changed. */
  stepScheduledMode(previous: ReviewState, snapshot: ReviewState): void;
  // MARK: wave6 w6-terminal — §44.1
  /** The engine said auto mode cannot run here (`auto_mode_unavailable`); cleared by another project / model or auto taken. */
  autoModeUnavailable: boolean;
  noteAutoModeUnavailable(): void;
  /** The mode the last `set_permission_mode` asked for, until it is answered (what the next pick goes on from, as the Mac's). */
  requestedPermissionMode: PermissionMode | null;
  /** Shift+Tab in the composer: the terminal's next mode, from the one waiting for the turn's end (or on its way) if any. */
  cyclePermissionMode(): void;
};

/** A session starts, a turn runs or its changes are collected / reverted: not every switch goes out now (`modeSwitchesNow`). */
export function modeBusy(s: ReviewState): boolean {
  return s.session.starting === true || s.gate.phase === "starting" || s.gate.phase === "running" || s.gate.phase === "collecting" || s.gate.phase === "reverting";
}

/**
 * §39.5: the engine takes a switch from `current` to `mode` now — idle, or while a turn runs one that neither enters nor
 * leaves plan mode (the CLI applies it from its next tool call). Never while a session starts or a turn's changes are
 * collected / reverted (`session_busy`).
 */
export function modeSwitchesNow(s: ReviewState, mode: PermissionMode, current: PermissionMode): boolean {
  if (!modeBusy(s)) return true;
  if (s.session.starting === true || s.gate.phase !== "running") return false;
  return mode !== "plan" && current !== "plan";
}

const modeOf = (s: ReviewState): PermissionMode => s.session.permissionMode ?? "default";

export const createAutoModeSlice: StateCreator<Store, [], [], AutoModeSlice> = (set, get) => {
  /** The latest switch on its way: only its answer clears `requestedPermissionMode`. */
  let sent = 0;
  /**
   * Switches now (forced: a switch still on its way may differ from the snapshot's mode); while it is on its way the next
   * pick goes on from it. Auto taken clears `autoModeUnavailable` (a refusal sets it in the store's `planCommand`). Refused
   * `session_busy` (the turn's changes began to be collected meanwhile): no banner — the pick waits for the turn's end.
   */
  const send = (mode: PermissionMode): void => {
    const mine = ++sent;
    set({ requestedPermissionMode: mode });
    void get().setPermissionMode(mode, { force: true, busyWaits: true }).then((refusal) => {
      if (mine === sent) set({ requestedPermissionMode: null });
      if (refusal?.startsWith("auto_mode_unavailable")) set({ autoModeUnavailable: true });
      else if (refusal === null && mode === "auto") set({ autoModeUnavailable: false });
      if (refusal?.startsWith("session_busy") && get().scheduledPermissionMode === null) set({ scheduledPermissionMode: mode });
    });
  };
  /** The mode a pick goes on from: the one on its way, else the engine's. */
  const currentOf = (s: ReviewState): PermissionMode => get().requestedPermissionMode ?? modeOf(s);
  return {
    scheduledPermissionMode: null,
    autoModeUnavailable: false,
    requestedPermissionMode: null,

    pickPermissionMode(mode) {
      const s = get().state;
      const current = currentOf(s);
      const r = pickMode(mode, { open: s.session.open, busy: !modeSwitchesNow(s, mode, current), current });
      set({ scheduledPermissionMode: r.scheduled });
      if (r.send) send(r.send);
    },

    stepScheduledMode(previous, snapshot) {
      if (get().autoModeUnavailable && autoModeMayRunAgain(previous, snapshot)) set({ autoModeUnavailable: false });
      const scheduled = get().scheduledPermissionMode;
      if (scheduled === null) return;
      const projectChanged = previous.project?.root !== undefined && snapshot.project?.root !== previous.project?.root;
      const r = dueScheduledMode(scheduled, { open: snapshot.session.open, busy: modeBusy(snapshot), current: currentOf(snapshot), projectChanged });
      if (!r.keep) set({ scheduledPermissionMode: null });
      if (r.send) send(r.send);
    },

    noteAutoModeUnavailable() {
      set({ autoModeUnavailable: true });
    },

    cyclePermissionMode() {
      const s = get().state;
      if (!s.session.open) return;
      const from = get().scheduledPermissionMode ?? currentOf(s);
      get().pickPermissionMode(nextPermissionMode(from, !get().autoModeUnavailable));
    },
  };
};
