import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineOptions } from "../src/engine.js";
import type { ReviewGate } from "../src/review/gate.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §3 (M30): a turn-end collection that fails is retried once by itself (`collectRetryMs` later); when that
 * fails too the input stays open — the turn that starts next keeps A, so its collection holds the failed turn's changes with
 * its own, and the failed turn's tool files are carried in so its files keep their causes. A send that never reached Claude
 * puts the failure back as it was.
 */

const text = (lines: string[]): string => lines.join("\n") + "\n";
const svc = (edits: Record<number, string> = {}): string => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  for (const [no, t] of Object.entries(edits)) lines[Number(no) - 1] = t;
  return text(lines);
};

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-collectretry"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "Svc.java", svc());
  write(dir, "other.txt", "other\n");
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

const gateOf = (h: Harness) => (h.engine as unknown as { gate: ReviewGate }).gate;
/** A start tree git cannot read makes the collection fail (the gate's private §34.1 running-turn base, a test seam). */
const BAD_TREE = "0123456789012345678901234567890123456789";
const setTurnBase = (h: Harness, tree: string | null): void => {
  (gateOf(h) as unknown as { runningTurnBase: string | null }).runningTurnBase = tree;
};
const failures = (h: Harness) => h.ofType("error").filter((e) => e.code === "collect_failed");

async function opened(opts: EngineOptions = {}): Promise<{ h: Harness; dir: string }> {
  const dir = makeRepo();
  dirs.push(dir);
  const h = makeHarness(opts);
  harnesses.push(h);
  await h.hello({ budget: { maxFiles: 50, maxLines: 5000 } });
  await h.open(dir);
  return { h, dir };
}

/** A fresh turn that writes x.txt; its collection fails (the seam stays until the test lifts it). */
async function failedFreshTurn(h: Harness, dir: string): Promise<void> {
  await h.engine.request({ type: "send", text: "write x" });
  setTurnBase(h, BAD_TREE);
  write(dir, "x.txt", "x\n");
  h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "x.txt"), tools: ["Write"], count: 1, toolUseIds: ["w-x"] }] });
  await h.waitFor((s) => s.gate.phase === "collect_failed", "collection failure");
}

describe("a failed collection retries itself once (M30, §3)", () => {
  it("the automatic retry collects the turn: one turn_end, the review as usual", async () => {
    const { h, dir } = await opened({ collectRetryMs: 40 });
    await failedFreshTurn(h, dir);
    expect(h.ofType("turn_end")).toHaveLength(0);
    setTurnBase(h, null); // git can read the trees again
    const s = await h.waitFor((x) => x.gate.phase === "reviewing", "retried by itself");
    expect(s.gate.collectError).toBeNull();
    expect(s.changedFiles.map((f) => [f.path, f.state, f.origin])).toEqual([["x.txt", "pending", "tool"]]);
    expect(h.ofType("turn_end")).toHaveLength(1);
    expect(h.ofType("log").some((l) => /one automatic retry in 40 ms/.test(l.message))).toBe(true);
  });

  it("is retried only once; then the input is open and the next send keeps A: one review of both turns, the causes kept", async () => {
    const { h, dir } = await opened({ collectRetryMs: 20 });
    await failedFreshTurn(h, dir);
    const a = h.engine.state.gate.turnStartTree;
    await h.waitFor(() => failures(h).length === 2, "the automatic retry failed too");
    await new Promise((r) => setTimeout(r, 80));
    expect(failures(h)).toHaveLength(2); // never a third
    const failed = h.engine.state;
    expect(failed.gate.phase).toBe("collect_failed");
    expect(failed.gate.canSend).toBe(true);
    expect(failed.gate.blockedReason).toBeNull();
    // A change request needs the collection (the notes are on a list that has not been rebuilt).
    await expect(h.engine.request({ type: "request_changes" })).rejects.toThrow(/collect_failed|no_notes/);

    setTurnBase(h, null);
    await h.engine.request({ type: "send", text: "and y" });
    const running = h.engine.state;
    expect(running.gate.phase).toBe("running");
    expect(running.gate.collectError).toBeNull();
    expect(running.gate.turnStartTree).toBe(a); // A kept
    await h.engine.request({ type: "retry_collect" }).then(
      () => expect.unreachable("nothing to retry once folded in"),
      (e: unknown) => expect(String(e)).toMatch(/nothing_to_retry/),
    );
    write(dir, "y.txt", "y\n");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "y.txt"), tools: ["Write"], count: 1, toolUseIds: ["w-y"] }] });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing", "collected with the failed turn");
    expect(s.changedFiles.map((f) => [f.path, f.state, f.origin, f.toolUseIds])).toEqual([
      ["x.txt", "pending", "tool", ["w-x"]],
      ["y.txt", "pending", "tool", ["w-y"]],
    ]);
    expect(h.ofType("turn_end")).toHaveLength(1);
  });

  it("a failed answer turn folded into the next send: the standing review keeps its verdicts, the turn's edits join it", async () => {
    const { h, dir } = await opened();
    await h.engine.request({ type: "send", text: "change Svc" });
    write(dir, "Svc.java", svc({ 2: "l2 changed" }));
    write(dir, "new.txt", "brand new\n");
    h.session().emitTurnEnd({ toolFiles: [
      { path: join(dir, "Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] },
      { path: join(dir, "new.txt"), tools: ["Write"], count: 1, toolUseIds: ["w1"] },
    ] });
    await h.waitFor((s) => s.gate.phase === "reviewing", "turn 1 collected");
    await h.engine.request({ type: "accept", paths: ["new.txt"] });
    await h.engine.request({ type: "send", text: "and l15 too" });
    setTurnBase(h, BAD_TREE);
    write(dir, "Svc.java", svc({ 2: "l2 changed", 15: "l15 by turn 2" }));
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e2"] }] });
    await h.waitFor((s) => s.gate.phase === "collect_failed", "turn 2 failed");
    setTurnBase(h, null);

    await h.engine.request({ type: "send", text: "and other.txt" });
    expect(gateOf(h).isAnsweringReview).toBe(true);
    write(dir, "other.txt", "other by turn 3\n");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "other.txt"), tools: ["Edit"], count: 1, toolUseIds: ["e3"] }] });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.changedFiles.length === 3, "turn 3 collected");
    expect(s.changedFiles.map((f) => [f.path, f.state, f.toolUseIds])).toEqual([
      ["Svc.java", "pending", ["e1", "e2"]],
      ["new.txt", "accepted", ["w1"]],
      ["other.txt", "pending", ["e3"]],
    ]);
    expect(h.ofType("turn_end").at(-1)).toMatchObject({ merged: true, review: { files: 3 } });
    expect(read(dir, "Svc.java")).toBe(svc({ 2: "l2 changed", 15: "l15 by turn 2" }));
  });

  it("a send that never reached Claude puts the failure back as it was: the retry still collects the failed turn", async () => {
    const { h, dir } = await opened();
    await failedFreshTurn(h, dir);
    setTurnBase(h, null);
    h.session().refuseSends = new Error("the CLI went away");
    await h.engine.request({ type: "send", text: "go on" }).catch(() => undefined);
    const back = await h.waitFor((x) => x.gate.phase === "collect_failed", "the failure is back");
    expect(back.gate.collectError).not.toBeNull();
    expect(back.gate.turnEndTree).toBeNull();
    h.session().refuseSends = null;
    await h.engine.request({ type: "retry_collect" });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing", "retried");
    expect(s.changedFiles.map((f) => [f.path, f.origin])).toEqual([["x.txt", "tool"]]);
  });

  it("Accept N & Send after a failed answer turn accepts against the held B (§34.2) and sends", async () => {
    const { h, dir } = await opened();
    await h.engine.request({ type: "send", text: "change Svc" });
    write(dir, "new.txt", "brand new\n");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "new.txt"), tools: ["Write"], count: 1, toolUseIds: ["w1"] }] });
    await h.waitFor((s) => s.gate.phase === "reviewing", "turn 1 collected");
    await h.engine.request({ type: "send", text: "a question" });
    setTurnBase(h, BAD_TREE);
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase === "collect_failed", "turn 2 failed");
    setTurnBase(h, null);
    await h.engine.request({ type: "send", text: "looks good, go on", acceptPending: true });
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["new.txt", "accepted"]]);
    h.session().emitTurnEnd();
    const s = await h.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn 3 collected");
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["new.txt", "accepted"]]);
  });
});
