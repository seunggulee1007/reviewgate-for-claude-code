import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanUseTool, HookInput, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { MAX_PLAN_BYTES } from "../src/protocol.js";
import { BudgetState } from "../src/session/budget.js";
import { ClaudeSession, EXIT_PLAN_MODE_DENY } from "../src/session/claude.js";
import { buildHooks, isPlanFile, PLAN_FILE_REASON, PLAN_MODE_BASH_REASON, PLAN_MODE_EDIT_REASON, plansDir, READ_ONLY_BASH_REASON, type HookContext } from "../src/session/hooks.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-plan"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "line1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

/** A fake `<home>/.claude/plans/` with one plan file in it. */
function makePlansHome(content = "# Plan\n\n1. do a thing\n"): { home: string; dir: string; file: string } {
  const home = realpathSync(makeTempDir("rg-home"));
  const dir = join(home, ".claude", "plans");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "add-contributing.md");
  writeFileSync(file, content, "utf8");
  return { home, dir, file };
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

/** Opens a project whose session is already parked in plan mode. */
async function planning(): Promise<{ h: Harness; repo: string }> {
  const repo = track(makeRepo());
  const h = harness();
  await h.hello();
  await h.open(repo);
  await h.engine.request({ type: "set_permission_mode", mode: "plan" });
  return { h, repo };
}

/** Runs one plan-mode turn that wrote `planFiles`. */
async function planTurn(h: Harness, planFiles: string[], changedOutside: string[] = []): Promise<void> {
  await h.engine.handle({ type: "send", text: "Plan how to add a CONTRIBUTING.md; do not write anything yet" });
  await h.waitFor((s) => s.gate.phase === "running", "turn running");
  h.session().emitTurnEnd({ planFiles, changedOutside });
  await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn collected");
}

/**
 * Calls the REAL `ClaudeSession.canUseTool` for `ExitPlanMode` (CLI 2.1.275+) and routes the session
 * event it emits into the harness's engine, so the whole central path is exercised. Also feeds the
 * `assistant` tool_use block and the CLI's `user` tool_result (the deny) through the same session's
 * `handleSdkMessage`, exactly as the real stream would — both must be swallowed (never a `tool_use` /
 * `tool_result` SessionEvent) so the transcript never shows the intercepted call as a "tool error" row.
 */
async function exitPlanMode(h: Harness, plan: unknown, planFiles: string[] = [], toolUseId = "exit-plan-1"): Promise<PermissionResult> {
  const real = new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", permissionMode: "plan" },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => h.session().emit(e),
    log: () => {},
  });
  (real as unknown as { hookCtx: HookContext }).hookCtx.planFiles = new Set(planFiles);
  // The engine's send started this turn on the fake session; the real one stands in for its CLI side.
  (real as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
  const feed = (m: SDKMessage) => (real as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage(m);
  feed({
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "u",
    session_id: "s1",
    message: {
      id: `m-${toolUseId}`,
      model: "claude-x",
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "ExitPlanMode", input: { plan } }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as unknown as SDKMessage);
  const canUseTool = (real as unknown as { canUseTool: CanUseTool }).canUseTool;
  const result = (await canUseTool("ExitPlanMode", { plan } as Record<string, unknown>, { signal: new AbortController().signal } as unknown as Parameters<CanUseTool>[2]))!;
  // The CLI's deny still arrives as an ordinary tool_result (is_error: true).
  feed({
    type: "user",
    parent_tool_use_id: null,
    uuid: "u",
    session_id: "s1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: true, content: EXIT_PLAN_MODE_DENY }] },
  } as unknown as SDKMessage);
  return result;
}

describe("plan mode proposal flow (docs/M20-MODES.md)", () => {
  it("auto-allows Write/Edit under <home>/.claude/plans/ in plan mode and keeps them out of the budget", async () => {
    const repo = track(makeRepo());
    const { home, dir, file } = makePlansHome();
    dirs.push(home);
    const ctx: HookContext = {
      budget: new BudgetState({ maxFiles: 5, maxLines: 200 }),
      cwd: repo,
      root: repo,
      ignorePatterns: [],
      autoAllowTools: new Set(),
      permissionMode: "plan",
      plansDir: dir,
      planFiles: new Set<string>(),
      emit: () => {},
      log: () => {},
    };
    const pre = (input: Record<string, unknown>): HookInput =>
      ({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: input, session_id: "s", transcript_path: "", cwd: repo, tool_use_id: "t1" }) as unknown as HookInput;
    const out = (o: unknown) => (o as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
    const preEdit = buildHooks(ctx).PreToolUse![0]!.hooks[0]!;

    const decision = out(await preEdit(pre({ file_path: file, content: "# Plan\n1\n2\n3\n" }), "t1", { signal: new AbortController().signal }));
    expect(decision?.permissionDecision).toBe("allow");
    expect(decision?.permissionDecisionReason).toBe(PLAN_FILE_REASON);
    // The plan file is bookkeeping: it is recorded as a plan file and never charged to the budget.
    expect([...ctx.planFiles!]).toEqual([file]);
    expect(ctx.budget.files.size).toBe(0);
    expect(ctx.budget.lines).toBe(0);

    // A write inside the repo in the same turn is denied (plan mode proposes, it does not edit) and not counted.
    const inRepo = out(await preEdit(pre({ file_path: join(repo, "a.txt"), content: "1\n2\n" }), "t2", { signal: new AbortController().signal }));
    expect(inRepo).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PLAN_MODE_EDIT_REASON });
    expect(ctx.budget.files.size).toBe(0);
  });

  it("plan mode denies every in-repo edit tool and non-read-only Bash (hooks and canUseTool); read-only Bash still runs", async () => {
    const repo = track(makeRepo());
    const { home, dir, file } = makePlansHome();
    dirs.push(home);
    const ctx: HookContext = {
      budget: new BudgetState({ maxFiles: 5, maxLines: 200 }),
      cwd: repo,
      root: repo,
      ignorePatterns: [],
      autoAllowTools: new Set(),
      permissionMode: "plan",
      plansDir: dir,
      planFiles: new Set<string>(),
      emit: () => {},
      log: () => {},
    };
    const sig = { signal: new AbortController().signal };
    const pre = (tool: string, input: Record<string, unknown>): HookInput =>
      ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, session_id: "s", transcript_path: "", cwd: repo, tool_use_id: "t1" }) as unknown as HookInput;
    const out = (o: unknown) => (o as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
    const hooks = buildHooks(ctx).PreToolUse!;
    const preEdit = hooks[0]!.hooks[0]!;
    const preBash = hooks[1]!.hooks[0]!;
    for (const tool of ["Edit", "Write", "MultiEdit"]) {
      expect(out(await preEdit(pre(tool, { file_path: join(repo, "README.md"), content: "x" }), "t", sig))?.permissionDecisionReason, tool).toBe(PLAN_MODE_EDIT_REASON);
    }
    expect(out(await preEdit(pre("NotebookEdit", { notebook_path: join(repo, "n.ipynb") }), "t", sig))?.permissionDecision).toBe("deny");
    expect(out(await preBash(pre("Bash", { command: "git status" }), "t", sig))).toMatchObject({ permissionDecision: "allow", permissionDecisionReason: READ_ONLY_BASH_REASON });
    for (const command of ["npm test", "rm -rf src", "echo x > a.txt", "git status && touch a"]) {
      expect(out(await preBash(pre("Bash", { command }), "t", sig)), command).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: PLAN_MODE_BASH_REASON });
    }
    // The canUseTool safety net says the same (allow patterns / remembered allows / autoAllowTools do not apply).
    const real = new ClaudeSession({
      cwd: repo,
      settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: ["Bash"], loadUserSettings: false, systemPromptAppend: "", permissionMode: "plan", bashAllowPatterns: ["Bash(npm test:*)"] },
      claudePath: "/nonexistent/claude",
      env: {},
      platform: { killTree: async () => undefined, isWindows: false },
      emit: () => {},
      log: () => {},
    });
    const rctx = (real as unknown as { hookCtx: HookContext }).hookCtx;
    rctx.plansDir = dir;
    rctx.root = repo;
    (real as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
    const canUseTool = (real as unknown as { canUseTool: CanUseTool }).canUseTool;
    const ask = (tool: string, input: Record<string, unknown>) => canUseTool(tool, input, { signal: new AbortController().signal } as unknown as Parameters<CanUseTool>[2]);
    expect(await ask("Edit", { file_path: join(repo, "README.md"), old_string: "a", new_string: "b" })).toEqual({ behavior: "deny", message: PLAN_MODE_EDIT_REASON });
    expect(await ask("Bash", { command: "npm test" })).toEqual({ behavior: "deny", message: PLAN_MODE_BASH_REASON });
    expect(await ask("Bash", { command: "ls" })).toMatchObject({ behavior: "allow" });
    expect(await ask("Write", { file_path: file, content: "# plan" })).toMatchObject({ behavior: "allow" });
    // Leaving plan mode lifts the rule.
    await real.setPermissionMode("default").catch(() => undefined);
    rctx.permissionMode = "default";
    expect(await ask("Edit", { file_path: join(repo, "README.md"), old_string: "a", new_string: "b" })).toMatchObject({ behavior: "allow" });
  });

  it("outside plan mode the very same path still needs approval (containment ask)", async () => {
    const repo = track(makeRepo());
    const { home, dir, file } = makePlansHome();
    dirs.push(home);
    const ctx: HookContext = {
      budget: new BudgetState({ maxFiles: 5, maxLines: 200 }),
      cwd: repo,
      root: repo,
      ignorePatterns: [],
      autoAllowTools: new Set(),
      permissionMode: "default",
      plansDir: dir,
      planFiles: new Set<string>(),
      emit: () => {},
      log: () => {},
    };
    expect(isPlanFile(file, ctx)).toBe(false);
    expect(isPlanFile(file, { ...ctx, permissionMode: "plan" })).toBe(true);
    // A path merely NAMED like the plans dir but outside it is not a plan file.
    expect(isPlanFile(join(repo, "plans", "x.md"), { ...ctx, permissionMode: "plan" })).toBe(false);
    const preEdit = buildHooks(ctx).PreToolUse![0]!.hooks[0]!;
    const input = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file, content: "x\n" }, session_id: "s", transcript_path: "", cwd: repo, tool_use_id: "t1" } as unknown as HookInput;
    const o = (await preEdit(input, "t1", { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(o.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(plansDir("/home/u").endsWith(join(resolve("/home/u"), ".claude", "plans"))).toBe(true);
  });

  it("turn_end in plan mode emits plan_proposed with the file's content and mirrors it into state.session.pendingPlan", async () => {
    const { h } = await planning();
    const { home, file } = makePlansHome("# Add CONTRIBUTING.md\n\n- step one\n");
    dirs.push(home);
    await planTurn(h, [file]);

    const proposed = h.ofType("plan_proposed");
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.path).toBe(file);
    expect(proposed[0]!.plan).toBe("# Add CONTRIBUTING.md\n\n- step one\n");
    const pending = h.engine.state.session.pendingPlan;
    expect(pending?.path).toBe(file);
    expect(pending?.plan).toContain("step one");
    expect(Number.isNaN(Date.parse(pending!.at))).toBe(false);
  });

  it("the plan file stays out of the review, changedOutside and the budget", async () => {
    const { h } = await planning();
    const { home, file } = makePlansHome();
    dirs.push(home);
    // The session filters plan files out of `changedOutside`/`toolFiles`; the engine must not
    // resurrect them through the review either.
    await planTurn(h, [file]);
    const s = h.engine.state;
    expect(s.gate.changedOutside).toEqual([]);
    expect(s.changedFiles.map((f) => f.path)).toEqual([]);
    expect(s.gate.reviewSummary).toEqual({ files: 0, added: 0, deleted: 0 });
    expect(s.budgetUsage).toEqual({ files: 0, lines: 0, denied: false });
    expect(s.gate.phase).toBe("idle");
  });

  it("a plan larger than 200 KB is truncated", async () => {
    const { h } = await planning();
    const { home, file } = makePlansHome("x".repeat(MAX_PLAN_BYTES + 5000));
    dirs.push(home);
    await planTurn(h, [file]);
    expect(h.engine.state.session.pendingPlan!.plan.length).toBe(MAX_PLAN_BYTES);
  });

  it("plan_response{approve} switches the mode, emits plan_approved and sends the follow-up", async () => {
    const { h } = await planning();
    const { home, file } = makePlansHome();
    dirs.push(home);
    await planTurn(h, [file]);

    const sendsBefore = h.session().sends.length;
    await h.engine.request({ type: "plan_response", approve: true });
    expect(h.engine.state.session.permissionMode).toBe("default");
    expect(h.session().permissionModes).toEqual(["plan", "default"]);
    expect(h.engine.state.session.pendingPlan).toBeNull();
    const approved = h.ofType("plan_approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({ mode: "default", path: file });
    const sent = h.session().sends.slice(sendsBefore);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe(`Implement the approved plan at ${file}.`);
    // The follow-up is a normal send: a turn is running and the review gate applies to it.
    expect(h.engine.state.gate.phase).toBe("running");
  });

  it("plan_response is atomic: a follow-up send that fails restores the plan card and the previous mode (plan_followup_failed)", async () => {
    const { h } = await planning();
    const { home, file } = makePlansHome();
    dirs.push(home);
    await planTurn(h, [file]);
    const pending = h.engine.state.session.pendingPlan;
    expect(pending).not.toBeNull();
    h.session().refuseSends = new Error("CLI gone");
    await h.engine.handle({ type: "plan_response", approve: true, mode: "acceptEdits", id: "pr1" });
    const r = h.ofType("result").find((e) => e.id === "pr1") as unknown as Record<string, unknown>;
    expect(r).toMatchObject({ ok: false, code: "plan_followup_failed" });
    expect(String(r.error)).toMatch(/^plan_followup_failed:CLI gone/);
    let s = h.engine.state;
    expect(s.session.pendingPlan).toEqual(pending);
    expect(s.session.permissionMode).toBe("plan");
    expect(h.session().permissionModes).toEqual(["plan", "acceptEdits", "plan"]);
    expect(s.gate.phase).not.toBe("running");
    expect(h.ofType("error").some((e) => e.code === "plan_followup_failed" && !e.fatal)).toBe(true);
    // A reject whose nudge fails keeps the card as well.
    await expect(h.engine.request({ type: "plan_response", approve: false })).rejects.toThrow("plan_followup_failed");
    expect(h.engine.state.session.pendingPlan).toEqual(pending);
    // Once the session takes messages again the same answer goes through.
    h.session().refuseSends = null;
    await h.engine.request({ type: "plan_response", approve: true });
    s = h.engine.state;
    expect(s.session.pendingPlan).toBeNull();
    expect(s.session.permissionMode).toBe("default");
    expect(s.gate.phase).toBe("running");
  });

  it("plan_response{approve, mode, message} honours both overrides", async () => {
    const { h } = await planning();
    const { home, file } = makePlansHome();
    dirs.push(home);
    await planTurn(h, [file]);

    await h.engine.request({ type: "plan_response", approve: true, mode: "acceptEdits", message: "Go, but only step one." });
    expect(h.engine.state.session.permissionMode).toBe("acceptEdits");
    expect(h.ofType("plan_approved")[0]).toMatchObject({ mode: "acceptEdits", path: file });
    expect(h.session().sends.at(-1)!.text).toBe("Go, but only step one.");
  });

  it("plan_response{approve:false} stays in plan mode and asks for a revision", async () => {
    const { h } = await planning();
    const { home, file } = makePlansHome();
    dirs.push(home);
    await planTurn(h, [file]);

    await h.engine.request({ type: "plan_response", approve: false });
    expect(h.engine.state.session.permissionMode).toBe("plan");
    expect(h.session().permissionModes).toEqual(["plan"]);
    expect(h.engine.state.session.pendingPlan).toBeNull();
    expect(h.ofType("plan_approved")).toHaveLength(0);
    expect(h.session().sends.at(-1)!.text).toBe("Keep planning — revise the plan; do not implement yet.");
  });

  it("a plain send supersedes a pending plan", async () => {
    const { h } = await planning();
    const { home, file } = makePlansHome();
    dirs.push(home);
    await planTurn(h, [file]);
    expect(h.engine.state.session.pendingPlan).not.toBeNull();

    await h.engine.handle({ type: "send", text: "forget that, do something else" });
    await h.waitFor((s) => s.session.pendingPlan === null, "pendingPlan cleared by the send");
    expect(h.engine.state.session.permissionMode).toBe("plan");
    expect(h.session().sends.at(-1)!.text).toContain("forget that");
  });

  it("ExitPlanMode is answered by the engine: plan_proposed once, tool denied, no permission card", async () => {
    const { h } = await planning();
    const { home, file } = makePlansHome();
    dirs.push(home);
    await h.engine.handle({ type: "send", text: "Plan how to add a CONTRIBUTING.md; do not write anything yet" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");

    const result = await exitPlanMode(h, "# Add CONTRIBUTING.md\n\n- step one\n", [file]);
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toBe(EXIT_PLAN_MODE_DENY);
    await h.settle();

    // The plan is offered immediately (not at turn_end) and the card never appears.
    const proposed = h.ofType("plan_proposed");
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.path).toBe(file);
    expect(proposed[0]!.plan).toBe("# Add CONTRIBUTING.md\n\n- step one\n");
    expect(h.ofType("permission_request")).toHaveLength(0);
    expect(h.engine.state.session.pendingPermission).toBeNull();
    // Cosmetic fix: the intercepted call's tool_use and the CLI's deny tool_result never reach the
    // transcript — otherwise the deny renders as a red "tool error" row right under the plan card.
    expect(h.ofType("tool_use").some((e) => e.name === "ExitPlanMode")).toBe(false);
    expect(h.ofType("tool_result")).toHaveLength(0);
    const pending = h.engine.state.session.pendingPlan;
    expect(pending?.path).toBe(file);
    expect(pending?.plan).toContain("step one");
    expect(Number.isNaN(Date.parse(pending!.at))).toBe(false);

    // turn_end carries the same plan file: the fallback must not propose it a second time.
    h.session().emitTurnEnd({ planFiles: [file] });
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn collected");
    expect(h.ofType("plan_proposed")).toHaveLength(1);
    expect(h.engine.state.session.pendingPlan?.plan).toContain("step one");

    // The approval still works on the plan that came from the tool.
    const sendsBefore = h.session().sends.length;
    await h.engine.request({ type: "plan_response", approve: true });
    expect(h.engine.state.session.permissionMode).toBe("default");
    expect(h.ofType("plan_approved")[0]).toMatchObject({ mode: "default", path: file });
    expect(h.session().sends.slice(sendsBefore)[0]!.text).toBe(`Implement the approved plan at ${file}.`);
  });

  it("ExitPlanMode without a plan file proposes a pathless plan and approves with a generic follow-up", async () => {
    const { h } = await planning();
    await h.engine.handle({ type: "send", text: "Plan it" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");

    await exitPlanMode(h, "1. do a thing\n");
    await h.settle();
    const proposed = h.ofType("plan_proposed");
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.path).toBeNull();
    expect(h.engine.state.session.pendingPlan?.path).toBeNull();
    expect(h.ofType("permission_request")).toHaveLength(0);

    // A second call with the same text in the same turn is deduped by the plan hash.
    await exitPlanMode(h, "1. do a thing\n");
    await h.settle();
    expect(h.ofType("plan_proposed")).toHaveLength(1);

    h.session().emitTurnEnd({ planFiles: [] });
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn collected");
    expect(h.ofType("plan_proposed")).toHaveLength(1);

    const sendsBefore = h.session().sends.length;
    await h.engine.request({ type: "plan_response", approve: true });
    expect(h.ofType("plan_approved")[0]).toMatchObject({ mode: "default", path: null });
    expect(h.session().sends.slice(sendsBefore)[0]!.text).toBe("Implement the plan you just proposed.");
  });

  it("ExitPlanMode with no plan text falls back to the plan file at turn_end", async () => {
    const { h } = await planning();
    const { home, file } = makePlansHome("# From the file\n");
    dirs.push(home);
    await h.engine.handle({ type: "send", text: "Plan it" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");

    // The tool is still denied and never prompts, but there is nothing to propose yet.
    const result = await exitPlanMode(h, undefined, []);
    expect(result.behavior).toBe("deny");
    await h.settle();
    expect(h.ofType("plan_proposed")).toHaveLength(0);

    h.session().emitTurnEnd({ planFiles: [file] });
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn collected");
    const proposed = h.ofType("plan_proposed");
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.path).toBe(file);
    expect(proposed[0]!.plan).toBe("# From the file\n");
    expect(h.ofType("permission_request")).toHaveLength(0);
  });

  it("refused with no_plan, session_busy and no_session", async () => {
    const empty = harness();
    await empty.hello();
    await expect(empty.engine.request({ type: "plan_response", approve: true })).rejects.toThrow("no_session");

    const { h } = await planning();
    await expect(h.engine.request({ type: "plan_response", approve: true })).rejects.toThrow("no_plan");

    const { home, file } = makePlansHome();
    dirs.push(home);
    await planTurn(h, [file]);
    // A mode we do not expose is refused before anything is switched; the card stays up.
    await expect(h.engine.request({ type: "plan_response", approve: true, mode: "bypassPermissions" as never })).rejects.toThrow("invalid_mode");
    expect(h.engine.state.session.pendingPlan).not.toBeNull();
    expect(h.engine.state.session.permissionMode).toBe("plan");
    // A turn started by the user while the card is up: the answer has to wait for it.
    await h.engine.handle({ type: "send", text: "hang on" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    await expect(h.engine.request({ type: "plan_response", approve: true })).rejects.toThrow("session_busy");
  });
});
