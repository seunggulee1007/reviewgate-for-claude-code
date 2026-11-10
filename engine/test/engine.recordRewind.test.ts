import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointFilePath, type CheckpointFile, type CheckpointRecord } from "../src/review/checkpoints.js";
import { SESSION_FILE } from "../src/review/persist.js";
import { sessionsIndexPath, sessionTranscriptPath, type SessionsIndexFile } from "../src/review/sessions.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §37.4: in a chat opened as a record (§35.4 — Claude Code no longer has its conversation), a
 * conversation rewind to a point inside that lost conversation cannot fork it. Before, the engine tried: it made a new
 * chat, the fork failed ("No conversation found"), that new chat was flagged as a record too, a resume notice came, and
 * the record got the "(되돌리기 전)" suffix — for nothing. Now those turns say `canRewindConversation: false` and the
 * rewind is refused `rewind_unavailable:conversation` before anything happens (a `both` rewind leaves the files too). A
 * point before the chat's first turn (a fresh fork) still works: there is nothing to fork.
 */

const OLD = "0b3c8f0e-9d5e-4f1e-8b7a-0c4a9d2e1f00";
const CUR = "7e1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b";
const OLD_ROWS = [
  { at: "2026-08-01T00:00:00.000Z", turn: 1, kind: "user_message", text: "first" },
  { at: "2026-08-01T00:01:00.000Z", turn: 1, kind: "assistant_text", text: "ok" },
  { at: "2026-08-01T00:02:00.000Z", turn: 2, kind: "user_message", text: "second" },
  { at: "2026-08-01T00:03:00.000Z", turn: 2, kind: "assistant_text", text: "done" },
];

const gitDir = (dir: string) => join(dir, ".git");
const readIndex = (dir: string) => JSON.parse(readFileSync(sessionsIndexPath(gitDir(dir)), "utf8")) as SessionsIndexFile;

function tree(dir: string): string {
  sh(dir, "add", "-A");
  return sh(dir, "write-tree").trim();
}

/** A project whose record `OLD` (CLI conversation gone) has two turns: turn 1 from a fresh start, turn 2 inside it. */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-recordrewind"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "a.txt", "a0\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  const t0 = tree(dir);
  write(dir, "a.txt", "a1\n");
  const t1 = tree(dir);
  write(dir, "a.txt", "a2\n");
  const t2 = tree(dir);
  sh(dir, "reset", "-q");
  const base = { kind: "turn" as const, endedAt: "2026-08-01T00:01:00.000Z", cliSessionId: OLD, lastUuid: null, modsCaptured: true as const };
  const records: CheckpointRecord[] = [
    { ...base, id: "r1", turn: 1, prompt: "first", startedAt: "2026-08-01T00:00:00.000Z", startTree: t0, endTree: t1, files: ["a.txt"], before: { mode: "fresh" } },
    { ...base, id: "r2", turn: 2, prompt: "second", startedAt: "2026-08-01T00:02:00.000Z", startTree: t1, endTree: t2, files: ["a.txt"], before: { mode: "at", sessionId: OLD, uuid: "uuid-turn-1" } },
  ];
  const file: CheckpointFile = { version: 1, records, pendingFork: null };
  mkdirSync(join(gitDir(dir), "reviewgate", "checkpoints"), { recursive: true });
  writeFileSync(checkpointFilePath(gitDir(dir), OLD), JSON.stringify(file));
  mkdirSync(join(gitDir(dir), "reviewgate", "sessions"), { recursive: true });
  writeFileSync(join(gitDir(dir), SESSION_FILE), JSON.stringify({ version: 1, sessionId: OLD, openTabIds: [CUR, OLD], permissionMode: "default", savedAt: "2026-10-20T12:25:46.000Z" }));
  const sessions = [
    { id: OLD, title: "old work", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T01:00:00.000Z", turns: 2, costUSD: 0.5, lastUserText: "second", resumeFailed: true },
    { id: CUR, title: "current", createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", turns: 1, costUSD: 0.1, lastUserText: "hi", cliKnown: true },
  ];
  writeFileSync(sessionsIndexPath(gitDir(dir)), JSON.stringify({ version: 1, sessions }));
  writeFileSync(sessionTranscriptPath(gitDir(dir), OLD), OLD_ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** The app reopens on the record: its rows, a fresh CLI. */
async function openRecord(): Promise<{ h: Harness; dir: string }> {
  const dir = makeRepo();
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  await h.waitFor((x) => x.session.open && !x.session.starting, "record-only start");
  expect(h.session().opts.settings.resumeSessionId).toBeUndefined();
  expect(h.engine.state.sessions.currentId).toBe(OLD);
  return { h, dir };
}

describe("rewinding the conversation of a record (§37.4)", () => {
  it("a turn inside the lost conversation cannot rewind it: the view says so and the rewind is refused with nothing done", async () => {
    const { h, dir } = await openRecord();
    expect(h.engine.state.session.checkpoints!.map((c) => [c.turn, c.canRewindConversation, c.canRewindFiles])).toEqual([
      [1, true, true],
      [2, false, true],
    ]);
    const sessionsBefore = h.sessions.length;
    for (const mode of ["conversation", "both"] as const) {
      const e = await h.engine.request({ type: "rewind", toTurn: 2, mode, editText: "again" }).catch((x: unknown) => x as Error & { code?: string });
      expect(String(e), mode).toMatch(/rewind_unavailable:conversation/);
    }
    await h.settle();
    // Nothing happened: no chat, no title suffix, no CLI start, no message, the files as they were.
    expect(readIndex(dir).sessions.map((m) => [m.id, m.title]).sort()).toEqual([[CUR, "current"], [OLD, "old work"]].sort());
    expect(h.engine.state.sessions.currentId).toBe(OLD);
    expect(h.sessions.length).toBe(sessionsBefore);
    expect(h.session().sends).toEqual([]);
    expect(read(dir, "a.txt")).toBe("a2\n");
    expect(h.ofType("error")).toEqual([]);
    // A files-only rewind is unaffected.
    await h.engine.request({ type: "rewind", toTurn: 2, mode: "files" });
    expect(read(dir, "a.txt")).toBe("a1\n");
  });

  it("a point before the chat's first turn still rewinds: a new chat starts fresh (nothing to fork)", async () => {
    const { h } = await openRecord();
    const before = h.sessions.length;
    await h.engine.request({ type: "rewind", toTurn: 1, mode: "conversation" });
    await h.waitFor((x) => x.session.open && !x.session.starting && h.sessions.length === before + 1, "fresh chat");
    const s = h.engine.state;
    expect(s.sessions.currentId).not.toBe(OLD);
    expect(h.session().opts.settings.resumeSessionId).toBeUndefined();
    expect(h.session().opts.settings.forkAt).toBeUndefined();
    expect(h.ofType("error")).toEqual([]);
  });
});
