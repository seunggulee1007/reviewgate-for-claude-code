import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineEvent, ReviewState } from "../src/protocol.js";
import { makeHarness, testSettings, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, write } from "./helpers/repo.js";

/**
 * Golden wire fixtures consumed by the Swift `EngineProtocolTests` (docs/M9-PLAN.md §3). Every
 * variable field is pinned (fixed commit date, fixed clock, paths rewritten to `/repo`), so the
 * JSON is byte-stable across machines. Regenerate with `UPDATE_WIRE_FIXTURES=1 npm test -w engine`.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "wire");
const FIXED_DATE = "2026-01-02T03:04:05Z";

function makeRepo(): string {
  const dir = join(realpathSync(makeTempDir("rg-wire")), "repo"); // fixed basename → deterministic `project.name`
  mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\nline3\n");
  write(dir, "other.txt", "other\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

/** `root` → `/repo` in every string; on Windows the native `C:\\…\\repo\\x` tail also gets `/` (the goldens are POSIX). */
function pinPaths<T>(value: T, root: string): T {
  let json = JSON.stringify(value);
  for (const form of new Set([root, JSON.stringify(root).slice(1, -1)])) json = json.split(form).join("/repo");
  json = json.replace(/\/repo((?:\\\\[^"\\]*)+)/g, (_m, tail: string) => "/repo" + tail.replace(/\\\\/g, "/"));
  return JSON.parse(json) as T;
}

function golden(name: string, actual: unknown): void {
  const file = join(FIXTURES, `${name}.json`);
  const text = JSON.stringify(actual, null, 2) + "\n";
  if (process.env.UPDATE_WIRE_FIXTURES || !existsSync(file)) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, text);
  }
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(JSON.parse(text));
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(dirname(d));
});

describe("protocol v2 wire goldens", () => {
  it("hello → ready + initial state; state/file_diff/full_file_content after a reviewed turn", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);

    const ready = await h.engine.request({ type: "hello", protocolVersion: 2, client: "test", settings: { ...testSettings } });
    expect(ready).toMatchObject({ type: "ready", protocolVersion: 2, platform: "linux", engineVersion: readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim() });
    await h.settle();
    const initial = h.states[0]!;
    expect(initial.seq).toBe(1);
    // The toolchain probe finishes asynchronously; pin it so the golden does not depend on timing.
    // §34: the goldens carry every field the engine sends (Swift's ReviewRoundWireTests strip the §34 ones to read them
    // as an older engine).
    expect(initial.hud.turnFiles).toBe(0);
    golden("state.initial", pinPaths({ ...initial, toolchain: { claude: null, gh: null, git: null, claudeVersion: null, ghVersion: null } }, dir));

    await h.open(dir);
    await h.engine.handle({ type: "send", text: "Change README" });
    h.session().emitSessionInfo();
    // One finished subagent so the golden carries a populated state.hud.agents row.
    h.session().emit({ type: "tool_use", id: "toolu_ag", name: "Agent", input: { description: "Inspect README", subagent_type: "Explore" } });
    h.session().emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "task-1", toolUseId: "toolu_ag", description: "Inspect README", subagentType: "Explore", taskType: "local_agent", isBackground: false, depth: 1 } });
    h.session().emit({ type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: join(dir, "README.md") }, file: join(dir, "README.md"), parentToolUseId: "toolu_ag", rationale: "Tighten line 2." });
    h.session().emit({ type: "agent_signal", signal: { kind: "task_notification", taskId: "task-1", toolUseId: "toolu_ag", status: "completed", summary: "Edited README", usage: { tokens: 1500, toolUses: 2, durationMs: 3000 } } });
    h.session().emit({ type: "tool_result", toolUseId: "toolu_ag", isError: false, preview: "done" });
    write(dir, "README.md", "line1\nline2 changed\nline3\nline4\n");
    write(dir, "new.txt", "brand new\n");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "README.md"), tools: ["Edit"], count: 1, toolUseIds: ["toolu_1"] }] });
    // The phase flips to reviewing before the turn's tail (HEAD / settings / nested checks, the checkpoint record, then
    // the branches and workbenches refresh) has run. Wait for its last step — the worktree is dirty now — or the golden
    // pins whichever side of that race the machine happened to land on (CI on Linux and a Mac disagreed).
    await h.waitFor((s) => s.gate.phase === "reviewing" && s.branches.isWorktreeDirty && s.workbenches.list.some((w) => w.isCurrent && w.dirty === true), "review + branches/workbenches refresh");
    await h.engine.handle({ type: "accept", paths: ["new.txt"] });
    await h.engine.handle({ type: "add_note", path: "README.md", line: 2, side: "new", excerpt: "line2 changed", body: "why?", id: "note" });
    const state = { ...h.engine.state, seq: 42 };
    expect(state.changedFiles.map((f) => f.path)).toEqual(["README.md", "new.txt"]);
    expect(state.branches.list[0]!.lastCommitDate).toBe(Date.parse(FIXED_DATE) / 1000);
    const pinned = pinPaths(state, dir);
    pinned.reviewNotes = pinned.reviewNotes.map((n) => ({ ...n, id: "note-1" }));
    // Workbenches: the managed root hashes the temp path and the lock carries pid/time; pin both.
    expect(pinned.workbenches.list.map((w) => [w.path, w.branch, w.isMain, w.isCurrent, w.locked?.pid])).toEqual([["/repo", "main", true, true, process.pid]]);
    pinned.workbenches = {
      ...pinned.workbenches,
      managedRoot: "/home/user/.reviewgate/worktrees/repo-01234567",
      list: pinned.workbenches.list.map((w) => ({ ...w, locked: w.locked ? { pid: 4242, since: FIXED_DATE, client: w.locked.client } : null })),
    };
    // Sessions (M15): the fake reports `sess-1`; timestamps are wall-clock, pin them.
    expect(pinned.sessions.currentId).toBe("sess-1");
    expect(pinned.sessions.list.map((m) => [m.id, m.title, m.turns])).toEqual([["sess-1", "Change README", 1]]);
    pinned.sessions = { ...pinned.sessions, list: pinned.sessions.list.map((m) => ({ ...m, createdAt: FIXED_DATE, updatedAt: FIXED_DATE })) };
    // Turn checkpoints (§26) carry wall-clock times too.
    expect(pinned.session.checkpoints?.map((c) => [c.turn, c.prompt, c.filesChanged, c.canRewindFiles, c.canRewindConversation])).toEqual([[1, "Change README", 2, true, true]]);
    pinned.session = { ...pinned.session, checkpoints: pinned.session.checkpoints!.map((c) => ({ ...c, startedAt: FIXED_DATE, endedAt: c.endedAt === null ? null : FIXED_DATE })) };
    // Toolchain versions come from running the binaries: the fake claude `/usr/bin/true` prints nothing
    // for `--version` on macOS but "true (GNU coreutils) 9.x" on Linux. Pin them.
    // On Windows the fake claude is node itself (testSettings.claudePath); the golden keeps the POSIX one.
    expect(pinned.toolchain.claude).toBe(testSettings.claudePath);
    pinned.toolchain = { ...pinned.toolchain, claude: "/usr/bin/true", claudeVersion: null, ghVersion: null };
    // §39.1: state.storage.disk is the test machine's volume, read after open_project (it may or may not have landed in
    // this snapshot); pin it so the golden carries a populated DiskSpace. No save failed.
    expect(pinned.storage?.saveFailed).toBeNull();
    pinned.storage = { saveFailed: null, disk: { freeBytes: 107374182400, totalBytes: 500000000000, level: "ok", at: FIXED_DATE } };
    // §34.6 / §34.8: the subagent's own call explains README.md; nothing explains new.txt.
    expect(pinned.hud.turnFiles).toBe(0);
    expect(pinned.changedFiles.map((f) => f.why)).toEqual([
      { text: "Tighten line 2.", source: "same_message", toolUseId: "toolu_1", agent: { toolUseId: "toolu_ag", subagentType: "Explore" }, turn: 1 },
      { text: null, source: "none", turn: 1 },
    ]);
    golden("state.reviewing", pinned);

    const diff = await h.engine.request({ type: "select_file", path: "README.md" });
    golden("file_diff", { ...diff, id: "req-1" });
    const full = await h.engine.request({ type: "full_file", path: "README.md" });
    golden("full_file_content", { ...full, id: "req-2" });

    // Reply correlation: exactly one reply per id, typed replies carry the id, others get `result`.
    const replies = h.events.filter((e): e is Extract<EngineEvent, { id?: string }> => "id" in e && typeof (e as { id?: string }).id === "string");
    expect(replies.filter((r) => r.id === "note")).toEqual([{ type: "result", id: "note", ok: true }]);
    expect(replies.filter((r) => r.id === diff.id).map((r) => r.type)).toEqual(["file_diff"]);
    expect(replies.filter((r) => r.id === full.id).map((r) => r.type)).toEqual(["full_file_content"]);
    expect(replies.filter((r) => r.id === ready.id).map((r) => r.type)).toEqual(["ready"]);
  });

  it("every ReviewState field is present in the initial snapshot (no undefined on the wire)", async () => {
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    const s: ReviewState = h.engine.state;
    const keys: (keyof ReviewState)[] = ["seq", "project", "gitInit", "session", "toolchain", "gate", "changedFiles", "reviewNotes", "budget", "budgetUsage", "hud", "branches", "pr", "lastError", "workbenches", "lockConflict", "commit", "sessions"];
    for (const k of keys) expect(s, k).toHaveProperty(k);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s); // no undefined-valued top-level slices
    expect(s.gate).toEqual({
      phase: "idle",
      canSend: false,
      canRequestChanges: false,
      blockedReason: "no_session",
      collectError: null,
      pendingCount: 0,
      changesRequestedCount: 0,
      isRequestingChanges: false,
      turnStartTree: null,
      turnEndTree: null,
      lastReviewSummary: null,
      changedOutside: [],
      ignoredTouched: [],
      filteredByPattern: [],
      restored: false,
      reviewSummary: { files: 0, added: 0, deleted: 0 },
      externalPendingCount: 0,
      headMoved: null,
      concurrentClaude: [],
      stale: null,
      localSettingsChanged: null,
      nestedChanges: [],
      snapshotSkipped: [],
      reviewEndTree: null,
      reviewTurns: [],
      lastTurnChanges: null,
      lastRequest: null,
      prereviews: [], // §36.13: always sent by this engine (an older one sends none: clients disable the pre-review)
    });
    expect(s.session.canRestart).toBe(false);
    expect(s.session.capabilitiesCached).toBe(false);
    expect(s.session.rememberedAllows).toEqual([]);
  });
});
