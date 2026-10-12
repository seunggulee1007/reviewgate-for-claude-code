import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent, ToolFileEntry } from "../src/session/events.js";
import { WINDOW_MARGIN_MS, type ToolWindow } from "../src/session/provenance.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/** `main` with A.java / B.java / C.java committed. */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-prov"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  for (const f of ["A.java", "B.java", "C.java"]) write(dir, f, `${f}\n`);
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

/** One Edit call of the fake session: tool_use (with a rationale), the write, the tool_result. */
function edit(h: Harness, dir: string, id: string, file: string, content: string, rationale: string): void {
  const s = h.session();
  s.emit({ type: "tool_use", id, name: "Edit", input: { file_path: join(dir, file) }, file: join(dir, file), rationale });
  write(dir, file, content);
  s.emit({ type: "tool_result", toolUseId: id, isError: false, preview: "ok" });
}

type TurnEnd = Extract<SessionEvent, { type: "turn_end" }>;

/** The session's own turn_end, with the §31 execution windows the fake's `emitTurnEnd` does not carry. */
function endTurnWith(h: Harness, toolFiles: ToolFileEntry[], toolWindows: ToolWindow[] = []): void {
  const s = h.session();
  s.turnActive = false;
  const ev: TurnEnd = {
    type: "turn_end",
    stopReason: "end_turn",
    sessionId: "sess-1",
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, durationMs: 10, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 10 },
    toolFiles,
    budget: { files: 0, lines: 0, denied: false },
    changedOutside: [],
    planFiles: [],
    toolWindows,
  };
  s.emit(ev);
  s.emit({ type: "activity", kind: "idle" });
}

const collected = (h: Harness) => h.waitFor((s) => s.gate.turnEndTree !== null && s.gate.phase !== "collecting" && s.gate.phase !== "running", "collection");

describe("origin of every changed file (§31)", () => {
  it("edit tool → tool, Bash → bash, an MCP call's window → tool, nothing → external; reject_all leaves external files alone unless includeExternal", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello({ budget: { maxFiles: 50, maxLines: 5000 } });
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "work" });
    edit(h, dir, "e1", "A.java", "A by Edit\n", "Fix A.");
    write(dir, "B.java", "B by Bash\n");
    write(dir, "C.java", "C by IntelliJ\n");
    // Outside the MCP call's window, its start margin (WINDOW_MARGIN_MS) included.
    await new Promise((r) => setTimeout(r, WINDOW_MARGIN_MS + 200));
    const start = Date.now();
    write(dir, "D.txt", "written through the IDE's MCP server\n");
    const end = Date.now();
    endTurnWith(h, [
      { path: join(dir, "A.java"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] },
      { path: join(dir, "B.java"), tools: ["Bash"], count: 1, toolUseIds: ["b1"] },
    ], [{ toolUseId: "m1", name: "mcp__idea__create_new_file", start, end }, { toolUseId: "b1", name: "Bash", start: 0, end: 1, command: "x" }]);
    const s = await collected(h);
    expect(s.changedFiles.map((f) => [f.path, f.origin, f.tools, f.toolUseIds])).toEqual([
      ["A.java", "tool", ["Edit"], ["e1"]],
      ["B.java", "bash", ["Bash"], ["b1"]],
      ["C.java", "external", [], []],
      ["D.txt", "tool", ["mcp__idea__create_new_file"], ["m1"]],
    ]);
    expect(s.gate.externalPendingCount).toBe(1);
    expect(h.ofType("turn_end").at(-1)).toMatchObject({ files: 4, external: 1 });
    expect(h.ofType("turn_summary").at(-1)!.files.map((f) => [f.path, f.origin])).toEqual([["A.java", "tool"], ["B.java", "bash"], ["C.java", "external"], ["D.txt", "tool"]]);

    // "Reject all" reverts Claude's changes only: the IDE edit stays on disk and in the review.
    await h.engine.request({ type: "reject_all" });
    let after = h.engine.state;
    expect(after.changedFiles.map((f) => [f.path, f.origin, f.state])).toEqual([["C.java", "external", "pending"]]);
    expect(read(dir, "C.java")).toBe("C by IntelliJ\n");
    expect(read(dir, "A.java")).toBe("A.java\n");
    expect(read(dir, "D.txt")).toBeNull();
    // Only an explicit choice (after the client's confirmation) reverts it.
    await h.engine.request({ type: "reject_all", includeExternal: true });
    after = h.engine.state;
    expect(after.changedFiles).toEqual([]);
    expect(read(dir, "C.java")).toBe("C.java\n");
  });

  it("an explicit reject of an external file is honoured (the client confirms first)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "work" });
    write(dir, "C.java", "C by IntelliJ\n");
    endTurnWith(h, []);
    await collected(h);
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.origin])).toEqual([["C.java", "external"]]);
    await h.engine.request({ type: "reject", paths: ["C.java"] });
    expect(read(dir, "C.java")).toBe("C.java\n");
  });

  it("a turn that ends without the session's turn_end (the CLI died) keeps the attribution its tool events gave", async () => {
    const dir = track(makeRepo());
    const h = harness({ autoRestartDelayMs: 60_000 });
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "work" });
    edit(h, dir, "e1", "A.java", "A by Edit\n", "Fix A.");
    // A failed edit is no cause.
    h.session().emit({ type: "tool_use", id: "e2", name: "Edit", input: { file_path: join(dir, "B.java") }, file: join(dir, "B.java") });
    h.session().emit({ type: "tool_result", toolUseId: "e2", isError: true, preview: "String to replace not found" });
    h.session().emit({ type: "tool_use", id: "b1", name: "Bash", input: { command: "sed -i '' s/C/c/ C.java" } });
    write(dir, "C.java", "c by Bash\n");
    h.session().emit({ type: "tool_files", toolUseId: "b1", files: [join(dir, "C.java")] });
    write(dir, "B.java", "B by IntelliJ\n");
    h.session().emit({ type: "closed", code: 1 });
    const s = await collected(h);
    expect(s.changedFiles.map((f) => [f.path, f.origin, f.toolUseIds])).toEqual([
      ["A.java", "tool", ["e1"]],
      ["B.java", "external", []],
      ["C.java", "bash", ["b1"]],
    ]);
  });

  it("a question turn merges origins: an external file Claude then edits becomes tool; untouched ones keep theirs", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "work" });
    edit(h, dir, "e1", "A.java", "A by Edit\n", "Fix A.");
    write(dir, "C.java", "C by IntelliJ\n");
    endTurnWith(h, [{ path: join(dir, "A.java"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] }]);
    await collected(h);
    await h.engine.handle({ type: "send", text: "also fix C" });
    edit(h, dir, "e2", "C.java", "C by Edit\n", "Fix C.");
    write(dir, "B.java", "B by IntelliJ\n");
    endTurnWith(h, [{ path: join(dir, "C.java"), tools: ["Edit"], count: 1, toolUseIds: ["e2"] }]);
    const s = await collected(h);
    expect(s.changedFiles.map((f) => [f.path, f.origin])).toEqual([["A.java", "tool"], ["B.java", "external"], ["C.java", "tool"]]);
  });
});

describe("HEAD / branch moved during a turn (§31)", () => {
  it("a commit or checkout made outside the app while the turn ran is reported (state + head_moved); the next turn clears it", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    const before = sh(dir, "rev-parse", "HEAD").trim();
    await h.engine.handle({ type: "send", text: "work" });
    // Someone pulls / commits in a terminal meanwhile.
    write(dir, "C.java", "C committed outside\n");
    sh(dir, "commit", "-qam", "outside");
    sh(dir, "checkout", "-q", "-b", "feature");
    const after = sh(dir, "rev-parse", "HEAD").trim();
    endTurnWith(h, []);
    await collected(h);
    // Checked right after turn_end.
    const s = await h.waitFor((x) => x.gate.headMoved != null, "headMoved");
    expect(s.gate.headMoved).toEqual({ from: { sha: before, branch: "main" }, to: { sha: after, branch: "feature" } });
    expect(h.ofType("head_moved")).toEqual([{ type: "head_moved", turn: 1, from: { sha: before, branch: "main" }, to: { sha: after, branch: "feature" } }]);

    await h.engine.handle({ type: "send", text: "next" });
    expect(h.engine.state.gate.headMoved).toBeNull();
    endTurnWith(h, []);
    await collected(h);
    await h.waitFor((x) => x.hud.turnCount === 2 && x.branches.list.length > 0, "settled");
    expect(h.engine.state.gate.headMoved).toBeNull();
    expect(h.ofType("head_moved")).toHaveLength(1);
  });
});

describe("another Claude process works in this worktree (§31)", () => {
  it("is reported when the project opens and when a message is sent (state.gate.concurrentClaude + concurrent_claude); cleared once it is gone", async () => {
    const dir = track(makeRepo());
    const config = track(realpathSync(makeTempDir("rg-conf")));
    mkdirSync(join(config, "sessions"), { recursive: true });
    // A terminal session in the same worktree: our parent (the test runner) is alive and never the engine's child, on
    // every OS — pid 1 is not a process on Windows, so its entry would be dropped as dead.
    const other = process.ppid;
    writeFileSync(join(config, "sessions", `${other}.json`), JSON.stringify({ pid: other, cwd: dir, sessionId: "term-1", name: "acme-b4", kind: "interactive", entrypoint: "cli", status: "busy" }));
    const h = harness({ env: { CLAUDE_CONFIG_DIR: config } });
    await h.hello();
    await h.open(dir);
    const opened = await h.waitFor((s) => (s.gate.concurrentClaude?.length ?? 0) > 0, "concurrent sessions");
    expect(opened.gate.concurrentClaude!.map((c) => [c.pid, c.name, c.entrypoint, c.cwd])).toEqual([[other, "acme-b4", "cli", dir]]);
    expect(h.ofType("concurrent_claude").map((e) => [e.at, e.sessions.map((c) => c.pid)])).toEqual([["open", [other]]]);

    await h.engine.handle({ type: "send", text: "work" });
    expect(h.ofType("concurrent_claude").map((e) => [e.at, e.sessions.map((c) => c.pid)])).toEqual([["open", [other]], ["send", [other]]]);

    rmSync(join(config, "sessions", `${other}.json`));
    endTurnWith(h, []);
    await collected(h);
    await h.engine.handle({ type: "send", text: "again" });
    expect(h.engine.state.gate.concurrentClaude).toEqual([]);
    expect(h.ofType("concurrent_claude")).toHaveLength(2);
  });
});

describe("request-changes follow-up keeps the cause of files it did not touch (comp-05)", () => {
  it("tools / toolUseIds of the accepted and the untouched pending file survive the rebuild; turn_summary lists the follow-up's own file", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello({ budget: { maxFiles: 50, maxLines: 5000 } });
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "change A B C" });
    edit(h, dir, "e1", "A.java", "A changed\n", "Fix A.");
    edit(h, dir, "e2", "B.java", "B changed\n", "Fix B.");
    edit(h, dir, "e3", "C.java", "C changed\n", "Fix C.");
    h.session().emitTurnEnd({ toolFiles: ["A.java", "B.java", "C.java"].map((f, i) => ({ path: join(dir, f), tools: ["Edit"], count: 1, toolUseIds: [`e${i + 1}`] })) });
    await h.waitFor((s) => s.gate.phase === "reviewing", "reviewing");

    await h.engine.request({ type: "accept", paths: ["A.java"] });
    await h.engine.request({ type: "add_note", path: "B.java", line: 1, side: "new", excerpt: "B changed", body: "다르게 해줘" });
    await h.engine.request({ type: "request_changes" });
    edit(h, dir, "e4", "B.java", "B redone\n", "Redo B.");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "B.java"), tools: ["Edit"], count: 1, toolUseIds: ["e4"] }] });
    await h.waitFor((s) => s.gate.phase === "reviewing" && !s.gate.isRequestingChanges && s.gate.turnEndTree !== null, "reviewing again");
    await h.settle();

    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state, f.tools, f.toolUseIds])).toEqual([
      ["A.java", "accepted", ["Edit"], ["e1"]],
      ["B.java", "pending", ["Edit"], ["e2", "e4"]],
      ["C.java", "pending", ["Edit"], ["e3"]],
    ]);
    // §34.3: the follow-up's summary lists what it changed itself; the merged causes stay on the files above.
    // §34.8: and the file it changed is explained by the follow-up's own call.
    expect(h.ofType("turn_summary").at(-1)!.files.map((f) => [f.path, f.toolUseIds, f.why])).toEqual([["B.java", ["e2", "e4"], "Redo B."]]);
  });
});
