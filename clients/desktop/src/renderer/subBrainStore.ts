/**
 * MARK: wave5 w5-brain — docs/PROTOCOL.md §43.2: the board's sub-brain tab state (zustand): the engine's `brain` snapshots
 * while the tab is shown (`brain {watch: true}` on open, `watch: false` when it closes), the selected memory's text
 * (`brain_read`), the kinds the graph leaves out. An engine before §43.2 refuses `brain` `unknown_command`: the tab says so.
 * Same states as the Mac (Core `SubBrainStore`). Nothing here asks the engine to write a memory.
 */
import { create } from "zustand";
import type { BrainEvent, BrainMemoryEvent, BrainMemoryType, EngineCommand, ReplyFor } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { HUB_ID } from "./subBrain";

type Request = <C extends EngineCommand>(cmd: C) => Promise<ReplyFor<C>>;

export type SubBrainState = {
  snapshot: BrainEvent | null;
  /** The engine does not know `brain` (an older engine). */
  unsupported: boolean;
  loading: boolean;
  error: string | null;
  selected: string | null;
  text: BrainMemoryEvent | null;
  textError: string | null;
  hidden: BrainMemoryType[];
  start(): Promise<void>;
  stop(): Promise<void>;
  /** A snapshot (a reply, or a watched folder's change). */
  apply(snap: BrainEvent): void;
  select(name: string | null): Promise<void>;
  toggle(type: BrainMemoryType): void;
  reset(): void;
  /** Test seam: answers the requests instead of the engine. */
  setRequest(fn: Request | null): void;
};

let request: Request = (cmd) => engineRequest(cmd);

export const useSubBrain = create<SubBrainState>((set, get) => ({
  snapshot: null,
  unsupported: false,
  loading: false,
  error: null,
  selected: null,
  text: null,
  textError: null,
  hidden: [],

  async start() {
    set({ loading: true });
    try {
      const snap = await request({ type: "brain", watch: true });
      get().apply(snap);
      set({ error: null });
    } catch (e) {
      const r = refusalOf(e);
      if (r.code === "unknown_command") set({ unsupported: true });
      else set({ error: r.error });
    } finally {
      set({ loading: false });
    }
  },

  async stop() {
    if (get().unsupported) return;
    await request({ type: "brain", watch: false }).catch(() => undefined);
  },

  apply(snap) {
    const s = get();
    const patch: Partial<SubBrainState> = { snapshot: snap, unsupported: false };
    if (s.snapshot && s.snapshot.dir !== snap.dir) Object.assign(patch, { selected: null, text: null, textError: null });
    else if (s.selected && s.selected !== HUB_ID && !snap.memories.some((m) => m.name === s.selected)) Object.assign(patch, { selected: null, text: null });
    set(patch);
  },

  async select(name) {
    set({ selected: name, text: null, textError: null });
    if (!name || name === HUB_ID) return;
    try {
      const text = await request({ type: "brain_read", name });
      if (get().selected === name) set({ text });
    } catch (e) {
      if (get().selected === name) set({ textError: refusalOf(e).error });
    }
  },

  toggle(type) {
    const hidden = get().hidden;
    set({ hidden: hidden.includes(type) ? hidden.filter((t) => t !== type) : [...hidden, type] });
  },

  reset() {
    set({ snapshot: null, selected: null, text: null, textError: null, error: null });
  },

  setRequest(fn) {
    request = fn ?? ((cmd) => engineRequest(cmd));
  },
}));
