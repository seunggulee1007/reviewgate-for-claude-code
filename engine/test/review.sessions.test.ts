import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SessionIndex, sessionsDir, sessionsIndexPath } from "../src/review/sessions.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

/**
 * `<gitdir>/reviewgate/sessions/index.json` (docs/PROTOCOL.md §9) is read back through `normalizeMeta`: every `SessionMeta`
 * field must survive a save and a reload — `forkedFrom` (§26, the chat a rewind forked this one from) used to be dropped.
 */

const dirs: string[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("SessionIndex (index.json)", () => {
  it("keeps forkedFrom (§26) across a save and a reload", async () => {
    const gitDir = track(makeTempDir("rg-sessions"));
    const idx = await SessionIndex.open(gitDir, null);
    const old = idx.create("old-chat", "2026-10-01T00:00:00.000Z");
    const fork = idx.create("fork-chat", "2026-10-02T00:00:00.000Z");
    fork.forkedFrom = { sessionId: old.id, turn: 3 };
    await idx.save();

    const again = await SessionIndex.open(gitDir, null);
    expect(again.get("fork-chat")!.forkedFrom).toEqual({ sessionId: "old-chat", turn: 3 });
    expect(again.get("old-chat")!.forkedFrom).toBeUndefined();
    expect(again.list().map((m) => m.id)).toEqual(["fork-chat", "old-chat"]);
  });

  it("a malformed forkedFrom is dropped, the chat itself still loads", async () => {
    const gitDir = track(makeTempDir("rg-sessions"));
    mkdirSync(sessionsDir(gitDir), { recursive: true });
    const meta = (id: string, forkedFrom: unknown) => ({ id, title: id, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", turns: 1, costUSD: 0, lastUserText: null, forkedFrom });
    writeFileSync(
      sessionsIndexPath(gitDir),
      JSON.stringify({
        version: 1,
        sessions: [
          meta("ok", { sessionId: "base", turn: 2 }),
          meta("no-turn", { sessionId: "base" }),
          meta("text-turn", { sessionId: "base", turn: "2" }),
          meta("fraction", { sessionId: "base", turn: 1.5 }),
          meta("empty-id", { sessionId: "", turn: 2 }),
          meta("not-object", "base"),
          meta("null", null),
        ],
      }),
    );
    const idx = await SessionIndex.open(gitDir, null);
    expect(idx.list()).toHaveLength(7);
    expect(idx.get("ok")!.forkedFrom).toEqual({ sessionId: "base", turn: 2 });
    for (const id of ["no-turn", "text-turn", "fraction", "empty-id", "not-object", "null"]) expect(idx.get(id)!.forkedFrom, id).toBeUndefined();
  });

  it("§57: kind \"terminal\" and cliSessionId survive a save and a reload; a chat stores no kind", async () => {
    const gitDir = track(makeTempDir("rg-sessions"));
    const idx = await SessionIndex.open(gitDir, null);
    const chat = idx.create("chat", "2026-10-01T00:00:00.000Z");
    const term = idx.create("term", "2026-10-02T00:00:00.000Z", "terminal");
    const plain = idx.create("plain", "2026-10-03T00:00:00.000Z", "chat");
    term.cliSessionId = "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a";
    expect(chat.kind).toBeUndefined();
    expect(plain.kind).toBeUndefined();
    expect(term.kind).toBe("terminal");
    await idx.save();

    const again = await SessionIndex.open(gitDir, null);
    expect(again.get("term")).toMatchObject({ kind: "terminal", cliSessionId: "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a" });
    expect("kind" in again.get("chat")!).toBe(false);
    expect("cliSessionId" in again.get("chat")!).toBe(false);
  });

  it("§57: a malformed kind or cliSessionId (not a UUID: it would go into argv) is dropped, the chat itself still loads", async () => {
    const gitDir = track(makeTempDir("rg-sessions"));
    mkdirSync(sessionsDir(gitDir), { recursive: true });
    const meta = (id: string, extra: Record<string, unknown>) => ({ id, title: id, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", turns: 0, costUSD: 0, lastUserText: null, ...extra });
    writeFileSync(
      sessionsIndexPath(gitDir),
      JSON.stringify({
        version: 1,
        sessions: [
          meta("ok", { kind: "terminal", cliSessionId: "0B7E3C1A-5D2F-4E8B-9A6C-1F2E3D4C5B6A" }),
          meta("chat-kind", { kind: "chat" }),
          meta("flag", { kind: "terminal", cliSessionId: "--dangerously-skip-permissions" }),
          meta("not-uuid", { kind: "terminal", cliSessionId: "x" }),
          meta("odd-kind", { kind: "tmux", cliSessionId: "" }),
          meta("num-kind", { kind: 1, cliSessionId: 42 }),
        ],
      }),
    );
    const idx = await SessionIndex.open(gitDir, null);
    expect(idx.list()).toHaveLength(6);
    expect(idx.get("ok")).toMatchObject({ kind: "terminal", cliSessionId: "0B7E3C1A-5D2F-4E8B-9A6C-1F2E3D4C5B6A" });
    for (const id of ["chat-kind", "odd-kind", "num-kind"]) {
      expect(idx.get(id)!.kind, id).toBeUndefined();
      expect(idx.get(id)!.cliSessionId, id).toBeUndefined();
    }
    for (const id of ["flag", "not-uuid"]) {
      expect(idx.get(id)!.kind, id).toBe("terminal");
      expect(idx.get(id)!.cliSessionId, id).toBeUndefined();
    }
  });
});
