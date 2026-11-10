import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewGate } from "../src/review/gate.js";
import type { SessionEvent } from "../src/session/events.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §35.8 (§29): `peer_accept {ids}` must run only the messages the user saw on the card. The ids were
 * checked before the turn was prepared, but the CLI's release ("accept") lets through every message held at that moment
 * — so one that arrived while snapshot A was being taken (seconds in a large repository) ran without the user's yes.
 * The held messages are checked again right before the release: a newcomer refuses the accept (`peer_inbox_changed`,
 * nothing released, nothing of the turn left) and the card shows it.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-peerrace"));
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

const FROM = "uds:/tmp/cc-socks/76616.sock";
const held = (id: string): SessionEvent => ({ type: "peer_hold", state: "held", messageUuid: id, from: FROM, fromName: "acme-b4", cause: "explicit-setting" });

describe("peer_accept releases only what the card showed (§35.8)", () => {
  it("a message held while the turn was being prepared refuses the accept: nothing released, both still held, no turn", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    h.session().emit(held("P1"));
    await h.settle();
    // The user clicks "Claude가 처리" for P1; while snapshot A is taken another session's message arrives.
    const gate = (h.engine as unknown as { gate: ReviewGate }).gate;
    const real = gate.snapshotStart.bind(gate);
    gate.snapshotStart = async () => {
      h.session().emit(held("P2"));
      return real();
    };
    const e = await h.engine.request({ type: "peer_accept", ids: ["P1"] }).catch((x: unknown) => x as Error);
    expect(String(e)).toMatch(/peer_inbox_changed/);
    expect(h.session().peerCalls.filter((c) => c.op === "release")).toEqual([]);
    const s = h.engine.state;
    expect(s.session.peerInbox!.map((m) => [m.id, m.state])).toEqual([["P1", "held"], ["P2", "held"]]);
    expect(s.session.peerTurn ?? null).toBeNull();
    expect(s.gate.phase).toBe("idle");
    expect(s.gate.canSend).toBe(true);
    expect(s.hud.turnStartedAt).toBeNull();
    expect(h.ofType("error")).toEqual([]);
    // Nothing of the turn is left: no "처리 중" on the card, no checkpoint, the turn number unused.
    expect(h.ofType("peer_message").filter((e) => e.message.state === "delivering")).toEqual([]);
    expect(s.session.checkpoints ?? []).toEqual([]);

    // Accepting what the card now shows runs both, as turn 1.
    gate.snapshotStart = real;
    await h.engine.request({ type: "peer_accept", ids: ["P1", "P2"] });
    expect(h.session().peerCalls.filter((c) => c.op === "release").map((c) => c.ids)).toEqual([["P1", "P2"]]);
    expect(h.engine.state.gate.phase).toBe("running");
    expect(h.engine.state.session.peerInbox!.map((m) => [m.id, m.state, m.turn])).toEqual([["P1", "delivering", 1], ["P2", "delivering", 1]]);
  });

  it("a snapshot A that fails leaves nothing of the turn either: refused peer_release_failed, the messages held, the next turn is turn 1", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    h.session().emit(held("P1"));
    await h.settle();
    const gate = (h.engine as unknown as { gate: ReviewGate }).gate;
    const real = gate.snapshotStart.bind(gate);
    gate.snapshotStart = async () => {
      throw new Error("fatal: unable to write new index file");
    };
    await expect(h.engine.request({ type: "peer_accept", ids: ["P1"] })).rejects.toThrow("peer_release_failed:fatal: unable to write new index file");
    expect(h.engine.state.session.peerInbox!.map((m) => m.state)).toEqual(["held"]);
    expect(h.ofType("peer_message").filter((e) => e.message.state === "delivering")).toEqual([]);
    expect(h.ofType("error").at(-1)).toMatchObject({ code: "peer_release_failed", fatal: false });
    expect(h.engine.state.gate.canSend).toBe(true);
    gate.snapshotStart = real;
    await h.engine.request({ type: "peer_accept", ids: ["P1"] });
    expect(h.engine.state.session.peerInbox!.map((m) => [m.id, m.state, m.turn])).toEqual([["P1", "delivering", 1]]);
  });

  it("auto mode (no ids) still takes every held message, the late one included", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    h.session().emit(held("P1"));
    await h.settle();
    const gate = (h.engine as unknown as { gate: ReviewGate }).gate;
    const real = gate.snapshotStart.bind(gate);
    gate.snapshotStart = async () => {
      h.session().emit(held("P2"));
      return real();
    };
    await h.engine.request({ type: "peer_accept" });
    expect(h.session().peerCalls.filter((c) => c.op === "release").map((c) => c.ids)).toEqual([["P1", "P2"]]);
  });
});
