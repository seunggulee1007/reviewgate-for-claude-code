import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(h.engine.state.lastError).toBe(errors[1]!.message);

    // The next turn reports them again.
    s.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn end");
    await h.engine.handle({ type: "send", text: "again" });
    s.emit({ type: "scope_notice", code: "worktree_blocked", toolName: "EnterWorktree", toolUseId: "t3", branch: "feature-x" });
    await h.settle();
    expect(h.ofType("error").filter((e) => e.code === "worktree_blocked")).toHaveLength(2);
  });

  it("settings.allowWorktreeIsolation reaches the session (default off)", async () => {
    const off = await started();
    expect(off.session().opts.settings.allowWorktreeIsolation).toBe(false);
    const on = await started({ allowWorktreeIsolation: true });
    expect(on.session().opts.settings.allowWorktreeIsolation).toBe(true);
  });
});
