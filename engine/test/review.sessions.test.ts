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
});
