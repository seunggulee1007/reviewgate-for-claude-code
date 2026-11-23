/**
 * §65.8 on Windows — the hover preview's timing (pure): Ctrl held over a name for 600 ms asks once; a newer pointer
 * position, or leaving the name, drops the older request's reply.
 */

/** How long the pointer rests on a name with Ctrl held before the hover asks (§65.8). */
export const HOVER_DELAY_MS = 600;

type Timers = { set: (f: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

/**
 * The hover's timing: `move(key, payload)` with the name under the pointer (null: none, or Ctrl released) restarts the
 * wait; after `delay` ms on the same name `fire(payload, seq)` runs. A reply is shown only while `current(seq)` — a newer
 * pointer position, or leaving the name, drops the older one's reply.
 */
export class HoverDebounce<P> {
  private key: string | null = null;
  private handle: unknown = null;
  private seq = 0;
  private fired = 0;

  constructor(
    private readonly fire: (payload: P, seq: number) => void,
    private readonly delay = HOVER_DELAY_MS,
    private readonly timers: Timers = { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
  ) {}

  /** The pointer is over `key` (null: nothing to show). Returns whether the shown hover must go (another name now). */
  move(key: string | null, payload?: P): boolean {
    if (key !== null && key === this.key) return false;
    this.key = key;
    this.cancel();
    const shown = this.fired !== 0;
    this.fired = 0;
    if (key === null || payload === undefined) return shown;
    const seq = ++this.seq;
    this.handle = this.timers.set(() => {
      this.handle = null;
      this.fired = seq;
      this.fire(payload, seq);
    }, this.delay);
    return shown;
  }

  /** Whether a reply to request `seq` is still the one to show. */
  current(seq: number): boolean {
    return seq === this.fired && seq === this.seq;
  }

  /** Stops waiting and drops any reply on its way (Ctrl released, a click, a scroll). */
  reset(): void {
    this.key = null;
    this.fired = 0;
    this.seq++;
    this.cancel();
  }

  private cancel(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }
}
