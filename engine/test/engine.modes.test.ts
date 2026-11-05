import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode, Settings } from "../src/protocol.js";
import { SESSION_FILE, type PersistedSession } from "../src/review/persist.js";
import { BudgetState } from "../src/session/budget.js";
import { buildHooks, type HookContext } from "../src/session/hooks.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-modes"));
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
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const sessionFile = (dir: string) => join(dir, ".git", SESSION_FILE);

/** The session file is written behind the state: poll until `pred` holds. */
async function waitForSessionFile(dir: string, pred: (o: PersistedSession) => boolean, what: string): Promise<PersistedSession> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const o = JSON.parse(readFileSync(sessionFile(dir), "utf8")) as PersistedSession;
      if (pred(o)) return o;
    } catch {
      // missing or mid-rename
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("permission modes (docs/M20-MODES.md)", () => {
  it("Settings.permissionMode defaults to `default`, validates, and is passed to the session at start", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    expect(h.engine.state.session.permissionMode).toBe("default");
    expect(h.session().opts.settings.permissionMode).toBe("default");

    // The SDK modes we do not expose (and anything else) are refused.
    for (const bad of ["bypassPermissions", "dontAsk", "nonsense", 7]) {
      await expect(h.engine.request({ type: "set_settings", settings: { permissionMode: bad as PermissionMode } })).rejects.toThrow("invalid_mode");
    }
    expect(h.engine.state.session.permissionMode).toBe("default");
  });

  it("a mode from the settings is used by the next session start", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello({ permissionMode: "acceptEdits" } as Partial<Settings>);
    await h.open(dir);
    expect(h.engine.state.session.permissionMode).toBe("acceptEdits");
    expect(h.session().opts.settings.permissionMode).toBe("acceptEdits");
  });

  it("set_permission_mode switches the live session while idle and mirrors into state", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.request({ type: "set_permission_mode", mode: "auto" });
    expect(h.session().permissionModes).toEqual(["auto"]);
    expect(h.engine.state.session.permissionMode).toBe("auto");
    await h.engine.request({ type: "set_permission_mode", mode: "plan" });
    expect(h.session().permissionModes).toEqual(["auto", "plan"]);
    expect(h.engine.state.session.permissionMode).toBe("plan");
    await expect(h.engine.request({ type: "set_permission_mode", mode: "bypassPermissions" as PermissionMode })).rejects.toThrow("invalid_mode");
    expect(h.engine.state.session.permissionMode).toBe("plan");
  });

  it("refused while a turn is running (session_busy) and without a session (no_session)", async () => {
    const h0 = harness();
    await h0.hello();
    await expect(h0.engine.request({ type: "set_permission_mode", mode: "auto" })).rejects.toThrow("no_session");

    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "do it" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    await expect(h.engine.request({ type: "set_permission_mode", mode: "auto" })).rejects.toThrow("session_busy");
    expect(h.session().permissionModes).toEqual([]);
    expect(h.engine.state.session.permissionMode).toBe("default");

    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn collected");
    await h.engine.request({ type: "set_permission_mode", mode: "auto" });
    expect(h.session().permissionModes).toEqual(["auto"]);
  });

  it("the mode is persisted in the session file and restored (plan as-is) by another engine on open_project", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    await a.open(dir);
    await a.engine.request({ type: "set_permission_mode", mode: "plan" });
    const saved = await waitForSessionFile(dir, (o) => o.permissionMode === "plan", "persisted mode");
    expect(saved.version).toBe(1);
    await a.engine.dispose();

    const b = harness();
    await b.hello();
    await b.open(dir);
    // `plan` is restored as-is: the user may have deliberately parked the project in plan mode.
    expect(b.engine.state.session.permissionMode).toBe("plan");
    expect(b.session().opts.settings.permissionMode).toBe("plan");
  });

  it("our PreToolUse rules still apply in `auto` (the mode never reaches the hook layer)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.request({ type: "set_permission_mode", mode: "auto" });
    expect(h.engine.state.session.permissionMode).toBe("auto");

    // The hooks are built from the session's HookContext, which carries no mode: `auto` lets the
    // CLI's classifier answer prompts, but a PreToolUse `deny` is returned before that.
    const events: Parameters<HookContext["emit"]>[0][] = [];
    const ctx: HookContext = {
      budget: new BudgetState({ maxFiles: 1, maxLines: 2 }),
      cwd: dir,
      root: dir,
      ignorePatterns: [],
      autoAllowTools: new Set(["Bash"]),
      emit: (e) => events.push(e),
      log: () => {},
    };
    const opts = { signal: new AbortController().signal };
    const pre = (name: string, input: Record<string, unknown>): HookInput =>
      ({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, session_id: "s", transcript_path: "", cwd: dir, tool_use_id: "t1" }) as unknown as HookInput;
    const decision = (out: unknown): string | undefined =>
      (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;

    const preEdit = buildHooks(ctx).PreToolUse![0]!.hooks[0]!;
    const preBash = buildHooks(ctx).PreToolUse![1]!.hooks[0]!;
    // git card (§46): asks although `autoAllowTools` has Bash
    expect(decision(await preBash(pre("Bash", { command: "git commit -m x" }), "t1", opts))).toBe("ask");
    // budget
    expect(decision(await preEdit(pre("Write", { file_path: join(dir, "big.txt"), content: "1\n2\n3\n4\n5\n" }), "t2", opts))).toBe("deny");
    expect(ctx.budget.denied).toBe(true);
  });
});

describe("§11: a worktree without a mode of its own starts as its repository's other worktrees ran last", () => {
  const writeSession = (gitDir: string, mode: PermissionMode, savedAt: string): void => {
    write(gitDir, SESSION_FILE, JSON.stringify({ version: 1, sessionId: `s-${mode}`, permissionMode: mode, savedAt }));
  };

  it("a new workbench takes the newest sibling's mode (plan skipped) before the client's; its own record still wins", async () => {
    const main = track(makeRepo());
    const parent = track(realpathSync(makeTempDir("rg-modes-wt")));
    const older = join(parent, "older");
    const fresh = join(parent, "fresh");
    sh(main, "worktree", "add", "-q", "-b", "older", older);
    sh(main, "worktree", "add", "-q", "-b", "fresh", fresh);
    const common = join(main, ".git");
    // The main checkout ran in auto mode most recently, an older workbench in acceptEdits; a third sits in plan mode.
    writeSession(common, "auto", "2026-11-05T10:00:00.000Z");
    writeSession(join(common, "worktrees", "older"), "acceptEdits", "2026-11-04T10:00:00.000Z");
    const parked = join(parent, "parked");
    sh(main, "worktree", "add", "-q", "-b", "parked", parked);
    writeSession(join(common, "worktrees", "parked"), "plan", "2026-11-06T10:00:00.000Z");

    const h = harness();
    await h.hello({ permissionMode: "default" } as Partial<Settings>);
    await h.open(fresh);
    expect(h.engine.state.session.permissionMode).toBe("auto");
    expect(h.session().opts.settings.permissionMode).toBe("auto");
    await h.engine.dispose();

    // Its own record (here: older's acceptEdits) wins over every sibling.
    const b = harness();
    await b.hello({ permissionMode: "default" } as Partial<Settings>);
    await b.open(older);
    expect(b.engine.state.session.permissionMode).toBe("acceptEdits");
  });

  it("a repository whose other worktrees never ran in ReviewGate starts in the client's mode", async () => {
    const main = track(makeRepo());
    const wt = join(track(realpathSync(makeTempDir("rg-modes-wt"))), "wt");
    sh(main, "worktree", "add", "-q", "-b", "wt", wt);
    const h = harness();
    await h.hello({ permissionMode: "acceptEdits" } as Partial<Settings>);
    await h.open(wt);
    expect(h.engine.state.session.permissionMode).toBe("acceptEdits");
  });
});
