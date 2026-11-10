import { afterEach, describe, expect, it, vi } from "vitest";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { GitCheckpoint } from "../src/git/checkpoint.js";
import type { EngineEvent, FileWhy, LiveChangesEvent } from "../src/protocol.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-why"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "src/Svc.java", "class Svc {\n  int a = 1;\n  void run() { repo.find(id).orElseThrow(); }\n}\n");
  write(dir, "README.md", "readme\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

/** A harness on a fresh repo with a controllable clock. */
async function setup(): Promise<{ h: Harness; dir: string; clock: { t: number } }> {
  const dir = makeRepo();
  const clock = { t: 1_700_000_000_000 };
  const h = makeHarness({ now: () => clock.t });
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  return { h, dir, clock };
}

const live = (h: Harness) => h.engine.request({ type: "live_changes" }) as Promise<LiveChangesEvent>;

describe("live_changes / live_diff / hud.turnFiles (§34.6)", () => {
  it("lists the running turn's changes so far against its own start tree; nothing between turns", async () => {
    const { h, dir } = await setup();
    expect(await live(h)).toMatchObject({ type: "live_changes", running: false, turn: null, baseTree: null, liveTree: null, files: [] });
    await h.engine.handle({ type: "send", text: "fix the service" });
    const s = h.session();
    s.emit({ type: "tool_use", id: "e1", name: "Edit", input: { file_path: join(dir, "src/Svc.java") }, file: join(dir, "src/Svc.java"), rationale: "Add the guard.", rationaleSource: "same_message", rationaleAge: 0 });
    write(dir, "src/Svc.java", "class Svc {\n  int a = 1;\n  void run() { repo.find(id).orElseThrow(NotFound::new); }\n}\n");
    s.emit({ type: "tool_result", toolUseId: "e1", isError: false, preview: "ok" });
    write(dir, "package-lock.json", "{}\n");
    await h.settle();
    // The new count went out with a state snapshot of its own (no other event of the turn touched the state).
    expect(h.states.at(-1)!.hud.turnFiles).toBe(1);
    expect(h.engine.state.hud.turnFiles).toBe(1);
    const ev = await live(h);
    const start = h.engine.state.gate.turnStartTree;
    expect(ev).toMatchObject({ running: true, turn: 1, baseTree: start });
    expect(ev.liveTree).toMatch(/^[0-9a-f]{40}$/);
    expect(ev.files).toEqual([
      { path: "package-lock.json", oldPath: null, status: "A", added: 1, deleted: 0, isBinary: false, inReview: false, generated: "lockfile" },
      { path: "src/Svc.java", oldPath: null, status: "M", added: 1, deleted: 1, isBinary: false, inReview: false },
    ]);
    const d = await h.engine.request({ type: "live_diff", path: "src/Svc.java" });
    expect(d).toMatchObject({ type: "file_diff", scope: "live", path: "src/Svc.java", truncated: false, baseTree: start, endTree: ev.liveTree });
    const add = d.diff.hunks.flatMap((x) => x.lines).find((l) => l.kind === "add")!;
    expect(add.segments!.map(([a, b]) => add.text.slice(a, b))).toEqual(["NotFound::new"]);
    await expect(h.engine.request({ type: "live_diff", path: "README.md" })).rejects.toThrow("not_a_live_file:README.md");
    s.emitTurnEnd({ toolFiles: [{ path: join(dir, "src/Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] }] });
    await h.waitFor((st) => st.gate.phase === "reviewing", "reviewing");
    expect(h.engine.state.hud.turnFiles).toBe(0);
    expect(await live(h)).toMatchObject({ running: false, files: [] });
    await expect(h.engine.request({ type: "live_diff", path: "src/Svc.java" })).rejects.toThrow("no_live_turn");
    // The next turn on the standing review: the reviewed file is marked inReview.
    await h.engine.handle({ type: "send", text: "and the readme" });
    write(dir, "src/Svc.java", "class Svc {\n  int a = 22;\n  void run() { repo.find(id).orElseThrow(NotFound::new); }\n}\n");
    const next = await live(h);
    expect(next.files.find((f) => f.path === "src/Svc.java")).toMatchObject({ inReview: true, added: 1, deleted: 1 });
  });

  it("refused without a project", async () => {
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await expect(live(h)).rejects.toThrow("no_project");
  });

  it("cost: one snapshot per 2 s at most, a post-Bash snapshot for free, a new one only after a write", async () => {
    const { h, dir, clock } = await setup();
    await h.engine.handle({ type: "send", text: "go" });
    const s = h.session();
    const spy = vi.spyOn(GitCheckpoint.prototype, "snapshot");
    write(dir, "a.txt", "a\n");
    const first = await live(h);
    for (let i = 0; i < 5; i++) await live(h);
    expect(spy).toHaveBeenCalledTimes(1);
    // Read-only calls do not make the tree stale, even 20 s later.
    s.emit({ type: "tool_use", id: "r1", name: "Read", input: { file_path: join(dir, "a.txt") }, file: join(dir, "a.txt") });
    s.emit({ type: "tool_result", toolUseId: "r1", isError: false, preview: "a" });
    clock.t += 20_000;
    expect((await live(h)).liveTree).toBe(first.liveTree);
    expect(spy).toHaveBeenCalledTimes(1);
    // A Bash call's post-hook snapshot is reused as the live tree.
    s.emit({ type: "tool_use", id: "b1", name: "Bash", input: { command: "echo b > b.txt" } });
    write(dir, "b.txt", "b\n");
    const cp = new GitCheckpoint(dir);
    const bashTree = await cp.snapshot();
    spy.mockClear();
    s.emit({ type: "bash_snapshot", toolUseId: "b1", tree: bashTree, root: dir });
    s.emit({ type: "tool_result", toolUseId: "b1", isError: false, preview: "" });
    clock.t += 10_000;
    const afterBash = await live(h);
    expect(afterBash.liveTree).toBe(bashTree);
    expect(afterBash.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(spy).not.toHaveBeenCalled();
    // An edit lands: past the 2 s window a new snapshot is taken.
    s.emit({ type: "tool_use", id: "e1", name: "Write", input: { file_path: join(dir, "c.txt") }, file: join(dir, "c.txt") });
    write(dir, "c.txt", "c\n");
    s.emit({ type: "tool_result", toolUseId: "e1", isError: false, preview: "ok" });
    clock.t += 2_001;
    expect((await live(h)).files.map((f) => f.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(spy).toHaveBeenCalledTimes(1);
    // A snapshot of another repository (a nested one) is never taken for this one's.
    s.emit({ type: "bash_snapshot", toolUseId: "b2", tree: "0".repeat(40), root: join(dir, "nested") });
    expect((await live(h)).liveTree).not.toBe("0".repeat(40));
  });
});

describe("why, detail and lastTest at the collection (§34.7–§34.9)", () => {
  it("changedFiles[].why / generated / whitespaceOnly, turn_summary.whyDetail and lastTest; tool_use carries the rationale source", async () => {
    const { h, dir } = await setup();
    await h.engine.handle({ type: "send", text: "fix" });
    const s = h.session();
    s.emit({ type: "text_delta", text: "I'll add the guard first." });
    s.emit({ type: "tool_use", id: "e1", name: "Edit", input: { file_path: join(dir, "src/Svc.java") }, file: join(dir, "src/Svc.java"), rationale: "I'll add the guard first.", rationaleSource: "same_message", rationaleAge: 0 });
    write(dir, "src/Svc.java", "class Svc {\n    int a = 1;\n  void run() { repo.find(id).orElseThrow(); }\n}\n");
    s.emit({ type: "tool_result", toolUseId: "e1", isError: false, preview: "ok" });
    s.emit({ type: "tool_use", id: "t1", name: "Bash", input: { command: "./mvn-ci.sh -q -o test" }, rationale: "I'll add the guard first.", rationaleSource: "earlier", rationaleAge: 1 });
    s.emit({ type: "tool_result", toolUseId: "t1", isError: false, preview: "", testOutcome: "pass" });
    s.emit({ type: "tool_use", id: "w1", name: "Write", input: { file_path: join(dir, "package-lock.json") }, file: join(dir, "package-lock.json") });
    write(dir, "package-lock.json", "{}\n");
    s.emit({ type: "tool_result", toolUseId: "w1", isError: false, preview: "ok" });
    s.emit({ type: "text_delta", text: "\n\nDone.\n- `src/Svc.java`: indentation only, for the guard.\n" });
    s.emitTurnEnd({
      toolFiles: [
        { path: join(dir, "src/Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] },
        { path: join(dir, "package-lock.json"), tools: ["Write"], count: 1, toolUseIds: ["w1"] },
      ],
    });
    await h.waitFor((st) => st.gate.phase === "reviewing", "reviewing");
    await h.settle();
    const files = Object.fromEntries(h.engine.state.changedFiles.map((f) => [f.path, f]));
    expect(files["src/Svc.java"]).toMatchObject({ whitespaceOnly: true, why: { text: "indentation only, for the guard.", source: "reported", turn: 1 } });
    expect(files["src/Svc.java"]).not.toHaveProperty("generated");
    expect(files["package-lock.json"]).toMatchObject({ generated: "lockfile", why: { text: null, source: "none", turn: 1 } });
    const sum = h.ofType("turn_summary")[0]!;
    expect(sum.files.find((f) => f.path === "src/Svc.java")).toMatchObject({ why: "indentation only, for the guard.", whyToolUseId: null, whyDetail: files["src/Svc.java"]!.why });
    expect(sum.lastTest).toEqual({ verdict: "pass", command: "./mvn-ci.sh -q -o test", toolUseId: "t1", at: new Date(1_700_000_000_000).toISOString(), afterLastEdit: false, runs: 1 });
    // The rationale's source reaches the wire and the transcript row as is.
    const use = h.ofType("tool_use").find((u) => u.id === "t1")!;
    expect([use.rationaleSource, use.rationaleAge]).toEqual(["earlier", 1]);
  });

  it("a subagent's report explains the file it changed; agentReport never reaches the wire", async () => {
    const { h, dir } = await setup();
    await h.engine.handle({ type: "send", text: "delegate" });
    const s = h.session();
    s.emit({ type: "tool_use", id: "ag", name: "Agent", input: { description: "fix", subagent_type: "executor", prompt: "x" }, rationale: "executor에게 맡기겠습니다.", rationaleSource: "same_message", rationaleAge: 0 });
    s.emit({ type: "tool_use", id: "s1", name: "Edit", input: { file_path: join(dir, "src/Svc.java") }, file: join(dir, "src/Svc.java"), parentToolUseId: "ag", rationale: "The cart is unchecked.", rationaleSource: "same_message", rationaleAge: 0 });
    write(dir, "src/Svc.java", "class Svc {\n  int a = 22;\n  void run() { repo.find(id).orElseThrow(); }\n}\n");
    s.emit({ type: "tool_result", toolUseId: "s1", isError: false, preview: "ok", parentToolUseId: "ag" });
    s.emit({ type: "tool_result", toolUseId: "ag", isError: false, preview: "Svc.java: a = 2 …", agentReport: "Changed Svc.java: a is 2 now, as the spec says." });
    s.emitTurnEnd({ toolFiles: [{ path: join(dir, "src/Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["s1"] }] });
    await h.waitFor((st) => st.gate.phase === "reviewing", "reviewing");
    const why = h.engine.state.changedFiles[0]!.why as FileWhy;
    expect(why).toEqual({ text: "Changed Svc.java: a is 2 now, as the spec says.", source: "reported", agent: { toolUseId: "ag", subagentType: "executor" }, delegation: "executor에게 맡기겠습니다.", turn: 1 });
    const wire = h.events.filter((e): e is Extract<EngineEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(wire.every((e) => !("agentReport" in e))).toBe(true);
  });

  it("why survives a question turn that leaves the file alone, and a restart", async () => {
    const { h, dir } = await setup();
    await h.engine.handle({ type: "send", text: "fix" });
    let s = h.session();
    s.emit({ type: "tool_use", id: "e1", name: "Edit", input: { file_path: join(dir, "src/Svc.java") }, file: join(dir, "src/Svc.java"), rationale: "Bump a.", rationaleSource: "same_message", rationaleAge: 0 });
    write(dir, "src/Svc.java", "class Svc {\n  int a = 333;\n  void run() { repo.find(id).orElseThrow(); }\n}\n");
    s.emit({ type: "tool_result", toolUseId: "e1", isError: false, preview: "ok" });
    s.emitTurnEnd({ toolFiles: [{ path: join(dir, "src/Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] }] });
    await h.waitFor((st) => st.gate.phase === "reviewing", "reviewing");
    const first = h.engine.state.changedFiles[0]!.why;
    expect(first).toEqual({ text: "Bump a.", source: "same_message", toolUseId: "e1", turn: 1 });
    // A question turn: README changes, Svc.java does not — its why is kept, README's is this turn's.
    await h.engine.handle({ type: "send", text: "why a = 3?" });
    s = h.session();
    s.emit({ type: "text_delta", text: "Because README.md says so." });
    write(dir, "README.md", "readme\nmore\n");
    s.emitTurnEnd({});
    await h.waitFor((st) => st.gate.phase === "reviewing" && st.hud.turnCount === 2, "merged review");
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual(["README.md", "src/Svc.java"]);
    const by = Object.fromEntries(h.engine.state.changedFiles.map((f) => [f.path, f.why]));
    expect(by["src/Svc.java"]).toEqual(first);
    expect(by["README.md"]).toEqual({ text: "Because README.md says so.", source: "reported", turn: 2 });
    // A restart restores the review with the persisted why.
    await h.engine.dispose();
    harnesses.splice(harnesses.indexOf(h), 1);
    const h2 = makeHarness();
    harnesses.push(h2);
    await h2.hello();
    await h2.open(dir);
    await h2.waitFor((st) => st.changedFiles.length === 2, "restored");
    const restored = Object.fromEntries(h2.engine.state.changedFiles.map((f) => [f.path, f.why]));
    expect(restored["src/Svc.java"]).toEqual(first);
  });

  it("settings.testCommandPatterns reach the session live", async () => {
    const { h } = await setup();
    const s = h.session();
    expect(s.opts.testCommandPatterns?.()).toEqual([]);
    await h.engine.handle({ type: "set_settings", settings: { testCommandPatterns: ["./ci.sh *", 7 as unknown as string] } });
    expect(s.opts.testCommandPatterns?.()).toEqual(["./ci.sh *"]);
  });
});
