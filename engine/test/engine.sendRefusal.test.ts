import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewGate } from "../src/review/gate.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * A send whose snapshot A fails (docs/PROTOCOL.md §35.1, §10 / §19.6): it is refused — `result{ok:false}` with
 * `code: "lfs_missing"` / `"send_failed"` — and nothing of it happened. Before, the reply was `ok` (only an `error` event
 * said why), so a client's queue dropped the message; the user message row, the chat title / lastUserText (which made a
 * brand-new chat "resumable" for a CLI that never saw it), the review-summary prefix and the notes were already used up.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-sendref"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "a.txt", "one\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

/** What a repository that needs git-lfs looks like on a machine without it (git.robust.test). */
function requireMissingLfs(dir: string): void {
  write(dir, ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  sh(dir, "add", ".gitattributes");
  sh(dir, "commit", "-qm", "attrs");
  sh(dir, "config", "filter.lfs.required", "true");
  sh(dir, "config", "filter.lfs.process", "git-lfs-not-installed-here filter-process");
  sh(dir, "config", "filter.lfs.clean", "git-lfs-not-installed-here clean -- %f");
  write(dir, "model.bin", Buffer.alloc(64, 7));
}

/** The user fixed it (here: the file no longer goes through LFS — the machine's global config may know git-lfs anyway). */
function allowLfsAgain(dir: string): void {
  write(dir, ".gitattributes", "");
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function opened(): Promise<{ h: Harness; dir: string; id: string }> {
  const dir = makeRepo();
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  const id = (await h.open(dir)).sessions.currentId!;
  return { h, dir, id };
}

const refusal = (e: unknown) => e as Error & { message: string };

describe("a send whose snapshot A fails is refused, and nothing of it happened", () => {
  it("git-lfs missing: refused lfs_missing; no message to Claude, no user_message, the new chat stays new and starts fresh again", async () => {
    const { h, dir, id } = await opened();
    requireMissingLfs(dir);
    const replies: unknown[] = [];
    h.engine.on((ev) => {
      if (ev.type === "result") replies.push(ev);
    });
    await h.engine.handle({ type: "send", id: "s1", text: "look at the model" });
    await h.settle();
    expect(replies).toEqual([expect.objectContaining({ type: "result", id: "s1", ok: false, code: "lfs_missing", error: expect.stringMatching(/^lfs_missing:.*git-lfs/) })]);
    expect(h.session().sends).toEqual([]);
    expect(h.ofType("user_message")).toEqual([]);
    // The refusal is the report: no second banner from an `error` event, no `lastError`.
    expect(h.ofType("error")).toEqual([]);
    const s = h.engine.state;
    expect(s.gate.phase).toBe("idle");
    expect(s.gate.canSend).toBe(true);
    const meta = s.sessions.list.find((m) => m.id === id)!;
    expect([meta.title, meta.lastUserText, meta.turns]).toEqual(["New chat", null, 0]);
    expect(s.session.checkpoints ?? []).toEqual([]);
    // The CLI never saw a message: a restart starts the chat fresh again (a `--resume` would fail: no such conversation).
    await h.engine.request({ type: "restart_session" });
    expect(h.session().opts.settings.resumeSessionId).toBeUndefined();
    expect(h.session().opts.settings.sessionId).toBe(id);

    // Fixed: the same message goes out as the first one.
    allowLfsAgain(dir);
    await h.engine.request({ type: "send", text: "look at the model" });
    expect(h.session().sends.map((x) => x.text)).toEqual(["look at the model"]);
    expect(h.ofType("user_message").map((m) => [m.text, m.turn])).toEqual([["look at the model", 1]]);
  });

  it("any other snapshot failure: refused send_failed; the review summary and the notes wait for the retry", async () => {
    const { h, dir } = await opened();
    await h.engine.request({ type: "send", text: "edit a" });
    write(dir, "a.txt", "one\ntwo\n");
    write(dir, "b.txt", "b\n");
    h.session().emitTurnEnd({
      toolFiles: [
        { path: join(dir, "a.txt"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] },
        { path: join(dir, "b.txt"), tools: ["Write"], count: 1, toolUseIds: ["w1"] },
      ],
    });
    await h.waitFor((s) => s.gate.phase === "reviewing", "reviewing");
    await h.engine.request({ type: "accept", paths: ["a.txt"] });
    await h.engine.request({ type: "reject", paths: ["b.txt"] });
    const summary = h.engine.state.gate.lastReviewSummary;
    expect(summary).toMatch(/Accepted: a\.txt\..*Rejected .*b\.txt/);

    const gate = (h.engine as unknown as { gate: ReviewGate }).gate;
    const real = gate.snapshotStart.bind(gate);
    gate.snapshotStart = async () => {
      throw new Error("fatal: unable to write new index file");
    };
    const e = await h.engine.request({ type: "send", text: "next step" }).catch((x: unknown) => x);
    expect(refusal(e).message).toBe("send_failed:fatal: unable to write new index file");
    expect(h.session().sends.map((x) => x.text)).toEqual(["edit a"]);
    expect(h.ofType("user_message").map((m) => m.text)).toEqual(["edit a"]);
    expect(h.engine.state.gate.lastReviewSummary).toBe(summary);
    expect(h.engine.state.gate.canSend).toBe(true);
    expect(h.engine.state.sessions.list[0]!.lastUserText).toBe("edit a");

    gate.snapshotStart = real;
    await h.engine.request({ type: "send", text: "next step" });
    expect(h.session().sends.at(-1)!.text).toBe(`${summary}\n\nnext step`);
    expect(h.engine.state.gate.lastReviewSummary).toBeNull();
  });

  it("an answer to a standing review that cannot be delivered leaves the review and its notes as they were", async () => {
    const { h, dir } = await opened();
    await h.engine.request({ type: "send", text: "edit a" });
    write(dir, "a.txt", "one\ntwo\n");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "a.txt"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] }] });
    await h.waitFor((s) => s.gate.phase === "reviewing", "reviewing");
    await h.engine.request({ type: "add_note", path: "a.txt", line: 2, side: "new", excerpt: "two", body: "why two?" });
    const before = h.engine.state;
    // The answer keeps A, so a failing snapshot would only be the turn's own record: make the session refuse instead.
    h.session().refuseSends = new Error("session closed");
    await h.engine.request({ type: "send", text: "is two right?" }).catch(() => undefined);
    const s = h.engine.state;
    expect(s.gate.phase).toBe("reviewing");
    expect(s.gate.turnStartTree).toBe(before.gate.turnStartTree);
    expect(s.gate.turnEndTree).toBe(before.gate.turnEndTree);
    expect(s.reviewNotes.map((n) => n.body)).toEqual(["why two?"]);
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["a.txt", "pending"]]);
  });
});
