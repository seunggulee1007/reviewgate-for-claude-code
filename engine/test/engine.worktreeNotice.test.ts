import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionTranscriptPath } from "../src/review/sessions.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir } from "./helpers/repo.js";

/** docs/PROTOCOL.md §33.4, engine side: worktree notices reach the client as `error{fatal:false}` with a code and details. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function started(settings: Record<string, unknown> = {}): Promise<Harness> {
  const dir = realpathSync(makeRepo());
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello(settings);
  await h.open(dir);
  await h.engine.handle({ type: "send", text: "work in a worktree" });
  return h;
}

describe("worktree notices (§33.4)", () => {
  it("become non-fatal session errors with toolName / branch / path, once per turn and kind", async () => {
    const h = await started();
    const s = h.session();
    s.emit({ type: "scope_notice", code: "worktree_blocked", toolName: "EnterWorktree", toolUseId: "t1", branch: "feature-x" });
    s.emit({ type: "scope_notice", code: "worktree_blocked", toolName: "EnterWorktree", toolUseId: "t2", branch: "feature-x" });
    s.emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "Bash", toolUseId: "b1", path: "/elsewhere/wt" });
    await h.settle();
    const errors = h.ofType("error").filter((e) => e.code === "worktree_blocked" || e.code === "worktree_outside_review");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ fatal: false, scope: "session", code: "worktree_blocked", toolName: "EnterWorktree", branch: "feature-x" });
    expect(errors[0]!.message).toMatch(/workbench/i);
    expect(errors[1]).toMatchObject({ fatal: false, scope: "session", code: "worktree_outside_review", toolName: "Bash", path: "/elsewhere/wt" });
    expect(errors[1]!.message).toContain("/elsewhere/wt");
    // What already ran outside the review is a chat row: it never becomes the session's last error (a blocked call does).
    expect(h.engine.state.lastError).toBe(errors[0]!.message);

    // The next turn reports them again.
    s.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn end");
    await h.engine.handle({ type: "send", text: "again" });
    s.emit({ type: "scope_notice", code: "worktree_blocked", toolName: "EnterWorktree", toolUseId: "t3", branch: "feature-x" });
    await h.settle();
    expect(h.ofType("error").filter((e) => e.code === "worktree_blocked")).toHaveLength(2);
  });

  it("a command's changes in another worktree: a row per call naming only the files no row of the turn named yet, with them on the row", async () => {
    const h = await started();
    const s = h.session();
    const wt = "/work/acme-42";
    s.emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "Bash", toolUseId: "b1", path: wt, files: ["made.txt"], reasonCode: "other_worktree" });
    s.emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "Bash", toolUseId: "b2", path: wt, files: ["made.txt", "src/b.ts"], reasonCode: "other_worktree" });
    s.emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "Bash", toolUseId: "b3", path: wt, files: ["made.txt"], reasonCode: "other_worktree" });
    await h.settle();
    const rows = h.ofType("error").filter((e) => e.code === "worktree_outside_review");
    expect(rows.map((e) => e.files)).toEqual([["made.txt"], ["src/b.ts"]]);
    expect(rows[0]).toMatchObject({ fatal: false, scope: "session", toolName: "Bash", path: wt });
    expect(rows[1]!.message).toContain("Changed: src/b.ts");
    expect(h.engine.state.lastError).toBeNull();
    // The transcript rows keep the files (§35.3), so a restored chat reads the same.
    const dir = dirs.at(-1)!;
    const id = h.engine.state.sessions.currentId!;
    const kept = readFileSync(sessionTranscriptPath(join(dir, ".git"), id), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(kept.filter((r) => r.kind === "error" && r.code === "worktree_outside_review").map((r) => r.files)).toEqual([["made.txt"], ["src/b.ts"]]);
  });

  it("settings.allowWorktreeIsolation reaches the session (M05b: default on; false turns isolated agents off)", async () => {
    const byDefault = await started();
    expect(byDefault.session().opts.settings.allowWorktreeIsolation).toBe(true);
    const off = await started({ allowWorktreeIsolation: false });
    expect(off.session().opts.settings.allowWorktreeIsolation).toBe(false);
  });
});
