import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineCommand } from "../src/protocol.js";
import type { ReviewGate } from "../src/review/gate.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §37.1: while a collection failed (`gate.phase = "collect_failed"`) nothing may move B — the retry has to
 * collect the turn into the review it started on. A reject (or a commit) there re-snapshotted B, after which
 * `retry_collect` did nothing (the collection runs only while B is unset), the failed turn's changes never reached the
 * review and an answer turn's `isAnsweringReview` stayed behind. Like `finish_review` / `rewind`, they are refused
 * `collect_failed` until the retry succeeded; accept stays allowed (§34.2: it is held against the held B).
 */

const text = (lines: string[]): string => lines.join("\n") + "\n";
const svc = (edits: Record<number, string> = {}): string => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  for (const [no, t] of Object.entries(edits)) lines[Number(no) - 1] = t;
  return text(lines);
};

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-collectguard"));
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
/** The gate's private §34.1 running-turn base (a test seam: an unreadable tree makes the collection fail). */
const setTurnBase = (h: Harness, tree: string | null): void => {
  (gateOf(h) as unknown as { runningTurnBase: string | null }).runningTurnBase = tree;
};

/** Turn 1 changes Svc.java line 2 and adds new.txt; turn 2 (a question over that review) edits line 15 — and its collection fails. */
async function failedAnswerTurn(): Promise<{ h: Harness; dir: string }> {
  const dir = makeRepo();
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello({ budget: { maxFiles: 50, maxLines: 5000 } });
  await h.open(dir);
  await h.engine.request({ type: "send", text: "change Svc" });
  write(dir, "Svc.java", svc({ 2: "l2 changed" }));
  write(dir, "new.txt", "brand new\n");
  h.session().emitTurnEnd({ toolFiles: [
    { path: join(dir, "Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] },
    { path: join(dir, "new.txt"), tools: ["Write"], count: 1, toolUseIds: ["w1"] },
  ] });
  await h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.turnEndTree !== null, "turn 1 collected");

  await h.engine.request({ type: "send", text: "and l15 too" });
  setTurnBase(h, "0123456789012345678901234567890123456789"); // a start tree git cannot read: the collection fails
  write(dir, "Svc.java", svc({ 2: "l2 changed", 15: "l15 by turn 2" }));
  h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e2"] }] });
  await h.waitFor((s) => s.gate.phase === "collect_failed", "collection failure");
  setTurnBase(h, null); // the retry can succeed from here on
  return { h, dir };
}

describe("collect_failed: nothing moves B before the retry (§37.1)", () => {
  it("reject / reject_all / reject_hunks are refused collect_failed; the retry then collects the turn into the same review", async () => {
    const { h, dir } = await failedAnswerTurn();
    const refused: EngineCommand[] = [
      { type: "reject", paths: ["new.txt"] },
      { type: "reject_all" },
      { type: "reject_hunks", path: "Svc.java", hunks: [0] },
    ];
    for (const cmd of refused) {
      const e = await h.engine.request(cmd).catch((x: unknown) => x as Error);
      expect(String(e), cmd.type).toMatch(/collect_failed/);
    }
    // Nothing was reverted on disk.
    expect(read(dir, "new.txt")).toBe("brand new\n");
    expect(read(dir, "Svc.java")).toBe(svc({ 2: "l2 changed", 15: "l15 by turn 2" }));

    await h.engine.request({ type: "retry_collect" });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.gate.turnEndTree !== null, "retried");
    expect(gateOf(h).isAnsweringReview).toBe(false);
    expect(s.changedFiles.map((f) => [f.path, f.state, f.changedThisTurn ?? false])).toEqual([
      ["Svc.java", "pending", true],
      ["new.txt", "pending", false],
    ]);
    expect(h.ofType("turn_end").at(-1)).toMatchObject({ files: 1, merged: true, review: { files: 2 } });
    // Now a reject works as usual.
    await h.engine.request({ type: "reject", paths: ["new.txt"] });
    expect(read(dir, "new.txt")).toBeNull();
  });

  it("commit is refused collect_failed too (an accept during the failure stays allowed)", async () => {
    const { h } = await failedAnswerTurn();
    await h.engine.request({ type: "accept", paths: ["new.txt"] });
    expect(h.engine.state.changedFiles.find((f) => f.path === "new.txt")?.state).toBe("accepted");
    // The commit button says so too (disabled, not a refusal after the click).
    expect(h.engine.state.commit.canCommit).toBe(false);
    const e = await h.engine.request({ type: "commit", message: "add new.txt", paths: ["new.txt"] }).catch((x: unknown) => x as Error);
    expect(String(e)).toMatch(/collect_failed/);
    await h.engine.request({ type: "retry_collect" });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.gate.turnEndTree !== null, "retried");
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["Svc.java", "pending"], ["new.txt", "accepted"]]);
    expect(h.ofType("turn_end").at(-1)).toMatchObject({ files: 1, merged: true });
    expect(h.engine.state.commit.canCommit).toBe(true);
  });
});
