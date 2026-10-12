import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §37.2: a file that leaves the review by a reject takes its notes with it — like a refresh, a commit
 * or a collection already did. Before, the notes of a rejected file stayed: the next `request_changes` sent them (asking
 * Claude about a change that was just reverted), `canRequestChanges` stayed true and `notes_pending` blocked a chat
 * switch with no note left on screen, and the review never counted as resolved.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-rejectnotes"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "Svc.java", "l1\nl2\nl3\n");
  write(dir, "Repo.java", "r1\nr2\nr3\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function reviewOfTwo(): Promise<{ h: Harness; dir: string }> {
  const dir = makeRepo();
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello({ budget: { maxFiles: 50, maxLines: 5000 } });
  await h.open(dir);
  await h.engine.request({ type: "send", text: "change both" });
  write(dir, "Svc.java", "l1\nl2 changed\nl3\n");
  write(dir, "Repo.java", "r1\nr2 changed\nr3\n");
  h.session().emitTurnEnd({ toolFiles: [
    { path: join(dir, "Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] },
    { path: join(dir, "Repo.java"), tools: ["Edit"], count: 1, toolUseIds: ["e2"] },
  ] });
  await h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.turnEndTree !== null, "collected");
  return { h, dir };
}

describe("a rejected file's notes leave with it (§37.2)", () => {
  it("reject: the next request_changes sends only the notes of files still under review", async () => {
    const { h } = await reviewOfTwo();
    await h.engine.request({ type: "add_note", path: "Repo.java", line: 2, side: "new", excerpt: "r2 changed", body: "rename r2" });
    await h.engine.request({ type: "add_note", path: "Svc.java", line: 2, side: "new", excerpt: "l2 changed", body: "keep l2 short" });
    await h.engine.request({ type: "reject", paths: ["Repo.java"] });
    let s = h.engine.state;
    expect(s.changedFiles.map((f) => f.path)).toEqual(["Svc.java"]);
    expect(s.reviewNotes.map((n) => n.path)).toEqual(["Svc.java"]);
    await h.engine.request({ type: "request_changes" });
    const sent = h.session().sends.at(-1)!.text;
    expect(sent).toContain("keep l2 short");
    expect(sent).not.toContain("rename r2");
    expect(sent).not.toContain("Repo.java:");
    s = h.engine.state;
    expect(s.gate.phase).toBe("running");
  });

  it("reject_all / reject_hunks (every hunk): no note is left behind — nothing blocks a new chat, the review is resolved", async () => {
    const { h, dir } = await reviewOfTwo();
    await h.engine.request({ type: "add_note", path: "Repo.java", line: 2, side: "new", excerpt: "r2 changed", body: "why?" });
    await h.engine.request({ type: "add_note", path: "Svc.java", line: 2, side: "old", excerpt: "l2", body: "was fine" });
    await h.engine.request({ type: "reject_hunks", path: "Svc.java", hunks: [0] });
    expect(h.engine.state.reviewNotes.map((n) => n.path)).toEqual(["Repo.java"]);
    await h.engine.request({ type: "reject_all" });
    const s = h.engine.state;
    expect(s.changedFiles).toEqual([]);
    expect(s.reviewNotes).toEqual([]);
    expect(s.gate.canRequestChanges).toBe(false);
    expect(s.gate.phase).toBe("idle");
    // No hidden note blocks a new chat (`notes_pending`).
    await h.engine.request({ type: "session_new" });
    await h.waitFor((x) => x.session.open && !x.session.starting, "new chat");
    expect(sh(dir, "status", "--porcelain")).toBe("");
  });
});
