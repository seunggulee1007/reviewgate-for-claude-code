import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §34.2 (M28): "Accept all" applies at once with an undo — so `unaccept` follows `accept`'s rule: allowed
 * while a turn runs on a standing review (the undo of an accept made then), refused in a fresh turn and while collecting.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-unaccept"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "a.txt", "a\n");
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

describe("unaccept while Claude works (M28, §34.2)", () => {
  it("undoes an accept made during a question turn: pending again, and still pending after the collection", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    await h.engine.request({ type: "send", text: "change a" });
    write(dir, "a.txt", "a changed\n");
    write(dir, "b.txt", "b\n");
    h.session().emitTurnEnd({ toolFiles: [
      { path: join(dir, "a.txt"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] },
      { path: join(dir, "b.txt"), tools: ["Write"], count: 1, toolUseIds: ["w1"] },
    ] });
    await h.waitFor((s) => s.gate.phase === "reviewing", "turn 1 collected");
    await h.engine.request({ type: "send", text: "a question" });
    await h.engine.request({ type: "accept_all" });
    expect(h.engine.state.changedFiles.map((f) => f.state)).toEqual(["accepted", "accepted"]);
    await h.engine.request({ type: "unaccept", paths: ["a.txt", "b.txt"] });
    expect(h.engine.state.changedFiles.map((f) => f.state)).toEqual(["pending", "pending"]);
    expect(h.engine.state.gate.lastReviewSummary).toBeNull();
    h.session().emitTurnEnd();
    const s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.gate.turnEndTree !== null, "collected");
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["a.txt", "pending"], ["b.txt", "pending"]]);

    // A fresh turn (nothing pending, no held B): still refused.
    await h.engine.request({ type: "accept_all" });
    await h.engine.request({ type: "send", text: "next" });
    await expect(h.engine.request({ type: "unaccept", paths: ["a.txt"] })).rejects.toThrow("session_running");
  });
});
