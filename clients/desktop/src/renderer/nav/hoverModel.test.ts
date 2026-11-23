// §65.8 on Windows — the hover's timing: 600 ms resting on one name asks once; moving on restarts it; a stale reply is dropped.
import { describe, expect, it } from "vitest";
import { HOVER_DELAY_MS, HoverDebounce } from "./hoverModel";

/** A clock the test moves by hand. */
function clock() {
  let now = 0;
  let timers: { at: number; f: () => void; id: number }[] = [];
  let next = 1;
  return {
    timers: { set: (f: () => void, ms: number) => (timers.push({ at: now + ms, f, id: next }), next++), clear: (id: unknown) => (timers = timers.filter((t) => t.id !== id)) },
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.f();
    },
    pending: () => timers.length,
  };
}

describe("hover debounce (§65.8)", () => {
  it("asks once after the pointer rested 600 ms on the same name — moving within it changes nothing", () => {
    const c = clock();
    const fired: [string, number][] = [];
    const h = new HoverDebounce<string>((p, seq) => fired.push([p, seq]), HOVER_DELAY_MS, c.timers);
    h.move("A.java|3|5|total", "total");
    c.advance(400);
    h.move("A.java|3|5|total", "total"); // the same name: the wait goes on
    c.advance(199);
    expect(fired).toEqual([]);
    c.advance(1);
    expect(fired).toEqual([["total", 1]]);
    expect(h.current(1)).toBe(true);
    c.advance(5000);
    expect(fired).toHaveLength(1);
  });

  it("another name restarts the wait; the first never asks, and the shown hover is to go", () => {
    const c = clock();
    const fired: string[] = [];
    const h = new HoverDebounce<string>((p) => fired.push(p), HOVER_DELAY_MS, c.timers);
    expect(h.move("a", "a")).toBe(false);
    c.advance(500);
    h.move("b", "b");
    c.advance(500);
    expect(fired).toEqual([]);
    c.advance(100);
    expect(fired).toEqual(["b"]);
    expect(h.move("c", "c")).toBe(true); // b's card goes
    expect(h.move(null)).toBe(false); // nothing shown yet for c
    c.advance(1000);
    expect(fired).toEqual(["b"]);
  });

  it("drops a reply that comes after the pointer moved on or Ctrl was let go", () => {
    const c = clock();
    const seqs: number[] = [];
    const h = new HoverDebounce<string>((_p, seq) => seqs.push(seq), HOVER_DELAY_MS, c.timers);
    h.move("a", "a");
    c.advance(600);
    const first = seqs[0]!;
    h.move("b", "b");
    expect(h.current(first)).toBe(false);
    c.advance(600);
    const second = seqs[1]!;
    expect(h.current(second)).toBe(true);
    h.reset();
    expect(h.current(second)).toBe(false);
    expect(c.pending()).toBe(0);
  });
});
