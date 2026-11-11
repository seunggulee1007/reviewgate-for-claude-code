import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRefused } from "../src/errors.js";
import type { PermissionMode } from "../src/protocol.js";
import { SESSION_FILE, type PersistedSession } from "../src/review/persist.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";
import { WAIT_MS } from "./helpers/wait.js";

/**
 * docs/PROTOCOL.md §44.1 (MARK: wave6 w6-terminal), engine part: plan mode Claude enters on its own is followed (the chip,
 * the plan card), never stored as the project's mode, and approving it goes back to auto when the chat came from auto.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-w6-terminal"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "line1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function repo(): string {
  const d = makeRepo();
  dirs.push(d);
  return d;
}

/** The project's stored session file, once it was written after `since` (its `savedAt`). */
async function storedAfter(dir: string, since: string | null): Promise<PersistedSession> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const o = JSON.parse(readFileSync(join(dir, ".git", SESSION_FILE), "utf8")) as PersistedSession;
      if (o.savedAt !== since) return o;
    } catch {
      // missing or mid-rename
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the session file");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const savedAt = (dir: string): string | null => {
  try {
    return (JSON.parse(readFileSync(join(dir, ".git", SESSION_FILE), "utf8")) as PersistedSession).savedAt;
  } catch {
    return null;
  }
};

/** An auto-mode chat whose running turn Claude moved into plan mode (EnterPlanMode), with the plan it proposed pending. */
async function claudePlanned(mode: PermissionMode = "auto"): Promise<{ h: Harness; dir: string }> {
  const dir = repo();
  const h = harness();
  await h.hello({ permissionMode: mode });
  await h.open(dir);
  await h.engine.handle({ type: "send", text: "우선 플랜 모드로 한번 계획 세워볼까?" });
  await h.waitFor((s) => s.gate.phase === "running", "turn running");
  h.session().emit({ type: "permission_mode", mode: "plan", prePlanMode: mode });
  await h.waitFor((s) => s.session.permissionMode === "plan", "plan mode followed");
  h.session().emit({ type: "plan_exit", plan: "# Plan\n\n1. Add the endpoint\n2. Test it\n", planFiles: [] });
  await h.waitFor((s) => s.session.pendingPlan !== null, "plan card");
  return { h, dir };
}

describe("plan mode Claude enters on its own (§44.1)", () => {
  it("in an auto chat: the state shows plan mode (from auto), the plan card works, the stored mode stays auto", async () => {
    const { h, dir } = await claudePlanned();
    expect(h.engine.state.session.prePlanMode).toBe("auto");
    expect(h.engine.state.session.pendingPlan?.plan).toContain("Add the endpoint");
    const before = savedAt(dir);
    h.session().emitTurnEnd(); // the turn's end stores the chat (rememberSession)
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn collected");
    expect((await storedAfter(dir, before)).permissionMode).toBe("auto");
    expect(h.engine.state.session.permissionMode).toBe("plan");
  });

  it("approving without a mode goes back to auto (the follow-up runs there); an explicit mode still wins", async () => {
    const { h, dir } = await claudePlanned();
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase === "idle", "turn collected");
    const before = savedAt(dir);
    await h.engine.request({ type: "plan_response", approve: true });
    expect(h.session().permissionModes).toEqual(["auto"]);
    const s = await h.waitFor((x) => x.session.permissionMode === "auto" && x.session.pendingPlan === null, "back to auto");
    expect(s.session.prePlanMode).toBeNull();
    expect(h.ofType("plan_approved").at(-1)).toMatchObject({ mode: "auto" });
    expect(h.session().sends.at(-1)?.text).toContain("Implement the plan you just proposed");
    expect((await storedAfter(dir, before)).permissionMode).toBe("auto");

    const b = await claudePlanned();
    b.h.session().emitTurnEnd();
    await b.h.waitFor((x) => x.gate.phase === "idle", "turn collected");
    await b.h.engine.request({ type: "plan_response", approve: true, mode: "acceptEdits" });
    expect(b.h.session().permissionModes).toEqual(["acceptEdits"]);
  });

  it("approving back into an auto mode the CLI refuses (another model, a policy) runs the plan in default mode and says why — no refusal to loop on", async () => {
    const { h } = await claudePlanned();
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase === "idle", "turn collected");
    const fake = h.session();
    const take = fake.setPermissionMode.bind(fake);
    fake.setPermissionMode = async (mode: PermissionMode) => {
      if (mode === "auto") throw new CommandRefused("auto_mode_unavailable: Cannot set permission mode to auto: auto mode unavailable for this model");
      return take(mode);
    };
    await h.engine.request({ type: "plan_response", approve: true, mode: "auto" });
    expect(fake.permissionModes).toEqual(["default"]);
    const s = await h.waitFor((x) => x.session.permissionMode === "default" && x.session.pendingPlan === null, "default mode");
    expect(s.session.prePlanMode).toBeNull();
    expect(s.lastError).toBeNull();
    expect(h.ofType("plan_approved").at(-1)).toMatchObject({ mode: "default" });
    expect(h.ofType("error").at(-1)).toMatchObject({ code: "auto_mode_unavailable", fatal: false, scope: "session", detail: "default" });
    expect(fake.sends.at(-1)?.text).toContain("Implement the plan you just proposed");
    // Any other refusal still refuses (and the card stays).
    const b = await claudePlanned();
    b.h.session().emitTurnEnd();
    await b.h.waitFor((x) => x.gate.phase === "idle", "turn collected");
    const other = b.h.session();
    other.setPermissionMode = async () => {
      throw new CommandRefused("session_busy");
    };
    await expect(b.h.engine.request({ type: "plan_response", approve: true })).rejects.toThrow("session_busy");
    expect(b.h.engine.state.session.pendingPlan).not.toBeNull();
  });

  it("from the default mode approving goes back to default, as before", async () => {
    const { h } = await claudePlanned("default");
    expect(h.engine.state.session.prePlanMode).toBe("default");
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase === "idle", "turn collected");
    await h.engine.request({ type: "plan_response", approve: true });
    expect(h.session().permissionModes).toEqual(["default"]);
  });

  it("a new chat starts in the user's mode; a restarted one stays in plan mode with the mode before", async () => {
    const { h } = await claudePlanned();
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase === "idle", "turn collected");
    await h.engine.request({ type: "restart_session" });
    await h.waitFor((s) => s.session.open && !s.session.starting, "restarted");
    expect(h.session().opts.settings.permissionMode).toBe("plan");
    expect(h.session().opts.settings.prePlanMode).toBe("auto");
    expect(h.engine.state.session.prePlanMode).toBe("auto");
    await h.engine.request({ type: "session_new" });
    const s = await h.waitFor((x) => x.session.open && !x.session.starting, "new chat");
    expect(s.session.permissionMode).toBe("auto");
    expect(s.session.prePlanMode).toBeNull();
    expect(h.session().opts.settings.permissionMode).toBe("auto");
  });
});

describe("plan mode the user picks (§44.1)", () => {
  it("from auto: the mode before is kept, plan is stored as the user's choice, approving goes back to auto", async () => {
    const dir = repo();
    const h = harness();
    await h.hello({ permissionMode: "auto" });
    await h.open(dir);
    const before = savedAt(dir);
    await h.engine.request({ type: "set_permission_mode", mode: "plan" });
    expect(h.engine.state.session.prePlanMode).toBe("auto");
    expect((await storedAfter(dir, before)).permissionMode).toBe("plan");
    // Out of plan mode and back in from acceptEdits: the latest mode before counts.
    await h.engine.request({ type: "set_permission_mode", mode: "acceptEdits" });
    expect(h.engine.state.session.prePlanMode).toBeNull();
    await h.engine.request({ type: "set_permission_mode", mode: "plan" });
    expect(h.engine.state.session.prePlanMode).toBe("acceptEdits");
    await h.engine.request({ type: "set_permission_mode", mode: "auto" });
    await h.engine.request({ type: "set_permission_mode", mode: "plan" });
    await h.engine.handle({ type: "send", text: "plan it" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    h.session().emit({ type: "plan_exit", plan: "# Plan\n\n1. x\n", planFiles: [] });
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase === "idle" && s.session.pendingPlan !== null, "plan card");
    await h.engine.request({ type: "plan_response", approve: true });
    expect(h.session().permissionModes.at(-1)).toBe("auto");
    expect(h.engine.state.session.prePlanMode).toBeNull();
  });

  it("a project reopened in its stored plan mode knows no mode before it", async () => {
    const dir = repo();
    const a = harness();
    await a.hello({ permissionMode: "auto" });
    await a.open(dir);
    const before = savedAt(dir);
    await a.engine.request({ type: "set_permission_mode", mode: "plan" });
    await storedAfter(dir, before);
    await a.engine.dispose();
    const b = harness();
    await b.hello({ permissionMode: "auto" });
    await b.open(dir);
    expect(b.engine.state.session.permissionMode).toBe("plan");
    expect(b.engine.state.session.prePlanMode).toBeNull();
  });
});
