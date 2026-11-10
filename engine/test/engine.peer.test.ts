import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNPROMPTED_NOTICE } from "../src/engine.js";
import { SESSION_FILE } from "../src/review/persist.js";
import { sessionTranscriptPath } from "../src/review/sessions.js";
import { SideQuery, type SideQueryOptions } from "../src/side/sideQuery.js";
import type { SessionEvent } from "../src/session/events.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §29 — messages from the user's other Claude sessions (audit peer-01…06, crash-3). The session holds
 * them (`crossSessionInbound: "hold"`); the engine lists them (`state.session.peerInbox`, `peer_message`), and
 * `peer_accept` runs them as a review turn under the `send` gate (snapshot A, collection, permission cards as usual),
 * `peer_dismiss` refuses them, `peer_set` switches ask / auto / off per project. A turn the CLI runs that is not ours
 * closes the input (`gate_closed:external_turn`); a peer message an older CLI delivered by itself gets a card instead of
 * the unprompted-turn banner.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-peer"));
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
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
function harness(...args: Parameters<typeof makeHarness>): Harness {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const FROM = "uds:/tmp/cc-socks/76616.sock";
// MARK: r2-peers — a sender the user's registry lists: a live pid that is never the engine's child (the runner's parent).
const LIVE_PID = process.ppid;
const LIVE_FROM = `uds:/tmp/cc-socks/${LIVE_PID}.sock`;
/** `<config>/sessions/<pid>.json` naming LIVE_FROM's socket (CLAUDE_CONFIG_DIR of the engine under test). */
function liveRegistry(): string {
  const config = track(realpathSync(makeTempDir("rg-peer-registry")));
  mkdirSync(join(config, "sessions"), { recursive: true });
  const entry = { pid: LIVE_PID, sessionId: "term", cwd: "/work/acme", name: "acme-b4", status: "idle", entrypoint: "cli", messagingSocketPath: `/tmp/cc-socks/${LIVE_PID}.sock` };
  writeFileSync(join(config, "sessions", `${LIVE_PID}.json`), JSON.stringify(entry));
  return config;
}
const held = (id: string, extra: Partial<Extract<SessionEvent, { type: "peer_hold" }>> = {}): SessionEvent => ({ type: "peer_hold", state: "held", messageUuid: id, from: FROM, fromName: "acme-b4", cause: "explicit-setting", ...extra });
const delivered = (id: string | null, body: string, owned: boolean): SessionEvent => ({ type: "peer_delivered", messageUuid: id, owned, origin: { from: FROM, name: "acme-b4", verifiedPeerPid: 76616, body, fromMode: "prompting" } });
const rowsOf = (dir: string, id: string) => {
  try {
    return readFileSync(sessionTranscriptPath(join(dir, ".git"), id), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
};

async function opened(opts: Parameters<typeof makeHarness>[0] = {}, settings = {}): Promise<{ h: Harness; dir: string; id: string }> {
  const dir = track(makeRepo());
  const h = harness(opts);
  await h.hello(settings);
  const id = (await h.open(dir)).sessions.currentId!;
  return { h, dir, id };
}

describe("peer inbox and the session options (§29)", () => {
  it("every session holds peer messages under a ReviewGate name; a held message is listed and announced", async () => {
    const { h, dir } = await opened();
    expect(h.session().opts.settings.crossSessionInbound).toBe("hold");
    expect(h.session().opts.settings.sessionName).toBe(`ReviewGate · ${basename(dir)}`);
    // r2-peers: `auto` is the default — but this sender is in no registry, so it waits for the user.
    expect(h.engine.state.session.peerInbound).toBe("auto");
    expect(h.engine.state.session.peerInbox).toEqual([]);
    h.session().emit(held("P1"));
    await h.settle();
    await new Promise((r) => setTimeout(r, 50)); // the registry lookup
    const message = { id: "P1", from: FROM, fromName: "acme-b4", verifiedPeerPid: null, cause: "explicit-setting", receivedAt: expect.any(String), state: "held" };
    expect(h.engine.state.session.peerInbox).toEqual([message]);
    expect(h.ofType("peer_message")).toEqual([{ type: "peer_message", message }]);
    // Nothing ran: the gate stays open, no turn, no transcript row yet.
    expect(h.engine.state.gate.canSend).toBe(true);
    expect(h.session().peerCalls).toEqual([]);
  });
});

describe("peer_accept: a review turn under the send gate (§29)", () => {
  it("accepting runs the held message as a review turn: snapshot A, a peer row with the body instead of a user message, the edits collected", async () => {
    const { h, dir, id } = await opened();
    h.session().emit(held("P1"));
    await h.settle();
    await h.engine.request({ type: "peer_accept", ids: ["P1"] });
    let s = h.engine.state;
    expect(s.gate.phase).toBe("running");
    expect(h.session().peerCalls).toEqual([{ op: "release", ids: ["P1"], tree: s.gate.turnStartTree }]);
    expect(s.session.peerInbox).toMatchObject([{ id: "P1", state: "delivering", turn: 1 }]);
    expect(s.session.peerTurn).toEqual({ messageIds: ["P1"], fromNames: ["acme-b4"] });
    expect(h.ofType("user_message")).toEqual([]);

    h.session().emit(delivered("P1", "PR #514 2라운드 맡은 세션이야?", true));
    await h.settle();
    expect(h.ofType("peer_message").at(-1)!.message).toMatchObject({ id: "P1", state: "delivered", body: "PR #514 2라운드 맡은 세션이야?", verifiedPeerPid: 76616, turn: 1 });
    expect(h.engine.state.session.peerInbox).toEqual([]);
    write(dir, "README.md", "changed by the peer's request\n");
    h.session().emitTurnEnd({ sessionId: id });
    s = await h.waitFor((x) => x.gate.phase === "reviewing", "collected");
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);
    expect(s.session.peerTurn).toBeNull();
    expect(h.ofType("turn_end")).toHaveLength(1);
    expect(rowsOf(dir, id).map((r) => [r.kind, r.turn])).toEqual([["peer_message", 1], ["turn_end", 1], ["turn_summary", 1]]); // §38.3: the summary card is a row too
    expect(rowsOf(dir, id)[0]).toMatchObject({ kind: "peer_message", id: "P1", from: FROM, fromName: "acme-b4", verifiedPeerPid: 76616, state: "delivered", body: "PR #514 2라운드 맡은 세션이야?" });
    // The review summary waits for the user's next real message (a peer turn sends no text of ours).
    expect(h.engine.state.session.checkpoints!.map((c) => c.turn)).toEqual([1]);
  });

  it("a peer turn notes the §31 / §32 turn-start state like send: a commit made outside while it runs is reported (head_moved)", async () => {
    const { h, dir, id } = await opened();
    const before = sh(dir, "rev-parse", "HEAD").trim();
    h.session().emit(held("P1"));
    await h.settle();
    await h.engine.request({ type: "peer_accept", ids: ["P1"] });
    // Someone commits in a terminal while the peer turn runs.
    write(dir, "OUTSIDE.md", "committed outside\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "outside");
    const after = sh(dir, "rev-parse", "HEAD").trim();
    h.session().emitTurnEnd({ sessionId: id });
    const s = await h.waitFor((x) => x.gate.headMoved != null, "headMoved");
    expect(s.gate.headMoved).toEqual({ from: { sha: before, branch: "main" }, to: { sha: after, branch: "main" } });
    expect(h.ofType("head_moved")).toEqual([{ type: "head_moved", turn: 1, from: { sha: before, branch: "main" }, to: { sha: after, branch: "main" } }]);
  });

  it("a released message whose body never arrived (no echo) is delivered when its turn ends — never 'discarded' later", async () => {
    const { h, dir, id } = await opened();
    h.session().emit(held("P1"));
    await h.settle();
    await h.engine.request({ type: "peer_accept" });
    h.session().emitTurnEnd({ sessionId: id });
    await h.waitFor((x) => x.gate.phase === "idle" && x.hud.turnCount === 1, "turn over");
    expect(h.engine.state.session.peerInbox).toEqual([]);
    expect(h.ofType("peer_message").at(-1)!.message).toMatchObject({ id: "P1", state: "delivered", turn: 1 });
    await h.engine.request({ type: "restart_session" });
    await h.waitFor((x) => x.session.open && h.sessions.length === 2, "restarted");
    expect(rowsOf(dir, id).filter((r) => r.kind === "peer_message").map((r) => r.state)).toEqual(["delivered"]);
  });

  it("refusals: peer_none without held messages, peer_inbox_changed when the user saw other ids, gate_closed while a turn runs", async () => {
    const { h } = await opened();
    await expect(h.engine.request({ type: "peer_accept" })).rejects.toThrow("peer_none");
    await expect(h.engine.request({ type: "peer_dismiss" })).rejects.toThrow("peer_none");
    h.session().emit(held("P1"));
    h.session().emit(held("P2"));
    await h.settle();
    await expect(h.engine.request({ type: "peer_accept", ids: ["P1"] })).rejects.toThrow("peer_inbox_changed");
    await h.engine.handle({ type: "send", text: "busy" });
    await expect(h.engine.request({ type: "peer_accept", ids: ["P1", "P2"] })).rejects.toThrow("gate_closed:running");
    expect(h.session().peerCalls).toEqual([]);
    expect(h.engine.state.session.peerInbox!.map((m) => m.state)).toEqual(["held", "held"]);
  });

  it("a release the CLI does not confirm is refused with peer_release_failed; the messages are held again and the gate reopens", async () => {
    const { h } = await opened();
    h.session().emit(held("P1"));
    await h.settle();
    h.session().releaseResult = new Error("no held peer message was released within 3000 ms");
    await expect(h.engine.request({ type: "peer_accept" })).rejects.toThrow("peer_release_failed");
    const s = h.engine.state;
    expect(s.gate.phase).toBe("idle");
    expect(s.gate.canSend).toBe(true);
    expect(s.session.peerInbox!.map((m) => m.state)).toEqual(["held"]);
    expect(s.session.peerTurn).toBeNull();
    expect(h.ofType("error").at(-1)).toMatchObject({ code: "peer_release_failed", fatal: false, scope: "session" });
  });

  it("peer_dismiss refuses the held messages: dropped rows (refused), the inbox empties", async () => {
    const { h, dir, id } = await opened();
    h.session().emit(held("P1"));
    await h.settle();
    await h.engine.request({ type: "peer_dismiss", ids: ["P1"] });
    await h.settle();
    expect(h.session().peerCalls).toEqual([{ op: "dismiss", ids: ["P1"] }]);
    expect(h.engine.state.session.peerInbox).toEqual([]);
    expect(h.ofType("peer_message").at(-1)!.message).toMatchObject({ id: "P1", state: "dropped", outcome: "refused", fromName: "acme-b4" });
    expect(rowsOf(dir, id)).toEqual([{ at: expect.any(String), turn: 0, kind: "peer_message", id: "P1", from: FROM, fromName: "acme-b4", state: "dropped", outcome: "refused" }]);
  });

  it("peer-02: a message the CLI held for a permission-mode mismatch and later expired is a card, then an 'expired' row — no banner, no error", async () => {
    const { h, dir, id } = await opened();
    h.session().emit(held("P9", { cause: "mode-mismatch", fromName: "acme-bypass" }));
    await h.settle();
    expect(h.engine.state.session.peerInbox).toMatchObject([{ id: "P9", state: "held", cause: "mode-mismatch", fromName: "acme-bypass" }]);
    h.session().emit({ type: "peer_hold", state: "dropped", messageUuid: "P9", from: FROM, fromName: "acme-bypass", outcome: "expired" });
    await h.settle();
    expect(h.engine.state.session.peerInbox).toEqual([]);
    expect(h.ofType("peer_message").map((e) => [e.message.state, e.message.outcome ?? null])).toEqual([["held", null], ["dropped", "expired"]]);
    expect(rowsOf(dir, id)).toMatchObject([{ kind: "peer_message", id: "P9", state: "dropped", outcome: "expired", fromName: "acme-bypass" }]);
    expect(h.ofType("error")).toEqual([]);
    expect(h.engine.state.gate.canSend).toBe(true);
  });

  it("a held message whose session ends is discarded (row), never left in the inbox", async () => {
    const { h, dir, id } = await opened();
    h.session().emit(held("P1"));
    await h.settle();
    await h.engine.request({ type: "restart_session" });
    await h.waitFor((x) => x.session.open && h.sessions.length === 2, "restarted");
    expect(h.engine.state.session.peerInbox).toEqual([]);
    expect(rowsOf(dir, id)).toMatchObject([{ kind: "peer_message", id: "P1", state: "dropped", outcome: "discarded" }]);
  });
});

describe("peer_set: ask / auto / off per project (§29)", () => {
  it("off refuses live and is persisted (the next session starts refusing); ask holds again", async () => {
    const { h, dir } = await opened();
    await h.engine.request({ type: "peer_set", mode: "off" });
    expect(h.session().peerCalls).toEqual([{ op: "inbound", value: "refuse" }]);
    expect(h.engine.state.session.peerInbound).toBe("off");
    await expect(h.engine.request({ type: "peer_set", mode: "never" as never })).rejects.toThrow("invalid_peer_mode");
    await h.engine.dispose();
    expect(JSON.parse(readFileSync(join(dir, ".git", SESSION_FILE), "utf8"))).toMatchObject({ peerInbound: "off" });
    const b = harness();
    await b.hello();
    await b.open(dir);
    expect(b.session().opts.settings.crossSessionInbound).toBe("refuse");
    expect(b.engine.state.session.peerInbound).toBe("off");
    await b.engine.request({ type: "peer_set", mode: "ask" });
    expect(b.session().peerCalls).toEqual([{ op: "inbound", value: "hold" }]);
  });

  // MARK: r2-peers — auto is the default; a message from a live session of the user's runs on arrival, a review waiting too.
  it("auto (the default) runs a held message from a live session of the user's at once — while a review waits too, keeping its A — with the sender on it", async () => {
    const { h, dir, id } = await opened({ env: { CLAUDE_CONFIG_DIR: liveRegistry() } });
    expect(h.engine.state.session.peerInbound).toBe("auto");
    await h.engine.handle({ type: "send", text: "edit" });
    write(dir, "README.md", "x\n");
    h.session().emitTurnEnd({ sessionId: id });
    await h.waitFor((x) => x.gate.phase === "reviewing", "reviewing");
    const before = h.engine.state.changedFiles.map((f) => f.path);
    h.session().emit(held("P1", { from: LIVE_FROM }));
    await h.waitFor(() => h.session().peerCalls.length === 1, "auto accept while reviewing");
    expect(h.session().peerCalls[0]).toMatchObject({ op: "release", ids: ["P1"] });
    const m = await h.waitFor((x) => x.session.peerInbox?.[0]?.state === "delivering", "delivering");
    expect(m.session.peerInbox![0]!.sender).toMatchObject({ pid: LIVE_PID, name: "acme-b4", sessionId: "term" });
    // The answer to a standing review keeps its A: README.md stays in the next review.
    h.session().emit({ type: "peer_delivered", messageUuid: "P1", owned: true, origin: { from: LIVE_FROM, name: "acme-b4", verifiedPeerPid: LIVE_PID, body: "#42 리뷰 끝났어" } });
    h.session().emitTurnEnd({ sessionId: id });
    const after = await h.waitFor((x) => x.gate.phase === "reviewing" && !x.session.peerTurn, "the peer turn collected");
    expect(after.changedFiles.map((f) => f.path)).toEqual(before);
    expect(rowsOf(dir, id).find((r) => r.kind === "peer_message")).toMatchObject({ state: "delivered", body: "#42 리뷰 끝났어", turn: 2 });
  });

  it("auto leaves a message the registry cannot vouch for to the user — and everything held with it (the CLI releases all at once)", async () => {
    const { h } = await opened({ env: { CLAUDE_CONFIG_DIR: liveRegistry() } });
    h.session().emit(held("P1")); // an address no live session lists
    await h.settle();
    await new Promise((r) => setTimeout(r, 100));
    expect(h.session().peerCalls).toEqual([]);
    expect(h.engine.state.session.peerInbox!.map((m) => [m.id, m.state, m.sender ?? null])).toEqual([["P1", "held", null]]);
    // A message from a live session held next to it waits too.
    h.session().emit(held("P2", { from: LIVE_FROM }));
    await h.waitFor((x) => x.session.peerInbox?.find((m) => m.id === "P2")?.sender !== undefined, "P2 verified");
    await new Promise((r) => setTimeout(r, 50));
    expect(h.session().peerCalls).toEqual([]);
    // The user's answer takes both.
    await h.engine.request({ type: "peer_accept", ids: ["P1", "P2"] });
    expect(h.session().peerCalls).toEqual([expect.objectContaining({ op: "release", ids: ["P1", "P2"] })]);
  });

  it("ask (a project's own choice) never runs one by itself; switching the project to auto runs what is held", async () => {
    const { h } = await opened({ env: { CLAUDE_CONFIG_DIR: liveRegistry() } });
    await h.engine.request({ type: "peer_set", mode: "ask" });
    h.session().emit(held("P1", { from: LIVE_FROM }));
    await h.waitFor((x) => x.session.peerInbox?.[0]?.sender !== undefined, "verified");
    await new Promise((r) => setTimeout(r, 50));
    expect(h.session().peerCalls.filter((c) => c.op === "release")).toEqual([]);
    await h.engine.request({ type: "peer_set", mode: "auto" });
    await h.waitFor(() => h.session().peerCalls.some((c) => c.op === "release"), "released once auto");
  });

  it("auto does not retry a release that failed: the message waits for the user (no loop of attempts)", async () => {
    const { h } = await opened({ env: { CLAUDE_CONFIG_DIR: liveRegistry() } }, { peerInbound: "auto" });
    h.session().releaseResult = new Error("no held peer message was released within 3000 ms");
    h.session().emit(held("P1", { from: LIVE_FROM }));
    await h.waitFor(() => h.session().peerCalls.length === 1, "one automatic attempt");
    await new Promise((r) => setTimeout(r, 100));
    expect(h.session().peerCalls).toHaveLength(1);
    expect(h.engine.state.session.peerInbox!.map((m) => m.state)).toEqual(["held"]);
    // The user can still accept it.
    h.session().releaseResult = null;
    await h.engine.request({ type: "peer_accept" });
    expect(h.session().peerCalls).toHaveLength(2);
  });
});

describe("turns the CLI runs that are not ours (§29, audit peer-03 / peer-04)", () => {
  it("an external turn closes the input: canSend false (blockedReason running), send refused gate_closed:external_turn; open again after it", async () => {
    const { h } = await opened();
    h.session().emit({ type: "external_turn", running: true, commandUuid: "X" });
    await h.settle();
    let s = h.engine.state;
    expect(s.session.externalTurn).toEqual({ commandUuid: "X", since: expect.any(String), peer: null });
    expect(s.gate.canSend).toBe(false);
    expect(s.gate.blockedReason).toBe("running");
    await expect(h.engine.request({ type: "send", text: "hi" })).rejects.toThrow("gate_closed:external_turn");
    h.session().emit({ type: "external_turn", running: false, commandUuid: "X" });
    await h.settle();
    s = h.engine.state;
    expect(s.session.externalTurn).toBeNull();
    expect(s.gate.canSend).toBe(true);
  });

  it("a peer message an older CLI delivered by itself is a card (peer_message unprompted + row), not the unprompted banner", async () => {
    const { h, dir, id } = await opened();
    h.session().emit({ type: "external_turn", running: true, commandUuid: "P" });
    h.session().emit(delivered("P", "4113 끝냈으니 리뷰 이어가", false));
    await h.settle();
    expect(h.engine.state.session.externalTurn).toMatchObject({ commandUuid: "P", peer: { from: FROM, fromName: "acme-b4", verifiedPeerPid: 76616 } });
    h.session().emit({ type: "text_delta", text: "리뷰를 이어가려면 허락이 필요해요." });
    h.session().emit({ type: "unprompted_denied", toolName: "Write" });
    h.session().emit({ type: "unprompted_turn_end", sessionId: id });
    h.session().emit({ type: "external_turn", running: false, commandUuid: "P" });
    await h.settle();
    expect(h.ofType("peer_message")).toEqual([{ type: "peer_message", message: { id: "P", from: FROM, fromName: "acme-b4", verifiedPeerPid: 76616, cause: null, receivedAt: expect.any(String), state: "delivered", body: "4113 끝냈으니 리뷰 이어가", unprompted: true } }]);
    expect(h.ofType("error").filter((e) => e.message === UNPROMPTED_NOTICE)).toEqual([]);
    expect(h.engine.state.lastError).toBeNull();
    expect(rowsOf(dir, id).map((r) => [r.kind, r.unprompted ?? false])).toEqual([["peer_message", true], ["assistant_text", true]]);
    // A plain unprompted turn (no peer) still raises the banner.
    h.session().emit({ type: "unprompted_denied", toolName: "Edit" });
    await h.settle();
    expect(h.ofType("error").filter((e) => e.message === UNPROMPTED_NOTICE)).toHaveLength(1);
  });
});

describe("side questions never take peer messages (§29, audit peer-06)", () => {
  it("their CLI refuses them through the flag settings", () => {
    const o: SideQueryOptions = {
      cwd: "/tmp/p", claudePath: "/nonexistent/claude", env: {}, platform: { killTree: async () => undefined, isWindows: false },
      settingSources: ["project"], flagSettings: { disableAllHooks: true }, prompt: "Q?", allowWeb: true, emit: () => {}, log: () => {},
    };
    expect(new SideQuery(o).queryOptions().settings).toEqual({ disableAllHooks: true, crossSessionInbound: "refuse" });
    expect(new SideQuery({ ...o, flagSettings: undefined }).queryOptions().settings).toEqual({ crossSessionInbound: "refuse" });
  });
});
