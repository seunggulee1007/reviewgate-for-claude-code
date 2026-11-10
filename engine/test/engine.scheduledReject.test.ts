import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rejectSteerText } from "../src/engine.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §34.2 (M32): `reject` / `reject_all` while Claude works on a standing review are scheduled — the file is
 * `rejectScheduled`, Claude is told at once (a message into the turn) not to build on it, and right after the turn's
 * collection it is reverted like a reject; a file the turn changed again is left pending and a row asks. An accept cancels it.
 */

const text = (lines: string[]): string => lines.join("\n") + "\n";
const svc = (edits: Record<number, string> = {}): string => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  for (const [no, t] of Object.entries(edits)) lines[Number(no) - 1] = t;
  return text(lines);
};

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-schedreject"));
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

/** Turn 1 changes Svc.java line 2 and adds new.txt (both Claude's); then a question over that review is running. */
async function answerTurnRunning(): Promise<{ h: Harness; dir: string }> {
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
  await h.waitFor((s) => s.gate.phase === "reviewing", "turn 1 collected");
  await h.engine.request({ type: "send", text: "why l2?" });
  expect(h.engine.state.gate.phase).toBe("running");
  return { h, dir };
}

const fileOf = (h: Harness, path: string) => h.engine.state.changedFiles.find((f) => f.path === path);
const notices = (h: Harness, code: string) => h.ofType("error").filter((e) => e.code === code);

describe("reject while Claude works (M32, §34.2)", () => {
  it("is scheduled: Claude is told at once, the file is reverted right after the collection, the next message says so", async () => {
    const { h, dir } = await answerTurnRunning();
    await h.engine.request({ type: "reject", paths: ["new.txt"] });
    expect(fileOf(h, "new.txt")).toMatchObject({ state: "pending", rejectScheduled: true });
    expect(read(dir, "new.txt")).toBe("brand new\n"); // nothing reverted mid-turn
    expect(h.session().steers).toEqual([rejectSteerText(["new.txt"])]);
    expect(notices(h, "reject_scheduled")).toEqual([expect.objectContaining({ detail: "new.txt", fatal: false })]);

    write(dir, "Svc.java", svc({ 2: "l2 changed", 15: "l15 by turn 2" }));
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e2"] }] });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.gate.turnEndTree !== null && !x.changedFiles.some((f) => f.path === "new.txt"), "collected and reverted");
    expect(read(dir, "new.txt")).toBeNull();
    expect(s.changedFiles.map((f) => [f.path, f.state, f.rejectScheduled ?? false])).toEqual([["Svc.java", "pending", false]]);
    expect(h.ofType("turn_end").at(-1)).toMatchObject({ review: { files: 1 } });
    expect(notices(h, "reject_applied")).toEqual([expect.objectContaining({ detail: "new.txt" })]);
    expect(s.gate.lastReviewSummary).toMatch(/Rejected \(reverted on disk, do not redo unless asked\): new\.txt/);
    // §41.2: like any single-file reject, it can be put back.
    expect(s.gate.rejectUndo?.path).toBe("new.txt");
  });

  it("a file the turn changed again is not reverted: it stays pending and a row asks", async () => {
    const { h, dir } = await answerTurnRunning();
    await h.engine.request({ type: "reject", paths: ["Svc.java"] });
    expect(fileOf(h, "Svc.java")?.rejectScheduled).toBe(true);
    write(dir, "Svc.java", svc({ 2: "l2 changed", 15: "l15 by turn 2" }));
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e2"] }] });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.gate.turnEndTree !== null, "collected");
    expect(read(dir, "Svc.java")).toBe(svc({ 2: "l2 changed", 15: "l15 by turn 2" }));
    expect(s.changedFiles.map((f) => [f.path, f.state, f.rejectScheduled ?? false])).toEqual([["Svc.java", "pending", false], ["new.txt", "pending", false]]);
    expect(notices(h, "reject_changed_again")).toEqual([expect.objectContaining({ detail: "Svc.java" })]);
    expect(notices(h, "reject_applied")).toEqual([]);
    // Rejecting it now is an ordinary reject.
    await h.engine.request({ type: "reject", paths: ["Svc.java"] });
    expect(read(dir, "Svc.java")).toBe(svc());
  });

  it("reject_all schedules Claude's pending files (an external one stays unless included); an accept cancels a scheduled reject", async () => {
    const { h, dir } = await answerTurnRunning();
    await h.engine.request({ type: "reject_all" });
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.rejectScheduled ?? false])).toEqual([["Svc.java", true], ["new.txt", true]]);
    expect(h.session().steers).toEqual([rejectSteerText(["Svc.java", "new.txt"])]);
    await h.engine.request({ type: "accept", paths: ["Svc.java"] });
    expect(fileOf(h, "Svc.java")).toMatchObject({ state: "accepted" });
    expect(fileOf(h, "Svc.java")?.rejectScheduled).toBeUndefined();
    h.session().emitTurnEnd();
    // Nothing is pending afterwards: the phase is idle, the accepted file stays listed.
    const s = await h.waitFor((x) => x.gate.phase === "idle" && x.gate.turnEndTree !== null && x.changedFiles.length === 1, "collected");
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["Svc.java", "accepted"]]);
    expect(read(dir, "new.txt")).toBeNull();
    expect(read(dir, "Svc.java")).toBe(svc({ 2: "l2 changed" }));
  });

  it("still refused where nothing can wait: a fresh turn (session_running), reject_hunks and finish_review during any turn", async () => {
    const { h } = await answerTurnRunning();
    await expect(h.engine.request({ type: "reject_hunks", path: "Svc.java", hunks: [0] })).rejects.toThrow("session_running");
    await expect(h.engine.request({ type: "finish_review" })).rejects.toThrow("session_running");
    h.session().emitTurnEnd();
    await h.waitFor((x) => x.gate.phase === "reviewing" && x.gate.turnEndTree !== null, "collected");
    await h.engine.request({ type: "accept_all" });
    await h.engine.request({ type: "send", text: "next task" }); // nothing pending: a fresh A
    expect(h.engine.state.gate.reviewEndTree).toBeNull();
    await expect(h.engine.request({ type: "reject", paths: ["Svc.java"] })).rejects.toThrow("session_running");
    expect(h.session().steers).toEqual([]);
  });
});
