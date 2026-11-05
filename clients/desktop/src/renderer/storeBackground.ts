/**
 * Store slice for background work (docs/PROTOCOL.md §52): [중지] (`task_stop`), [출력 보기] (`task_output`), [백그라운드로] /
 * Ctrl+B (`task_background`) and the row of a turn Claude started itself (`auto_turn`). The tasks themselves are
 * `state.session.backgroundTasks`. Spread into `useStore` (store.ts). The decisions are pure (background.ts).
 */
import type { StateCreator } from "zustand";
import type { EngineEvent } from "@reviewgate/engine";
import { autoTurnRowOf, backgroundRefusal, CANNOT_MOVE_TEXT, hasAutoTurnRow, movedOf, taskBackgroundCommand, taskOutputCommand, taskOutputOf, taskStopCommand, type TaskOutput } from "./background";
import { engineRequest } from "./engineRequest";
import type { Store } from "./store";

export type BackgroundSlice = {
  /** [중지] → null, or the refusal in one line. */
  stopBackgroundTask(taskId: string): Promise<string | null>;
  /** [백그라운드로] (`toolUseId`) / Ctrl+B (none) → null when it moved, else why not in one line. */
  moveToBackground(toolUseId?: string): Promise<string | null>;
  /** [출력 보기] / 새로고침 → the output, or the refusal in one line. */
  readTaskOutput(taskId: string): Promise<{ ok: true; output: TaskOutput } | { ok: false; error: string }>;
  /** An `auto_turn` event: its row opens the turn — once per turn. */
  applyAutoTurn(ev: Extract<EngineEvent, { type: "auto_turn" }>): void;
};

/** Row ids of these rows: negative, so they never meet the store's own counter. */
let rowSeq = -1_000_000;

export const createBackgroundSlice: StateCreator<Store, [], [], BackgroundSlice> = (set, get) => ({
  async stopBackgroundTask(taskId) {
    try {
      await engineRequest(taskStopCommand(taskId));
      return null;
    } catch (e) {
      return backgroundRefusal(e);
    }
  },

  async moveToBackground(toolUseId) {
    try {
      const reply = await engineRequest(taskBackgroundCommand(toolUseId));
      return movedOf(reply) ? null : CANNOT_MOVE_TEXT();
    } catch (e) {
      return backgroundRefusal(e);
    }
  },

  async readTaskOutput(taskId) {
    try {
      return { ok: true, output: taskOutputOf(await engineRequest(taskOutputCommand(taskId))) };
    } catch (e) {
      return { ok: false, error: backgroundRefusal(e) };
    }
  },

  applyAutoTurn(ev) {
    if (hasAutoTurnRow(get().transcript, ev.turn)) return;
    const row = autoTurnRowOf(ev, rowSeq--);
    if (!row) return;
    set((s) => {
      const last = s.transcript[s.transcript.length - 1];
      const items = last && last.kind === "assistant" && last.streaming ? [...s.transcript.slice(0, -1), { ...last, streaming: false }] : s.transcript;
      return { transcript: [...items, row] };
    });
  },
});
