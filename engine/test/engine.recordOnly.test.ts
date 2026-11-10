import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_FILE } from "../src/review/persist.js";
import type { SideQueryOptions, SideQueryResult } from "../src/side/sideQuery.js";
import type { SideQueryLike } from "../src/side/threads.js";
import { sessionsIndexPath, sessionTranscriptPath, type SessionsIndexFile } from "../src/review/sessions.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §35.4 (wave-2 follow-up of §30): a chat Claude Code could not resume (`resumeFailed`) is a record.
 * Opening it again — `session_open`, the app reopening on it, `restart_session` there — never `--resume`s it: its rows
 * are replayed and the CLI starts fresh under a new id, so nothing appears in the list; the first turn started there
 * goes to ONE new chat with that id, the record stays as it was. Before, every opening resumed it, failed again and
 * made one more "New chat".
 */

const OLD = "0b3c8f0e-9d5e-4f1e-8b7a-0c4a9d2e1f00";
const CUR = "7e1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b";
const OLD_ROWS = [
  { at: "2026-08-01T00:00:00.000Z", turn: 1, kind: "user_message", text: "do the thing" },
  { at: "2026-08-01T00:10:00.000Z", turn: 1, kind: "assistant_text", text: "done" },
];

const gitDir = (dir: string) => join(dir, ".git");
const readIndex = (dir: string) => JSON.parse(readFileSync(sessionsIndexPath(gitDir(dir)), "utf8")) as SessionsIndexFile;
const fileRows = (dir: string, id: string) =>
  readFileSync(sessionTranscriptPath(gitDir(dir), id), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

/** A project with the record `OLD` (its CLI conversation is gone) and the chat `CUR`; `current` is the one the app had open. */
function makeRepo(current: string): string {
  const dir = realpathSync(makeTempDir("rg-recordonly"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  mkdirSync(join(gitDir(dir), "reviewgate", "sessions"), { recursive: true });
  writeFileSync(join(gitDir(dir), SESSION_FILE), JSON.stringify({ version: 1, sessionId: current, openTabIds: [CUR, OLD], permissionMode: "default", savedAt: "2026-10-20T12:25:46.000Z" }));
  const sessions = [
    { id: OLD, title: "old work", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T01:00:00.000Z", turns: 2, costUSD: 0.5, lastUserText: "keep going", resumeFailed: true },
    { id: CUR, title: "current", createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", turns: 1, costUSD: 0.1, lastUserText: "hi", cliKnown: true },
  ];
  writeFileSync(sessionsIndexPath(gitDir(dir)), JSON.stringify({ version: 1, sessions }));
  writeFileSync(sessionTranscriptPath(gitDir(dir), OLD), OLD_ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
function harness(...args: Parameters<typeof makeHarness>): Harness {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function openedOn(current: string): Promise<{ h: Harness; dir: string }> {
  const dir = makeRepo(current);
  dirs.push(dir);
  const h = harness();
  await h.hello();
  await h.open(dir);
  return { h, dir };
}

/** session_open of the record; resolves once its fresh CLI is up. */
async function openRecord(h: Harness): Promise<string> {
  const before = h.sessions.length;
  await h.engine.request({ type: "session_open", sessionId: OLD });
  await h.waitFor((x) => x.session.open && !x.session.starting && h.sessions.length === before + 1, "record-only start");
  return h.session().opts.settings.sessionId!;
}

describe("a chat Claude Code could not resume opens as a record (§35.4)", () => {
  it("session_open replays its rows and starts the CLI fresh under a new id: no resume, no new chat, no notice", async () => {
    const { h } = await openedOn(CUR);
    expect(h.session().opts.settings.resumeSessionId).toBe(CUR);
    const next = await openRecord(h);
    expect(h.session().opts.settings.resumeSessionId).toBeUndefined();
    expect([OLD, CUR]).not.toContain(next);
    await h.settle();
    const s = h.engine.state;
    expect(s.sessions.currentId).toBe(OLD);
    expect(s.sessions.list.map((m) => m.id).sort()).toEqual([OLD, CUR].sort());
    expect(h.ofType("transcript_restore").at(-1)!.items).toEqual(OLD_ROWS);
    expect(h.ofType("error")).toEqual([]);
    expect(s.gate.canSend).toBe(true);
  });

  it("the first message sent from it goes to one new chat with that id; the record stays as it was; the next message stays there", async () => {
    const { h, dir } = await openedOn(CUR);
    const next = await openRecord(h);
    const restoresBefore = h.ofType("transcript_restore").length;
    await h.engine.request({ type: "send", text: "start over" });
    let s = h.engine.state;
    expect(s.sessions.currentId).toBe(next);
    expect(s.sessions.openTabIds).toEqual([CUR, OLD, next]);
    expect(s.sessions.list.find((m) => m.id === next)).toMatchObject({ title: "start over", lastUserText: "start over", turns: 0 });
    expect(s.sessions.list.find((m) => m.id === OLD)).toMatchObject({ title: "old work", turns: 2, lastUserText: "keep going", resumeFailed: true });
    expect(h.session().sends.map((x) => x.text)).toEqual(["start over"]);
    // The new chat's (empty) transcript is bound before its first row.
    const restore = h.ofType("transcript_restore");
    expect(restore.length).toBe(restoresBefore + 1);
    expect(restore.at(-1)!.items).toEqual([]);
    const at = (ev: unknown) => h.events.indexOf(ev as never);
    expect(at(restore.at(-1))).toBeLessThan(at(h.ofType("user_message").at(-1)));
    expect(h.ofType("user_message").map((m) => [m.text, m.turn])).toEqual([["start over", 1]]);

    h.session().emitTurnEnd({ sessionId: next });
    await h.waitFor((x) => x.hud.turnCount === 1 && x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn end");
    await h.engine.request({ type: "send", text: "and more" });
    s = h.engine.state;
    expect(s.sessions.currentId).toBe(next);
    expect(s.sessions.list).toHaveLength(3);
    expect(h.sessions).toHaveLength(2);
    expect(h.session().sends.map((x) => x.text)).toEqual(["start over", "and more"]);
    await h.settle();
    expect(fileRows(dir, OLD)).toEqual(OLD_ROWS);
    expect(fileRows(dir, next).filter((r) => r.kind === "user_message").map((r) => r.text)).toEqual(["start over", "and more"]);
  });

  it("the app reopening on it and restart_session there start fresh again: the record is never resumed, nothing is created", async () => {
    const { h, dir } = await openedOn(OLD);
    expect(h.sessions).toHaveLength(1);
    expect(h.session().opts.settings.resumeSessionId).toBeUndefined();
    const next = h.session().opts.settings.sessionId!;
    expect([OLD, CUR]).not.toContain(next);
    await h.settle();
    expect(h.engine.state.sessions.currentId).toBe(OLD);
    expect(h.ofType("transcript_restore").at(-1)!.items).toEqual(OLD_ROWS);

    await h.engine.request({ type: "restart_session" });
    await h.waitFor((x) => x.session.open && !x.session.starting && h.sessions.length === 2, "restarted");
    expect(h.session().opts.settings.resumeSessionId).toBeUndefined();
    expect(h.session().opts.settings.sessionId).toBe(next);
    await h.settle();
    const s = h.engine.state;
    expect(s.sessions.currentId).toBe(OLD);
    expect(s.sessions.list.map((m) => m.id).sort()).toEqual([OLD, CUR].sort());
    expect(h.ofType("error")).toEqual([]);
    expect(readIndex(dir).sessions.map((m) => m.id).sort()).toEqual([OLD, CUR].sort());
  });

  it("a turn the CLI starts by itself goes to the new chat too: the record is never renamed to the id the CLI reports", async () => {
    const { h, dir } = await openedOn(OLD);
    // An older CLI that runs a peer message by itself reports its session first (system/init), here even another id.
    h.session().emitSessionInfo({ sessionId: "cli-own-id" });
    await h.settle();
    const s = h.engine.state;
    expect(s.sessions.currentId).toBe("cli-own-id");
    expect(s.sessions.list.find((m) => m.id === OLD)).toMatchObject({ title: "old work", resumeFailed: true });
    expect(s.sessions.list.map((m) => m.id).sort()).toEqual([OLD, CUR, "cli-own-id"].sort());
    expect(fileRows(dir, OLD)).toEqual(OLD_ROWS);
  });

  it("a side question there starts fresh: there is no conversation to fork (before, it forked the record and failed)", async () => {
    const dir = makeRepo(OLD);
    dirs.push(dir);
    const sides: SideQueryOptions[] = [];
    const h = harness({
      sideQueryFactory: (o): SideQueryLike => {
        sides.push(o);
        return {
          run: async (): Promise<SideQueryResult> => {
            o.emit({ type: "session", sessionId: "side-1" });
            return { sessionId: "side-1", text: "answer", costUSD: 0, durationMs: 1, stopReason: "success", error: null, sawOutput: true };
          },
          interrupt: async () => undefined,
          dispose: async () => undefined,
        };
      },
    });
    await h.hello();
    await h.open(dir);
    await h.engine.request({ type: "side_ask", question: "what was this chat about?" });
    expect(sides).toHaveLength(1);
    expect(sides[0]!.forkFrom).toBeUndefined();
    expect(sides[0]!.resume).toBeUndefined();
  });

  it("leaving it before sending creates nothing; session_new there is an ordinary new chat", async () => {
    const { h } = await openedOn(CUR);
    await openRecord(h);
    await h.engine.request({ type: "session_open", sessionId: CUR });
    await h.waitFor((x) => x.session.open && !x.session.starting && x.sessions.currentId === CUR && h.sessions.length === 3, "back");
    expect(h.session().opts.settings.resumeSessionId).toBe(CUR);
    expect(h.engine.state.sessions.list).toHaveLength(2);
    await openRecord(h);
    await h.engine.request({ type: "session_new" });
    const s = await h.waitFor((x) => x.session.open && !x.session.starting && x.sessions.currentId !== OLD && h.sessions.length === 5, "new chat");
    expect(s.sessions.list).toHaveLength(3);
    expect(h.session().opts.settings.sessionId).toBe(s.sessions.currentId);
  });
});
