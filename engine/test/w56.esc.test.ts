import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §56.2: `interrupt {takeBack: true}` — Esc gives back what Claude has not read, as in the terminal. */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-w56esc"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
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

/** A running turn with two messages put into it ("first" with a mention, "second"). */
async function steered(): Promise<Harness> {
  const repo = makeRepo();
  dirs.push(repo);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(repo);
  await h.engine.request({ type: "send", text: "Fix the cart" });
  await h.waitFor((s) => s.gate.phase === "running", "turn running");
  await h.engine.request({ type: "steer", text: "first", mentions: ["README.md"] });
  await h.engine.request({ type: "steer", text: "second" });
  return h;
}

describe("§56.2 interrupt {takeBack}", () => {
  it("a CLI with cancel_queued: one interrupt drops them; the reply has their text and mentions; no row comes", async () => {
    const h = await steered();
    h.session().cancelQueued = true;
    const r = await h.engine.request({ type: "interrupt", takeBack: true });
    expect(r).toMatchObject({ type: "interrupted", takenBack: [{ id: "steer-1", text: "first", mentions: ["README.md"] }, { id: "steer-2", text: "second" }], read: [] });
    expect(h.session().interruptsTakingBack).toBe(1);
    expect(h.session().interrupts).toBe(0);
    expect(h.session().takeBacks).toEqual([]);
    expect(h.engine.state.session.steering).toEqual([]);
    h.session().emitTurnEnd({ stopReason: "interrupted" });
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn over");
    expect(h.ofType("user_message").filter((e) => e.steered)).toEqual([]);
  });

  it("one Claude was reading is not in the receipt: listed read, its row comes with the turn's end", async () => {
    const h = await steered();
    h.session().cancelQueued = true;
    h.session().cancelQueuedResult = ["steer-2"];
    const r = await h.engine.request({ type: "interrupt", takeBack: true });
    expect(r).toMatchObject({ type: "interrupted", takenBack: [{ id: "steer-2", text: "second" }], read: ["steer-1"] });
    h.session().emitTurnEnd({ stopReason: "interrupted" });
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn over");
    expect(h.ofType("user_message").filter((e) => e.steered).map((e) => e.text)).toEqual(["first"]);
  });

  it("a CLI without it: each is taken back first, then the turn is interrupted", async () => {
    const h = await steered();
    const r = await h.engine.request({ type: "interrupt", takeBack: true });
    expect(h.session().takeBacks).toEqual(["steer-1", "steer-2"]);
    expect(h.session().interrupts).toBe(1);
    expect(r).toMatchObject({ type: "interrupted", takenBack: [{ id: "steer-1" }, { id: "steer-2" }], read: [] });
    expect(h.engine.state.session.steering).toEqual([]);
  });

  it("one by one, too late for them: the interrupt goes out, nothing comes back", async () => {
    const h = await steered();
    h.session().takeBackResult = "read";
    const r = await h.engine.request({ type: "interrupt", takeBack: true });
    expect(h.session().interrupts).toBe(1);
    expect(r).toMatchObject({ type: "interrupted", takenBack: [], read: ["steer-1", "steer-2"] });
  });

  it("one by one, a take-back still waiting for the CLI: the interrupt goes out anyway and what it settles to counts", async () => {
    const h = await steered();
    let answer: (o: "taken") => void = () => {};
    h.session().takeBackResult = new Promise((r) => (answer = r));
    const asked = h.engine.request({ type: "interrupt", takeBack: true });
    await h.waitFor(() => h.session().interrupts === 1, "the interrupt went out without waiting for the CLI", 4000);
    answer("taken");
    await expect(asked).resolves.toMatchObject({ takenBack: [{ id: "steer-1" }, { id: "steer-2" }], read: [] });
  });

  it("nothing waiting in the turn: a plain interrupt, an empty reply; no turn: nothing at all", async () => {
    const h = await steered();
    h.session().emit({ type: "steer_read", uuid: "steer-1" });
    h.session().emit({ type: "steer_read", uuid: "steer-2" });
    await h.waitFor((s) => (s.session.steering ?? []).length === 0, "read");
    h.session().cancelQueued = true;
    await expect(h.engine.request({ type: "interrupt", takeBack: true })).resolves.toMatchObject({ type: "interrupted", takenBack: [], read: [] });
    expect(h.session().interrupts).toBe(1);
    expect(h.session().interruptsTakingBack).toBe(0);
    h.session().emitTurnEnd({ stopReason: "interrupted" });
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn over");
    await expect(h.engine.request({ type: "interrupt", takeBack: true })).resolves.toMatchObject({ type: "interrupted", takenBack: [], read: [] });
    expect(h.session().interrupts).toBe(1);
  });

  it("without takeBack: the plain interrupt it was — result ok, what waits stays", async () => {
    const h = await steered();
    h.session().cancelQueued = true;
    await expect(h.engine.request({ type: "interrupt" })).resolves.toMatchObject({ type: "result", ok: true });
    expect(h.session().interrupts).toBe(1);
    expect(h.session().interruptsTakingBack).toBe(0);
    expect((h.engine.state.session.steering ?? []).map((m) => m.text)).toEqual(["first", "second"]);
  });
});
