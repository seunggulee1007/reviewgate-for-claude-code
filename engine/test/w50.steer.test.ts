import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §50: `steer` — a message into the turn that runs, as typing while Claude works in the terminal. */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-w50steer"));
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

async function opened(): Promise<{ h: Harness; repo: string }> {
  const repo = realpathSync(makeRepo());
  dirs.push(repo);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(repo);
  return { h, repo };
}

describe("§50 steer", () => {
  it("while a turn runs the message goes into it: the session gets it, a user row marked steered, the same turn", async () => {
    const { h } = await opened();
    await h.engine.request({ type: "send", text: "Fix the cart" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    const turn = h.ofType("user_message").at(-1)!.turn;
    await h.engine.request({ type: "steer", text: "  Also update README.md  ", mentions: ["README.md"] });
    expect(h.session().steers).toEqual(["Also update README.md\n\nReferenced files: @README.md"]);
    expect(h.session().sends).toHaveLength(1);
    // composer (§50.2): it waits above the input until Claude reads it; its row comes then, with this turn's number.
    expect(h.engine.state.session.steering).toEqual([{ id: "steer-1", text: "Also update README.md", mentions: ["README.md"] }]);
    expect(h.ofType("user_message")).toHaveLength(1);
    h.session().emit({ type: "steer_read", uuid: "steer-1" });
    await h.waitFor((s) => (s.session.steering ?? []).length === 0, "read");
    expect(h.ofType("user_message").at(-1)).toEqual({ type: "user_message", text: "Also update README.md", turn, mentions: ["README.md"], steered: true });
    // A plain send still waits for the turn (the queue's job).
    await expect(h.engine.request({ type: "send", text: "next" })).rejects.toThrow(/gate_closed/);
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn over");
    expect(h.ofType("user_message").filter((e) => e.turn === turn)).toHaveLength(2);
  });

  it("composer (§50.2): several wait in order; one Claude never started goes in with the turn's end", async () => {
    const { h } = await opened();
    await h.engine.request({ type: "send", text: "Fix the cart" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    const turn = h.ofType("user_message").at(-1)!.turn;
    await h.engine.request({ type: "steer", text: "first" });
    await h.engine.request({ type: "steer", text: "second" });
    expect((h.engine.state.session.steering ?? []).map((m) => m.text)).toEqual(["first", "second"]);
    h.session().emit({ type: "steer_read", uuid: "steer-2" });
    await h.waitFor((s) => (s.session.steering ?? []).length === 1, "second read");
    expect(h.engine.state.session.steering?.[0]?.text).toBe("first");
    h.session().emit({ type: "steer_read", uuid: "not-ours" });
    expect(h.engine.state.session.steering).toHaveLength(1);
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn over");
    expect(h.engine.state.session.steering).toEqual([]);
    expect(h.ofType("user_message").filter((e) => e.steered).map((e) => [e.text, e.turn])).toEqual([["second", turn], ["first", turn]]);
  });

  it("§50.3 a take-back in time: it leaves the list with no row, and the turn's end brings none", async () => {
    const { h } = await opened();
    await h.engine.request({ type: "send", text: "Fix the cart" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    await h.engine.request({ type: "steer", text: "first" });
    await h.engine.request({ type: "steer", text: "second" });
    await h.engine.request({ type: "steer_take_back", messageId: "steer-1" });
    expect(h.session().takeBacks).toEqual(["steer-1"]);
    expect((h.engine.state.session.steering ?? []).map((m) => m.text)).toEqual(["second"]);
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn over");
    expect(h.ofType("user_message").filter((e) => e.steered).map((e) => e.text)).toEqual(["second"]);
  });

  it("§50.3 too late: Claude read it — refused steer_already_read, its row stays", async () => {
    const { h } = await opened();
    await h.engine.request({ type: "send", text: "Fix the cart" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    await h.engine.request({ type: "steer", text: "first" });
    // The CLI started it while the take-back was on its way.
    let answer: (o: "read") => void = () => {};
    h.session().takeBackResult = new Promise((r) => (answer = r));
    const asked = h.engine.request({ type: "steer_take_back", messageId: "steer-1" });
    await h.waitFor(() => h.session().takeBacks.length === 1, "asked");
    h.session().emit({ type: "steer_read", uuid: "steer-1" });
    answer("read");
    await expect(asked).rejects.toThrow(/steer_already_read/);
    expect(h.engine.state.session.steering).toEqual([]);
    expect(h.ofType("user_message").filter((e) => e.steered).map((e) => e.text)).toEqual(["first"]);
    // Asked again (or for a message no longer waiting): refused at once, the CLI is not asked.
    await expect(h.engine.request({ type: "steer_take_back", messageId: "steer-1" })).rejects.toThrow(/steer_already_read/);
    expect(h.session().takeBacks).toEqual(["steer-1"]);
  });

  it("§50.3 after the turn ended: what waited went in with it — refused steer_already_read", async () => {
    const { h } = await opened();
    await h.engine.request({ type: "send", text: "Fix the cart" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    await h.engine.request({ type: "steer", text: "first" });
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn over");
    await expect(h.engine.request({ type: "steer_take_back", messageId: "steer-1" })).rejects.toThrow(/steer_already_read/);
    expect(h.session().takeBacks).toEqual([]);
    expect(h.ofType("user_message").filter((e) => e.steered).map((e) => e.text)).toEqual(["first"]);
  });

  it("§50.3 the CLI could not be asked: refused steer_take_back_failed, it still waits", async () => {
    const { h } = await opened();
    await h.engine.request({ type: "send", text: "Fix the cart" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    await h.engine.request({ type: "steer", text: "first" });
    h.session().takeBackResult = "kept";
    await expect(h.engine.request({ type: "steer_take_back", messageId: "steer-1" })).rejects.toThrow(/steer_take_back_failed/);
    expect((h.engine.state.session.steering ?? []).map((m) => m.text)).toEqual(["first"]);
  });

  it("§50.3 a take-back that waits for the CLI does not hold up the turn's lane", async () => {
    const { h } = await opened();
    await h.engine.request({ type: "send", text: "Fix the cart" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    await h.engine.request({ type: "steer", text: "first" });
    let answer: (o: "taken") => void = () => {};
    h.session().takeBackResult = new Promise((r) => (answer = r));
    const asked = h.engine.request({ type: "steer_take_back", messageId: "steer-1" });
    await h.engine.request({ type: "steer", text: "second" }); // the main lane is free
    expect(h.session().steers).toHaveLength(2);
    answer("taken");
    await asked;
    expect((h.engine.state.session.steering ?? []).map((m) => m.text)).toEqual(["second"]);
  });

  it("refused when no turn runs, and for an empty message", async () => {
    const { h } = await opened();
    await expect(h.engine.request({ type: "steer", text: "hello" })).rejects.toThrow("steer_unavailable:not_running");
    await h.engine.request({ type: "send", text: "Fix the cart" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    await expect(h.engine.request({ type: "steer", text: "   " })).rejects.toThrow("empty message");
    expect(h.session().steers).toEqual([]);
  });
});
