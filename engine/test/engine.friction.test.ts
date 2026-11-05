import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/engine.js";
import type { ChangedFileState, EngineCommand, Settings } from "../src/protocol.js";
import type { ReviewGate } from "../src/review/gate.js";
import { capabilitiesFilePath } from "../src/review/persist.js";
import { makeHarness, testSettings, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/**
 * M16 friction fixes (docs/M16-FRICTION.md, engine part): `send {acceptPending}`, the budget defaults,
 * `gate.reviewSummary`, the capabilities cache and the session-remembered allows / `forget_allows`.
 */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-friction"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\nline3\n");
  write(dir, "other.txt", "other\n");
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
function harness(opts: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(opts);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** Runs one turn that changes README.md and adds new.txt, then waits for `reviewing`. */
async function reviewedTurn(h: Harness, dir: string): Promise<void> {
  await h.engine.handle({ type: "send", text: "Change README" });
  h.session().emitSessionInfo();
  write(dir, "README.md", "line1\nline2 changed\nline3\nline4\n");
  write(dir, "new.txt", "brand new\n");
  h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "README.md"), tools: ["Edit"], count: 1 }] });
  await h.waitFor((s) => s.gate.phase === "reviewing", "review");
  await h.settle();
}

describe("budget defaults (M16 §4, §54)", () => {
  it("DEFAULT_SETTINGS carry no change budget (0 / 0) and a hello without a budget runs without one", async () => {
    expect(DEFAULT_SETTINGS.budget).toEqual({ maxFiles: 0, maxLines: 0, hardMultiplier: 2.0 });
    expect(DEFAULT_SETTINGS.autoAllowReadOnlyBash).toBe(true);
    expect(DEFAULT_SETTINGS.bashAllowPatterns).toEqual([]);
    const h = harness();
    const { budget: _omitted, ...withoutBudget } = testSettings;
    await h.engine.handle({ type: "hello", protocolVersion: 2, client: "test", settings: withoutBudget as unknown as Settings });
    await h.settle();
    expect(h.engine.state.budget).toEqual({ maxFiles: 0, maxLines: 0, hardMultiplier: 2.0 });
    // An explicit budget still wins (an older client always sends its 10 / 400: it keeps its budget).
    await h.engine.handle({ type: "set_settings", settings: { budget: { maxFiles: 3, maxLines: 30 } } });
    await h.settle();
    expect(h.engine.state.budget).toEqual({ maxFiles: 3, maxLines: 30 });
  });

  it("the session receives autoAllowReadOnlyBash / bashAllowPatterns at start and live through set_settings", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello({ bashAllowPatterns: ["Bash(npm test:*)"] });
    await h.open(dir);
    const s = h.session();
    expect(s.opts.settings.autoAllowReadOnlyBash).toBe(true);
    expect(s.opts.settings.bashAllowPatterns).toEqual(["Bash(npm test:*)"]);
    expect(s.opts.rememberedAllows).toBeInstanceOf(Set);
    await h.engine.handle({ type: "set_settings", settings: { autoAllowReadOnlyBash: false, bashAllowPatterns: ["Bash(git *)"] } });
    expect(s.permissionSettings).toEqual([{ autoAllowReadOnlyBash: false, bashAllowPatterns: ["Bash(git *)"] }]);
  });
});

describe("gate.reviewSummary (M16 §5)", () => {
  it("sums files / added / deleted over changedFiles in every state; zeros when nothing is under review", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    const opened = await h.open(dir);
    expect(opened.gate.reviewSummary).toEqual({ files: 0, added: 0, deleted: 0 });
    await reviewedTurn(h, dir);
    let s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.added, f.deleted])).toEqual([["README.md", 2, 1], ["new.txt", 1, 0]]);
    expect(s.gate.reviewSummary).toEqual({ files: 2, added: 3, deleted: 1 });
    await h.engine.handle({ type: "accept", paths: ["new.txt"] });
    await h.settle();
    s = h.engine.state;
    expect(s.gate.reviewSummary).toEqual({ files: 2, added: 3, deleted: 1 }); // accepted files still count
    await h.engine.handle({ type: "reject", paths: ["README.md"] });
    await h.waitFor((x) => x.gate.phase !== "reverting" && !x.changedFiles.some((f) => f.path === "README.md"), "reverted");
    expect(h.engine.state.gate.reviewSummary).toEqual({ files: 1, added: 1, deleted: 0 });
  });
});

describe("send {acceptPending} (M16 §3)", () => {
  it("accepts every pending file, then sends with the accepted summary prefix", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    // The review no longer closes the input (a plain send asks a question); only `acceptPending` accepts.
    expect(h.engine.state.gate.canSend).toBe(true);
    expect(h.engine.state.gate.blockedReason).toBeNull();
    const sendsBefore = h.session().sends.length;
    await h.engine.request({ type: "send", text: "next step", acceptPending: true });
    const s = await h.waitFor((x) => x.gate.phase === "running", "running");
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "accepted"], ["new.txt", "accepted"]]);
    expect(s.gate.pendingCount).toBe(0);
    const sent = h.session().sends[sendsBefore]!.text;
    expect(sent.startsWith("[Review gate] Accepted: README.md, new.txt.")).toBe(true);
    expect(sent.endsWith("\n\nnext step")).toBe(true);
    expect(h.ofType("user_message").at(-1)).toMatchObject({ text: "next step" });
  });

  it("is refused while running and never accepts changes-requested files (a request-changes round stays untouched)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "first" });
    h.session().emitSessionInfo();
    await h.waitFor((x) => x.gate.phase === "running", "running");
    await expect(h.engine.request({ type: "send", text: "x", acceptPending: true })).rejects.toThrow("gate_closed:running");
    write(dir, "README.md", "line1\nline2 changed\nline3\n");
    write(dir, "new.txt", "brand new\n");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "README.md"), tools: ["Edit"], count: 1 }] });
    await h.waitFor((x) => x.gate.phase === "reviewing", "reviewing");
    await h.settle();
    await h.engine.handle({ type: "add_note", path: "README.md", line: 2, side: "new", excerpt: "line2 changed", body: "why?" });
    await h.engine.handle({ type: "request_changes" });
    await h.waitFor((x) => x.gate.phase === "running" && x.gate.isRequestingChanges, "request_changes running");
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "changesRequested"], ["new.txt", "pending"]]);
    const sends = h.session().sends.length;
    await expect(h.engine.request({ type: "send", text: "x", acceptPending: true })).rejects.toThrow("gate_closed:running");
    expect(h.engine.state.changedFiles.map((f) => f.state)).toEqual(["changesRequested", "pending"]); // nothing accepted by the refused send
    expect(h.session().sends.length).toBe(sends);
    h.session().emitTurnEnd({ toolFiles: [] });
    await h.waitFor((x) => x.gate.phase === "reviewing", "follow-up reviewing");
  });

  it("changes-requested files block acceptPending with gate_closed:changes_requested and nothing is accepted (white-box gate state)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    // The engine only leaves `changesRequested` files behind while a round runs or after a failed collection
    // (both outrank this reason), so the idle case is forced on the gate directly.
    const gate = (h.engine as unknown as { gate: ReviewGate }).gate;
    gate.changedFiles.find((f) => f.path === "README.md")!.state = "changesRequested";
    await h.settle();
    const sends = h.session().sends.length;
    await expect(h.engine.request({ type: "send", text: "x", acceptPending: true })).rejects.toThrow("gate_closed:changes_requested");
    expect(gate.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "changesRequested"], ["new.txt", "pending"]]);
    expect(h.session().sends.length).toBe(sends);
  });
});

/**
 * Sending a message never changes review state (docs/PROTOCOL.md §10, supersedes M16-FRICTION item 3):
 * a user who asks a question while files await review gets an answer, not a silently accepted review.
 */
describe("send while reviewing = a question (review state untouched)", () => {
  /** Runs one answer turn: `text` is sent, `edit` runs during the turn, the collection is awaited. */
  async function answerTurn(h: Harness, text: string, edit: () => void = () => {}): Promise<void> {
    await h.engine.handle({ type: "send", text });
    await h.waitFor((s) => s.gate.phase === "running", "answer running");
    edit();
    h.session().emitTurnEnd({ toolFiles: [] });
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "answer collected");
    await h.settle();
  }

  it("a plain send while reviewing is allowed and leaves every file pending (notes and A kept)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    const a = h.engine.state.gate.turnStartTree;
    await h.engine.handle({ type: "add_note", path: "README.md", line: 2, side: "new", excerpt: "line2 changed", body: "why?" });
    const sendsBefore = h.session().sends.length;

    await h.engine.handle({ type: "send", text: "why did you change line 2?" });
    const running = h.engine.state;
    expect(running.gate.phase).toBe("running");
    // Nothing was accepted, nothing left the list, the notes survive and A is NOT re-snapshotted.
    expect(running.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"], ["new.txt", "pending"]]);
    expect(running.gate.pendingCount).toBe(2);
    expect(running.reviewNotes.map((n) => n.body)).toEqual(["why?"]);
    expect(running.gate.turnStartTree).toBe(a);
    // The unsent note goes along as context ("메모 반영해줘" in the chat reaches it) and stays unsent.
    expect(h.session().sends[sendsBefore]).toEqual({
      text:
        "why did you change line 2?\n\n[Review gate] Notes the user left on the diff, not sent yet (act on them only if the message above asks):" +
        "\n- README.md:2 (new) `line2 changed` — why?",
      checkpointTree: a,
    });
    expect(running.reviewNotes[0]!.sent).toBeUndefined();
    expect(h.ofType("user_message").at(-1)).toMatchObject({ text: "why did you change line 2?" });

    h.session().emitTurnEnd({ toolFiles: [] });
    await h.waitFor((s) => s.gate.phase === "reviewing", "answer collected");
    await h.settle();
    const s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"], ["new.txt", "pending"]]);
    expect(s.reviewNotes.map((n) => n.body)).toEqual(["why?"]);
    expect(s.gate.turnStartTree).toBe(a);
    expect(s.gate.canRequestChanges).toBe(true);
  });

  it("a question turn that changes nothing leaves changedFiles byte-identical (but for §34.3's per-turn marks)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    await h.engine.handle({ type: "accept", paths: ["new.txt"] });
    await h.settle();
    // §34.3: changedThisTurn / turnAdded / turnDeleted describe the last collected turn — this one changed nothing.
    const withoutTurnMarks = (files: ChangedFileState[]) =>
      JSON.stringify(files.map(({ changedThisTurn: _c, turnAdded: _a, turnDeleted: _d, ...rest }) => rest));
    const before = withoutTurnMarks(h.engine.state.changedFiles);
    const a = h.engine.state.gate.turnStartTree;

    await answerTurn(h, "just explain, change nothing");
    expect(withoutTurnMarks(h.engine.state.changedFiles)).toBe(before);
    expect(h.engine.state.changedFiles.some((f) => f.changedThisTurn || f.turnAdded !== undefined)).toBe(false);
    expect(h.engine.state.gate.turnStartTree).toBe(a);
  });

  it("the answer turn's own changes merge into the same review against the original A", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    await h.engine.handle({ type: "accept", paths: ["new.txt"] });
    await h.settle();
    const a = h.engine.state.gate.turnStartTree;

    // The answer appends to README.md (already pending) and writes third.txt; new.txt is untouched.
    await answerTurn(h, "also add a fourth file", () => {
      write(dir, "README.md", "line1\nline2 changed\nline3\nline4\nline5\n");
      write(dir, "third.txt", "third\n");
    });
    let s = h.engine.state;
    expect(s.gate.turnStartTree).toBe(a); // same A: the diff is cumulative, not per-turn
    expect(s.gate.phase).toBe("reviewing");
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([
      ["README.md", "pending"],
      ["new.txt", "accepted"], // patch unchanged by the answer → still accepted
      ["third.txt", "pending"],
    ]);
    expect(s.changedFiles.find((f) => f.path === "README.md")?.tools).toEqual(["Edit"]); // this turn's tools merge into the old ones
    const diff = await h.engine.request({ type: "select_file", path: "README.md" });
    expect(diff.diff.hunks.flatMap((k) => k.lines.filter((l) => l.kind === "add").map((l) => l.text))).toEqual([
      "line2 changed",
      "line4",
      "line5",
    ]);

    // An accepted file the answer DOES touch goes back to pending (the request-changes patch-hash rule).
    await answerTurn(h, "and append to new.txt", () => write(dir, "new.txt", "brand new\nappended\n"));
    s = h.engine.state;
    expect(s.gate.turnStartTree).toBe(a);
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([
      ["README.md", "pending"],
      ["new.txt", "pending"],
      ["third.txt", "pending"],
    ]);
  });

  it("changes-requested files still allow a question; the request-changes round is untouched", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    const gate = (h.engine as unknown as { gate: ReviewGate }).gate;
    gate.changedFiles.find((f) => f.path === "README.md")!.state = "changesRequested";
    await h.settle();
    expect(h.engine.state.gate.canSend).toBe(true);

    await answerTurn(h, "what did you change?");
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([
      ["README.md", "changesRequested"],
      ["new.txt", "pending"],
    ]);
    expect(h.engine.state.gate.isRequestingChanges).toBe(false);
  });
});

/**
 * Release review H3: a reject during an answer / request-changes turn re-snapshotted B, after which the
 * turn's own collection was skipped and its changes never reached the review. Reverts are refused with
 * `session_running` until the turn has been collected; §34.2: an accept writes nothing and is applied at once
 * (kept only when the turn leaves the file alone).
 */
describe("review mutations while a turn runs (release review H3)", () => {
  it("reject / reject_all / reject_hunks / finish_review are refused during an answer turn, accept applies; the turn's changes still land in the review", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);

    await h.engine.handle({ type: "send", text: "also touch other.txt" });
    await h.waitFor((s) => s.gate.phase === "running", "answer running");
    write(dir, "other.txt", "other changed by the answer\n");
    const commands: EngineCommand[] = [
      { type: "reject", paths: ["new.txt"] },
      { type: "reject_all" },
      { type: "reject_hunks", path: "README.md", hunks: [0] },
      { type: "finish_review" },
    ];
    for (const cmd of commands) {
      await expect(h.engine.request(cmd), cmd.type).rejects.toThrow("session_running");
    }
    expect(read(dir, "new.txt")).toBe("brand new\n"); // nothing reverted on disk
    await h.engine.request({ type: "accept", paths: ["README.md"] });
    expect(h.engine.state.changedFiles.find((f) => f.path === "README.md")?.state).toBe("accepted");

    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "other.txt"), tools: ["Edit"], count: 1 }] });
    await h.waitFor((s) => s.gate.phase === "reviewing", "answer collected");
    await h.settle();
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([
      ["README.md", "accepted"], // the answer left it alone
      ["new.txt", "pending"],
      ["other.txt", "pending"],
    ]);
    expect(h.ofType("turn_end").at(-1)).toMatchObject({ files: 1, review: { files: 3 }, merged: true });

    // Once collected, the review is editable again.
    await h.engine.request({ type: "reject", paths: ["new.txt"] });
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([
      ["README.md", "accepted"],
      ["other.txt", "pending"],
    ]);
  });

  it("notes are refused while a change request is in flight (§34.2 keeps this rule)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    await h.engine.handle({ type: "add_note", path: "README.md", line: 2, side: "new", excerpt: "line2 changed", body: "redo this" });
    await h.engine.handle({ type: "request_changes" });
    await h.waitFor((s) => s.gate.phase === "running", "request running");
    await expect(h.engine.request({ type: "add_note", path: "new.txt", line: 1, side: "new", excerpt: "brand new", body: "x" })).rejects.toThrow("session_running");
    await expect(h.engine.request({ type: "reject", paths: ["new.txt"] })).rejects.toThrow("session_running");
    h.session().emitTurnEnd({ toolFiles: [] });
    await h.waitFor((s) => s.gate.phase === "reviewing", "request collected");
  });
});

describe("remembered allows + forget_allows (M16 §2)", () => {
  it("permission_response {remember:true} stores the key in state.session.rememberedAllows and the live set; forget_allows clears both", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "write a file" });
    const fake = h.session();
    const live = fake.opts.rememberedAllows as Set<string>;
    fake.emit({ type: "permission_request", requestId: "p1", toolName: "Bash", input: { command: "echo hi > x.txt" } });
    await h.waitFor((x) => x.session.pendingPermission?.requestId === "p1", "pending permission");
    await h.engine.handle({ type: "permission_response", requestId: "p1", allow: true, remember: true });
    await h.settle();
    expect(h.engine.state.session.rememberedAllows).toEqual(["Bash:echo hi"]);
    expect([...live]).toEqual(["Bash:echo hi"]);
    expect(fake.permissionResponses).toEqual([{ requestId: "p1", allow: true, message: undefined }]);
    // A deny with remember stores nothing; a plain allow stores nothing.
    fake.emit({ type: "permission_request", requestId: "p2", toolName: "WebFetch", input: { url: "https://x" } });
    await h.waitFor((x) => x.session.pendingPermission?.requestId === "p2", "p2");
    await h.engine.handle({ type: "permission_response", requestId: "p2", allow: false, remember: true });
    fake.emit({ type: "permission_request", requestId: "p3", toolName: "WebSearch", input: { query: "q" } });
    await h.waitFor((x) => x.session.pendingPermission?.requestId === "p3", "p3");
    await h.engine.handle({ type: "permission_response", requestId: "p3", allow: true });
    fake.emit({ type: "permission_request", requestId: "p4", toolName: "WebFetch", input: { url: "https://y" } });
    await h.waitFor((x) => x.session.pendingPermission?.requestId === "p4", "p4");
    await h.engine.handle({ type: "permission_response", requestId: "p4", allow: true, remember: true });
    await h.settle();
    expect(h.engine.state.session.rememberedAllows).toEqual(["Bash:echo hi", "WebFetch:WebFetch"]);
    // restart_session keeps the set (same live Set handed to the new session); the state mirrors it.
    fake.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn end");
    await h.engine.request({ type: "restart_session" });
    await h.waitFor((x) => x.session.open && !x.session.starting && h.sessions.length === 2, "restarted");
    expect(h.session().opts.rememberedAllows).toBe(live);
    expect(h.engine.state.session.rememberedAllows).toEqual(["Bash:echo hi", "WebFetch:WebFetch"]);
    await h.engine.request({ type: "forget_allows" });
    await h.settle();
    expect(h.engine.state.session.rememberedAllows).toEqual([]);
    expect(live.size).toBe(0);
    // open_project of another path starts from an empty set.
    live.add("Bash:stale");
    const dir2 = track(makeRepo());
    await h.open(dir2);
    expect(h.engine.state.session.rememberedAllows).toEqual([]);
    expect(h.session().opts.rememberedAllows).toBe(live);
    expect(live.size).toBe(0);
  });
});

describe("capabilities cache (M16 engine: `<gitdir>/reviewgate/capabilities.json`)", () => {
  it("session_info writes the file; the next open_project shows it as cached until fresh data arrives", async () => {
    const dir = track(makeRepo());
    const file = capabilitiesFilePath(join(dir, ".git"));
    const h = harness();
    await h.hello();
    let s = await h.open(dir);
    // §36.5: never null once a session started — empty lists without a cache (`state` ready: the fake answered initialize).
    expect(s.session.capabilities).toEqual({ slashCommands: [], skills: [], plugins: [], mcpServers: [], state: "ready" });
    expect(s.session.capabilitiesCached).toBe(false);
    expect(existsSync(file)).toBe(false);
    await h.engine.handle({ type: "send", text: "hello" });
    h.session().emitSessionInfo({ slashCommands: ["commit", "review"], skills: ["graphify"], mcpServers: [{ name: "fs", status: "connected" }] });
    s = await h.waitFor((x) => x.session.capabilities?.slashCommands.length === 2, "capabilities");
    expect(s.session.capabilitiesCached).toBe(false);
    h.session().emitTurnEnd();
    await h.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn end");
    await h.engine.handle({ type: "close_project" });
    await h.settle();
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { version: number; capabilities: unknown };
    expect(saved.version).toBe(1);
    expect(saved.capabilities).toEqual({ slashCommands: ["commit", "review"], skills: ["graphify"], plugins: ["p"], mcpServers: [{ name: "fs", status: "connected" }], pluginDetails: [{ name: "p", path: "/p", id: null }] });
    expect(h.engine.state.session.capabilities).toBeNull();

    // A new engine on the same project sees the cache in its first project state.
    const h2 = harness();
    await h2.hello();
    s = await h2.open(dir);
    expect(s.session.capabilities).toEqual({ ...(saved.capabilities as object), state: "ready" });
    expect(s.session.capabilitiesCached).toBe(true);
    const firstWithProject = h2.states.find((x) => x.project !== null)!;
    expect(firstWithProject.session.capabilities).toEqual(saved.capabilities);
    expect(firstWithProject.session.capabilitiesCached).toBe(true);
    // session_new keeps showing the cache; fresh session_info replaces it and rewrites the file.
    await h2.engine.request({ type: "session_new" });
    s = await h2.waitFor((x) => x.session.open && !x.session.starting && h2.sessions.length === 2, "new session");
    expect(s.session.capabilitiesCached).toBe(true);
    await h2.engine.handle({ type: "send", text: "hi" });
    h2.session().emitSessionInfo({ slashCommands: ["fresh"] });
    s = await h2.waitFor((x) => x.session.capabilities?.slashCommands[0] === "fresh", "fresh capabilities");
    expect(s.session.capabilitiesCached).toBe(false);
    h2.session().emitTurnEnd();
    await h2.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn end 2");
    await h2.engine.handle({ type: "close_project" });
    expect((JSON.parse(readFileSync(file, "utf8")) as { capabilities: { slashCommands: string[] } }).capabilities.slashCommands).toEqual(["fresh"]);
  });

  it("a corrupt cache file is ignored", async () => {
    const dir = track(makeRepo());
    write(dir, ".git/reviewgate/capabilities.json", "{not json");
    const h = harness();
    await h.hello();
    const s = await h.open(dir);
    expect(s.session.capabilities).toEqual({ slashCommands: [], skills: [], plugins: [], mcpServers: [], state: "ready" });
    expect(s.session.capabilitiesCached).toBe(false);
  });
});
