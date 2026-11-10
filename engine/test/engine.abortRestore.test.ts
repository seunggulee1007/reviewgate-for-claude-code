import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewGate } from "../src/review/gate.js";
import type { SessionEvent } from "../src/session/events.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §37.8: a fresh turn that is called off after its snapshot A was taken — `peer_accept` refused
 * `peer_inbox_changed` (§35.8: a message held while A was taken), or a `send` whose session went away right then — puts
 * the review back as it was. Before, the new A stayed and B was cleared: a review whose files were all accepted but not
 * committed yet (no pending file, so the next turn is a fresh one) lost every diff (`select_file` → `no_review`), its
 * ranges went, and the review file was saved that way.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-abortrestore"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "Svc.java", "l1\nl2\nl3\n");
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
const held = (id: string): SessionEvent => ({ type: "peer_hold", state: "held", messageUuid: id, from: "uds:/tmp/cc-socks/1.sock", fromName: "other", cause: "explicit-setting" });

/** Turn 1 changes Svc.java; the user accepts it and has not committed yet (nothing pending: the next turn is fresh). */
async function acceptedReview(): Promise<{ h: Harness; dir: string; trees: { start: string; end: string } }> {
  const dir = makeRepo();
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello({ budget: { maxFiles: 50, maxLines: 5000 } });
  await h.open(dir);
  await h.engine.request({ type: "send", text: "change Svc" });
  write(dir, "Svc.java", "l1\nl2 changed\nl3\n");
  h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] }] });
  await h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.turnEndTree !== null, "collected");
  await h.engine.request({ type: "accept", paths: ["Svc.java"] });
  const g = gateOf(h);
  expect(h.engine.state.gate.phase).toBe("idle");
  return { h, dir, trees: { start: g.turnStartTree!, end: g.turnEndTree! } };
}

async function expectReviewIntact(h: Harness, trees: { start: string; end: string }): Promise<void> {
  const g = gateOf(h);
  expect([g.turnStartTree, g.turnEndTree, g.turnBaseTree]).toEqual([trees.start, trees.end, trees.start]);
  const s = h.engine.state;
  expect(s.gate.reviewEndTree).toBe(trees.end);
  expect(s.changedFiles.map((f) => [f.path, f.state, f.changedThisTurn ?? false])).toEqual([["Svc.java", "accepted", true]]);
  const diff = await h.engine.request({ type: "select_file", path: "Svc.java" });
  expect(diff).toMatchObject({ type: "file_diff", endTree: trees.end, baseTree: trees.start });
  const turnDiff = await h.engine.request({ type: "select_file", path: "Svc.java", since: "turn" });
  expect(turnDiff).toMatchObject({ type: "file_diff", since: "turn", baseTree: trees.start });
}

describe("a fresh turn called off after snapshot A leaves the review as it was (§37.8)", () => {
  it("peer_accept refused peer_inbox_changed (§35.8): A, B, the ranges and every diff are back", async () => {
    const { h, trees } = await acceptedReview();
    h.session().emit(held("P1"));
    await h.settle();
    const gate = gateOf(h);
    const real = gate.snapshotStart.bind(gate);
    gate.snapshotStart = async () => {
      h.session().emit(held("P2"));
      return real();
    };
    const e = await h.engine.request({ type: "peer_accept", ids: ["P1"] }).catch((x: unknown) => x as Error);
    expect(String(e)).toMatch(/peer_inbox_changed/);
    gate.snapshotStart = real;
    await expectReviewIntact(h, trees);
  });

  it("a send whose session went away right after snapshot A: the review is back too", async () => {
    const { h, trees } = await acceptedReview();
    h.session().refuseSends = new Error("session closed");
    await h.engine.request({ type: "send", text: "next step" });
    expect(h.ofType("error").at(-1)).toMatchObject({ code: "send_failed" });
    expect(h.engine.state.gate.phase).toBe("idle");
    await expectReviewIntact(h, trees);
  });
});
