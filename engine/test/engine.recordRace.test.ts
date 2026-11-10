import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeadMove } from "../src/protocol.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §26 × the queue: a turn's tail (HEAD / settings.local.json / nested checks, then its checkpoint record)
 * runs after `turn_end`, when the gate is already open — a queued message can go out meanwhile. The record the tail closes
 * is the finished turn's own, never the next turn's that the send just opened.
 */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-recrace"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("a send during the previous turn's tail (§26 records)", () => {
  it("the tail closes its own turn's record; the next turn keeps its record and closes it itself", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);

    // Hold turn 1's tail at its HEAD check until turn 2 was sent.
    const internals = h.engine as unknown as { headMove: () => Promise<HeadMove | null> };
    const original = internals.headMove.bind(h.engine);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    const spy = vi.spyOn(internals, "headMove").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await held;
      return original();
    });

    await h.engine.handle({ type: "send", text: "one" });
    write(dir, "a.txt", "a1\n");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "a.txt"), tools: ["Write"], count: 1, toolUseIds: ["w1"] }] });
    // The collection is done and turn_end is out; the tail waits at its HEAD check (a state snapshot may not have
    // followed yet — the engine's own gate is what a send is checked against).
    await h.waitFor(() => calls === 1, "turn 1's tail at its HEAD check");
    expect(h.ofType("turn_end")).toHaveLength(1);

    // The queue's next message goes out while turn 1's tail waits.
    await h.engine.handle({ type: "send", text: "two" });
    await h.waitFor((s) => s.gate.phase === "running", "turn 2 running");
    release();
    await h.waitFor((s) => (s.session.checkpoints ?? []).some((c) => c.turn === 1 && c.endedAt !== null), "turn 1's record closed");

    write(dir, "b.txt", "b2\n");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "b.txt"), tools: ["Write"], count: 1, toolUseIds: ["w2"] }] });
    const s = await h.waitFor((st) => st.gate.phase === "reviewing" && (st.session.checkpoints ?? []).every((c) => c.endedAt !== null), "turn 2 collected and closed");
    await h.settle();
    spy.mockRestore();

    const cps = h.engine.state.session.checkpoints ?? s.session.checkpoints ?? [];
    // Turn 1 changed a.txt; turn 2 — a question over the standing review — changed b.txt itself: each record has its own.
    expect(cps.map((c) => [c.turn, c.prompt, c.filesChanged, c.canRewindFiles, c.endedAt !== null])).toEqual([
      [1, "one", 1, true, true],
      [2, "two", 1, true, true],
    ]);
  });
});
