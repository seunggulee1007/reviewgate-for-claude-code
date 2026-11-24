import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import type { SessionEvent } from "../src/session/events.js";
import { buildHooks, type HookContext } from "../src/session/hooks.js";
import {
  changesFiles,
  isFixable,
  reviewFirstContext,
  reviewFirstFixable,
  reviewFirstFixReason,
  reviewFirstMode,
  reviewFirstPromptDecision,
  reviewFirstPromptReason,
  reviewFirstToolDecision,
  reviewFirstToolReason,
  reviewFirstWaiting,
  type ReviewFirstHold,
  type ReviewFirstMode,
} from "../src/session/reviewFirst.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeFakeClaude } from "./helpers/fakeClaude.js";
import { fakePlatform } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §64: review first — Claude's next work waits until the user reviewed its last changes. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
const temp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = temp("rg-review-first");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\nline3\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const file = (path: string, state: string) => ({ path, state });

describe("the decision (reviewFirst.ts)", () => {
  it("the setting: edits by default, unknown values too", () => {
    expect(reviewFirstMode(undefined)).toBe("edits");
    expect(reviewFirstMode("bogus")).toBe("edits");
    expect(reviewFirstMode("prompts")).toBe("prompts");
    expect(reviewFirstMode("off")).toBe("off");
  });

  it("what waits: pending and changes-requested files of the collected review × mode; never while a change request runs", () => {
    const reviews = {
      pending: [file("a.ts", "pending"), file("b.ts", "accepted")],
      changesRequested: [file("a.ts", "changesRequested"), file("b.ts", "accepted")],
      none: [file("a.ts", "accepted"), file("b.ts", "rejected")],
      // The turn that makes the files: they are not in the collected review until it ends.
      sameTurn: [],
    };
    const table: [keyof typeof reviews, ReviewFirstMode, string[] | null][] = [
      ["pending", "edits", ["a.ts"]], ["pending", "prompts", ["a.ts"]], ["pending", "off", null],
      ["changesRequested", "edits", ["a.ts"]], ["changesRequested", "prompts", ["a.ts"]], ["changesRequested", "off", null],
      ["none", "edits", null], ["none", "prompts", null], ["none", "off", null],
      ["sameTurn", "edits", null], ["sameTurn", "prompts", null],
    ];
    for (const [review, mode, want] of table) {
      expect(reviewFirstWaiting(mode, { files: reviews[review], requestingChanges: false }), `${review} × ${mode}`).toEqual(want);
    }
    expect(reviewFirstWaiting("edits", { files: reviews.changesRequested, requestingChanges: true })).toBeNull();
  });

  it("which tools change files: edit tools, Bash that is not read-only; reads, subagents and MCP tools follow the usual flow", () => {
    const tools: [string, Record<string, unknown>, boolean][] = [
      ["Write", { file_path: "/r/a.ts", content: "x" }, true],
      ["Edit", { file_path: "/r/a.ts", old_string: "a", new_string: "b" }, true],
      ["MultiEdit", { file_path: "/r/a.ts", edits: [] }, true],
      ["NotebookEdit", { notebook_path: "/r/n.ipynb" }, true],
      ["Bash", { command: "touch x" }, true],
      ["Bash", { command: "npm test" }, true],
      ["Bash", { command: "git commit -m x" }, true],
      ["Bash", { command: "sed -i s/a/b/ a.ts" }, true],
      ["Bash", { command: "git status" }, false],
      ["Bash", { command: "ls -la && cat README.md | head" }, false],
      ["Bash", { command: "rg foo src" }, false],
      ["Read", { file_path: "/r/a.ts" }, false],
      ["Grep", { pattern: "x" }, false],
      ["Glob", { pattern: "*.ts" }, false],
      ["Agent", { prompt: "look around" }, false],
      ["WebFetch", { url: "https://example.com" }, false],
      ["mcp__fs__write_file", { path: "/r/a.ts" }, false],
    ];
    for (const [tool, input, changes] of tools) expect(changesFiles(tool, input), `${tool} ${JSON.stringify(input)}`).toBe(changes);
    // Plan files and Claude's memory are outside the review.
    expect(changesFiles("Write", { file_path: "/p/plan.md" }, { file: "/p/plan.md", exempt: (f) => f.startsWith("/p/") })).toBe(false);
  });

  it("the tool decision (edits): files of the review may be fixed in any state but rejected; other files, new ones and unknown paths wait; Bash runs", () => {
    const root = makeRepo();
    write(root, "src/a.ts", "a\n");
    const files = [file("src/a.ts", "pending"), file("b.ts", "changesRequested"), file("c.ts", "accepted"), file("d.ts", "rejected")];
    const hold: ReviewFirstHold = { mode: "edits", waiting: ["src/a.ts", "b.ts"], fixable: reviewFirstFixable(files), root };
    expect(hold.fixable).toEqual(["src/a.ts", "b.ts", "c.ts"]);
    const deny = reviewFirstFixReason(["src/a.ts", "b.ts"]);
    const edit = (tool: string, f: string) => reviewFirstToolDecision(hold, tool, { file_path: join(root, f) }, { file: join(root, f) });
    // In the list (pending, changes requested, accepted): each edit tool goes on.
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) for (const f of ["src/a.ts", "b.ts", "c.ts"]) expect(edit(tool, f), `${tool} ${f}`).toBeNull();
    // A rejected file, a file not in the list, a new file: denied with the reason that names the waiting files.
    expect(edit("Write", "d.ts")).toBe(deny);
    expect(edit("Edit", "README.md")).toBe(deny);
    expect(edit("Write", "src/new.ts")).toBe(deny);
    // A path outside the repository, or none at all.
    expect(reviewFirstToolDecision(hold, "Write", { file_path: "/elsewhere/a.ts" }, { file: "/elsewhere/a.ts" })).toBe(deny);
    expect(reviewFirstToolDecision(hold, "Write", {})).toBe(deny);
    // Plan files and Claude's memory are outside the review.
    expect(reviewFirstToolDecision(hold, "Write", {}, { file: "/p/plan.md", exempt: (f) => f.startsWith("/p/") })).toBeNull();
    // Bash runs (tests, builds, formatters go with a fix); reads and every other tool too.
    for (const command of ["touch x", "npm test", "sed -i s/a/b/ README.md", "git commit -m x", "git status"]) {
      expect(reviewFirstToolDecision(hold, "Bash", { command }), command).toBeNull();
    }
    expect(reviewFirstToolDecision(hold, "Read", { file_path: join(root, "README.md") })).toBeNull();
    // Nothing held: everything goes on.
    expect(reviewFirstToolDecision(null, "Write", {}, { file: join(root, "README.md") })).toBeNull();
    expect(reviewFirstToolDecision({ ...hold, waiting: [] }, "Write", {}, { file: join(root, "README.md") })).toBeNull();
    expect(deny).toBe(
      "[Review gate] 2 files are waiting for the user's review (src/a.ts, b.ts). You may fix those files; changes to other files wait until the user has reviewed them.",
    );
    expect(reviewFirstFixReason(["a", "b", "c", "d"])).toContain("4 files are waiting for the user's review (a, b, c, …)");
  });

  it("the path is resolved as the gate resolves it: relative spellings, a symlink into the repository, the case on macOS / Windows", () => {
    const root = makeRepo();
    write(root, "src/a.ts", "a\n");
    expect(isFixable(join(root, "src", "..", "src", "a.ts"), ["src/a.ts"], root)).toBe(true);
    const link = join(temp("rg-rf-link"), "repo");
    symlinkSync(root, link);
    expect(isFixable(join(link, "src", "a.ts"), ["src/a.ts"], root)).toBe(true);
    // A case-only spelling names the same file where the file system is case-insensitive (the default on macOS / Windows).
    const insensitive = process.platform === "darwin" || process.platform === "win32";
    expect(isFixable(join(root, "SRC", "A.ts"), ["src/a.ts"], root)).toBe(insensitive);
    mkdirSync(join(root, "gone"));
    expect(isFixable(join(root, "gone", "Deleted.ts"), ["gone/deleted.ts"], root)).toBe(insensitive);
    expect(isFixable(join(root, "src", "a.ts"), ["src/a.ts"], null)).toBe(false);
    expect(isFixable(join(root, "src", "b.ts"), ["src/a.ts"], root)).toBe(false);
  });

  it("the tool decision (prompts): every call that changes files is denied while files wait, as before 0.5.26", () => {
    const hold: ReviewFirstHold = { mode: "prompts", waiting: ["a.ts"], fixable: ["a.ts"], root: "/r" };
    const write_ = { file_path: "/r/a.ts", content: "x" };
    expect(reviewFirstToolDecision(hold, "Read", { file_path: "/r/a.ts" })).toBeNull();
    expect(reviewFirstToolDecision(hold, "Bash", { command: "git diff" })).toBeNull();
    expect(reviewFirstToolDecision(hold, "Bash", { command: "touch x" })).toBe(reviewFirstToolReason(["a.ts"]));
    expect(reviewFirstToolDecision(hold, "Write", write_, { file: "/r/a.ts" })).toBe(reviewFirstToolReason(["a.ts"]));
    expect(reviewFirstToolReason(["a.ts"])).toBe(
      "[Review gate] 1 file is waiting for the user's review (a.ts). Do not change files until the user accepts or rejects them — answer questions, read and plan only.",
    );
    expect(reviewFirstToolReason(["a.ts", "b.ts", "c.ts", "d.ts"])).toContain("4 files are waiting for the user's review (a.ts, b.ts, c.ts, …)");
  });

  it("the line every prompt carries while files wait", () => {
    expect(reviewFirstContext("edits", ["a.ts", "b.ts", "c.ts"])).toBe("[Review gate] 3 files await review. Fixing them is fine; other changes wait until the user reviewed them.");
    expect(reviewFirstContext("edits", ["a.ts"])).toBe("[Review gate] 1 file awaits review. Fixing it is fine; other changes wait until the user reviewed it.");
    expect(reviewFirstContext("prompts", ["a.ts", "b.ts", "c.ts"])).toBe("[Review gate] 3 files await review; questions only until then.");
  });

  it("the prompt decision: only in prompts mode, never a slash command", () => {
    expect(reviewFirstPromptDecision("edits", ["a.ts"], "go on")).toBeNull();
    expect(reviewFirstPromptDecision("off", ["a.ts"], "go on")).toBeNull();
    expect(reviewFirstPromptDecision("prompts", null, "go on")).toBeNull();
    expect(reviewFirstPromptDecision("prompts", ["a.ts"], " /compact")).toBeNull();
    expect(reviewFirstPromptDecision("prompts", ["a.ts", "b.ts"], "go on")).toBe(reviewFirstPromptReason(["a.ts", "b.ts"]));
    expect(reviewFirstPromptReason(["a.ts", "b.ts"])).toContain("2 files are waiting (a.ts, b.ts)");
  });
});

/** What the engine holds Claude back with while `waiting` files wait in a review of `listed` (default: the waiting ones). */
const holdOf = (root: string, waiting: string[], listed = waiting, mode: ReviewFirstHold["mode"] = "edits"): ReviewFirstHold => ({ mode, waiting, fixable: listed, root });

/** The classic chat's hooks with the engine's live answer. */
function hookCtx(root: string, waiting: () => ReviewFirstHold | null): HookContext & { events: SessionEvent[]; denied: string[] } {
  const events: SessionEvent[] = [];
  const denied: string[] = [];
  return {
    budget: new BudgetState({ maxFiles: 0, maxLines: 0 }),
    cwd: root,
    root,
    ignorePatterns: [],
    autoAllowTools: new Set(),
    reviewFirst: waiting,
    onReviewFirst: (tool) => denied.push(tool),
    emit: (e) => events.push(e),
    log: () => {},
    events,
    denied,
  };
}

const pre = (tool: string, input: Record<string, unknown>, cwd: string, extra: Record<string, unknown> = {}): HookInput =>
  ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, session_id: "s", transcript_path: "", cwd, tool_use_id: `t-${Math.random()}`, ...extra }) as unknown as HookInput;

function decision(out: unknown): { decision?: string; reason?: string } {
  const h = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return { decision: h?.permissionDecision, reason: h?.permissionDecisionReason };
}

describe("classic chat: PreToolUse (hooks.ts)", () => {
  it("edits: a file under review may be fixed — by subagents too; other files are denied; Bash and reads run; an accept lifts it", async () => {
    const root = makeRepo();
    let hold: ReviewFirstHold | null = holdOf(root, ["README.md", "new.txt"]);
    const ctx = hookCtx(root, () => hold);
    const hooks = buildHooks(ctx);
    const preEdit = hooks.PreToolUse![0]!.hooks[0]!;
    const preBash = hooks.PreToolUse![1]!.hooks[0]!;
    const preOther = hooks.PreToolUse![2]!.hooks[0]!;
    const opts = { signal: new AbortController().signal };
    const reason = reviewFirstFixReason(["README.md", "new.txt"]);

    expect(decision(await preEdit(pre("Write", { file_path: join(root, "x.ts"), content: "x" }, root), "t", opts))).toEqual({ decision: "deny", reason });
    expect(decision(await preEdit(pre("Edit", { file_path: join(root, "README.md"), old_string: "a", new_string: "b" }, root, { agent_id: "sub-1" }), "t", opts)).decision).not.toBe("deny");
    expect(decision(await preEdit(pre("Write", { file_path: "new.txt", content: "x" }, root), "t", opts)).decision).not.toBe("deny");
    expect(decision(await preBash(pre("Bash", { command: "touch x" }, root), "t", opts)).decision).not.toBe("deny");
    expect(decision(await preOther(pre("Read", { file_path: join(root, "README.md") }, root), "t", opts)).decision).not.toBe("deny");
    expect(ctx.denied).toEqual(["Write"]);

    hold = null; // every file accepted / rejected
    expect(decision(await preEdit(pre("Write", { file_path: join(root, "x.ts"), content: "x" }, root), "t", opts)).decision).not.toBe("deny");
    expect(ctx.denied).toHaveLength(1);
  });

  it("prompts: edit tools and writing Bash are denied, the files under review too; read-only Bash runs", async () => {
    const root = makeRepo();
    const ctx = hookCtx(root, () => holdOf(root, ["README.md"], ["README.md"], "prompts"));
    const hooks = buildHooks(ctx);
    const preEdit = hooks.PreToolUse![0]!.hooks[0]!;
    const preBash = hooks.PreToolUse![1]!.hooks[0]!;
    const opts = { signal: new AbortController().signal };
    const reason = reviewFirstToolReason(["README.md"]);
    expect(decision(await preEdit(pre("Edit", { file_path: join(root, "README.md"), old_string: "a", new_string: "b" }, root), "t", opts))).toEqual({ decision: "deny", reason });
    expect(decision(await preBash(pre("Bash", { command: "touch x" }, root), "t", opts))).toEqual({ decision: "deny", reason });
    expect(decision(await preBash(pre("Bash", { command: "git status" }, root), "t", opts)).decision).not.toBe("deny");
    expect(ctx.denied).toEqual(["Edit", "Bash"]);
  });

  it("a plan file in plan mode stays writable", async () => {
    const root = makeRepo();
    const plans = temp("rg-plans");
    const ctx = { ...hookCtx(root, () => holdOf(root, ["README.md"])), permissionMode: "plan" as const, plansDir: plans };
    const preEdit = buildHooks(ctx).PreToolUse![0]!.hooks[0]!;
    const out = await preEdit(pre("Write", { file_path: join(plans, "plan.md"), content: "# plan" }, root), "t", { signal: new AbortController().signal });
    expect(decision(out).decision).toBe("allow");
  });
});

/** One reviewed turn in a classic chat (FakeClaudeSession): README.md changed, new.txt added. */
async function reviewedTurn(h: Harness, dir: string): Promise<void> {
  await h.engine.handle({ type: "send", text: "Change README" });
  h.session().emitSessionInfo();
  write(dir, "README.md", "line1\nline2 changed\nline3\n");
  write(dir, "new.txt", "brand new\n");
  h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "README.md"), tools: ["Edit"], count: 1 }] });
  await h.waitFor((s) => s.gate.phase === "reviewing", "review");
  await h.settle();
}

async function result(h: Harness, cmd: Record<string, unknown>): Promise<{ ok: boolean; error?: string; code?: string } | undefined> {
  const id = `r${Math.random().toString(36).slice(2)}`;
  await h.engine.handle({ ...cmd, id } as Parameters<Harness["engine"]["handle"]>[0]);
  return h.ofType("result").find((e) => e.id === id) as { ok: boolean; error?: string; code?: string } | undefined;
}

describe("classic chat through the engine", () => {
  async function opened(settings: Record<string, unknown> = {}): Promise<{ h: Harness; dir: string }> {
    const dir = makeRepo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello(settings);
    await h.open(dir);
    return { h, dir };
  }

  it("the turn that makes the files is not held back; the next one is (default edits): its message says so, a denied call leaves a row once", async () => {
    const { h, dir } = await opened();
    const waiting = (): readonly string[] | null => h.session().opts.reviewFirst!()?.waiting ?? null;
    // A fresh turn: what it changes is not in the review until it ends.
    await h.engine.handle({ type: "send", text: "Change README" });
    h.session().emitSessionInfo();
    write(dir, "README.md", "line1\nline2 changed\nline3\n");
    expect(waiting()).toBeNull();
    expect(h.engine.state.gate.reviewFirst).toBeNull();
    write(dir, "new.txt", "brand new\n");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "README.md"), tools: ["Edit"], count: 1 }] });
    await h.waitFor((s) => s.gate.phase === "reviewing", "review");
    await h.settle();
    expect(waiting()).toEqual(["README.md", "new.txt"]);
    expect(h.session().opts.reviewFirst!()).toEqual({ mode: "edits", waiting: ["README.md", "new.txt"], fixable: ["README.md", "new.txt"], root: realpathSync(dir) });
    expect(h.engine.state.gate.reviewFirst).toEqual({ mode: "edits", waiting: 2, blocked: 0 });

    // A question during the review: allowed, Claude is told the rule, the files still wait.
    const before = h.session().sends.length;
    await h.engine.handle({ type: "send", text: "why line 2?" });
    expect(h.session().sends[before]!.text).toBe("[Review gate] 2 files await review. Fixing them is fine; other changes wait until the user reviewed them.\n\nwhy line 2?");
    expect(waiting()).toEqual(["README.md", "new.txt"]);
    // The hooks deny (the session reports it): one quiet row per turn, the count in the state.
    h.session().opts.emit({ type: "review_first_denied", toolName: "Write" });
    h.session().opts.emit({ type: "review_first_denied", toolName: "Bash" });
    await h.settle();
    const rows = h.ofType("error").filter((e) => e.code === "review_first_blocked");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fatal: false, scope: "session", detail: "2" });
    expect(h.engine.state.gate.reviewFirst).toEqual({ mode: "edits", waiting: 2, blocked: 2 });

    // Accepting lifts it at once (during the turn: §34.2), one file is not enough.
    await h.engine.handle({ type: "accept", paths: ["README.md"] });
    expect(waiting()).toEqual(["new.txt"]);
    expect(h.session().opts.reviewFirst!()?.fixable).toEqual(["README.md", "new.txt"]); // the accepted file may still be fixed
    await h.engine.handle({ type: "accept_all" });
    expect(waiting()).toBeNull();
    await h.settle();
    expect(h.engine.state.gate.reviewFirst).toBeNull();
  });

  it("a change request's turn may edit; off restores the old behaviour", async () => {
    const { h, dir } = await opened();
    await reviewedTurn(h, dir);
    await h.engine.handle({ type: "add_note", path: "README.md", line: 2, side: "new", excerpt: "line2 changed", body: "shorter" });
    await h.engine.handle({ type: "request_changes" });
    await h.waitFor((s) => s.gate.isRequestingChanges, "request running");
    expect(h.session().opts.reviewFirst!()).toBeNull();
    expect(h.engine.state.gate.reviewFirst).toBeNull();
    h.session().emitTurnEnd({ toolFiles: [] });
    await h.waitFor((s) => s.gate.phase === "reviewing" && !s.gate.isRequestingChanges, "request collected");
    expect(h.session().opts.reviewFirst!()).not.toBeNull();
    await h.engine.handle({ type: "set_settings", settings: { reviewFirst: "off" } });
    expect(h.session().opts.reviewFirst!()).toBeNull();
    const before = h.session().sends.length;
    await h.engine.handle({ type: "send", text: "go on" });
    expect(h.session().sends[before]!.text).toBe("go on");
  });

  it("prompts: a new message is refused while files wait; Accept N & Send accepts first and goes", async () => {
    const { h, dir } = await opened({ reviewFirst: "prompts" });
    await reviewedTurn(h, dir);
    expect(h.engine.state.gate.reviewFirst).toMatchObject({ mode: "prompts", waiting: 2 });
    expect(await result(h, { type: "send", text: "go on" })).toMatchObject({ ok: false, error: "gate_closed:review_first", code: "gate_closed" });
    expect(h.engine.state.gate.phase).toBe("reviewing");
    const before = h.session().sends.length;
    expect(await result(h, { type: "send", text: "Continue.", acceptPending: true })).toMatchObject({ ok: true });
    const sent = h.session().sends[before]!.text;
    expect(sent).toContain("[Review gate] Accepted:");
    expect(sent).not.toContain("await review");
    expect(h.session().opts.reviewFirst!()).toBeNull();
  });
});

describe("terminal chat through the hook server (§57.4)", () => {
  type Rig = { h: Harness; dir: string };
  type Spec = { url: string; token: string; sessionId: string; cwd: string };
  const platform = { ...fakePlatform, isWindows: process.platform === "win32" };

  async function rig(settings: Record<string, unknown> = {}): Promise<{ r: Rig; s: Spec }> {
    const dir = makeRepo();
    const config = temp("rg-rf-config");
    const claude = makeFakeClaude(temp("rg-rf-bin"));
    const h = makeHarness({ platform, env: { CLAUDE_CONFIG_DIR: config }, dataDir: temp("rg-rf-data") });
    harnesses.push(h);
    await h.engine.handle({ type: "hello", protocolVersion: 2, client: "mac", settings: { budget: { maxFiles: 0, maxLines: 0 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", claudePath: claude, ghHost: "github.com", ...settings } });
    await h.settle();
    await h.open(dir);
    await h.engine.handle({ type: "session_new", kind: "terminal" });
    const st = await h.waitFor((x) => x.session.terminal !== undefined && x.session.open, "terminal chat");
    const ev = await h.engine.request({ type: "terminal_spec", sessionId: st.sessions.currentId! });
    const parsed = JSON.parse(ev.argv[ev.argv.indexOf("--settings") + 1]!) as { hooks: { Stop: { hooks: { url: string }[] }[] } };
    return { r: { h, dir }, s: { url: parsed.hooks.Stop[0]!.hooks[0]!.url, token: ev.env.RG_HOOK_TOKEN!, sessionId: ev.sessionId, cwd: ev.cwd } };
  }

  async function hook(s: Spec, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(s.url, { method: "POST", headers: { "Content-Type": "application/json", "X-ReviewGate-Token": s.token }, body: JSON.stringify({ session_id: s.sessionId, cwd: s.cwd, transcript_path: "/dev/null", permission_mode: "default", ...body }) });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }
  const ups = (prompt_id: string, prompt = "add a note") => ({ hook_event_name: "UserPromptSubmit", prompt, prompt_id });
  const preWrite = (r: Rig, f: string, prompt_id: string) => ({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(r.dir, f), content: "x\n" }, tool_use_id: `w-${prompt_id}-${f}`, prompt_id });
  const preBash = (command: string, prompt_id: string) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: `b-${prompt_id}-${command}`, prompt_id });
  const context = (out: Record<string, unknown>): string => String((out.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "");

  /** prompt → Write (allowed: the turn makes the file) → Stop; the review collected. */
  async function firstTurn(r: Rig, s: Spec): Promise<void> {
    expect(await hook(s, ups("p1"))).toEqual({});
    expect(await hook(s, preWrite(r, "notes.txt", "p1"))).toEqual({});
    write(r.dir, "notes.txt", "note\n");
    await hook(s, { ...preWrite(r, "notes.txt", "p1"), hook_event_name: "PostToolUse", tool_response: { type: "create" } });
    // A second file in the same turn is still the turn's own.
    expect(await hook(s, preWrite(r, "more.txt", "p1"))).toEqual({});
    write(r.dir, "more.txt", "more\n");
    expect(await hook(s, { hook_event_name: "Stop", stop_hook_active: false })).toEqual({});
    await r.h.waitFor((x) => x.gate.phase === "reviewing" && x.changedFiles.length === 2, "collected");
  }

  it("edits: the next prompt is told the rule; a file under review may be fixed, other files are denied, Bash runs; accept_all lifts it", async () => {
    const { r, s } = await rig();
    await firstTurn(r, s);
    const answer = await hook(s, ups("p2", "fix the note"));
    expect(context(answer)).toContain("[Review gate] 2 files await review. Fixing them is fine; other changes wait until the user reviewed them.");
    const denied = await hook(s, preWrite(r, "x.txt", "p2"));
    expect(denied).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reviewFirstFixReason(["more.txt", "notes.txt"]) } });
    expect(await hook(s, preWrite(r, "notes.txt", "p2"))).toEqual({});
    expect((await hook(s, preBash("touch y", "p2"))).hookSpecificOutput).toBeUndefined();
    expect(await hook(s, preBash("git status", "p2"))).toEqual({});
    await r.h.settle();
    expect(r.h.engine.state.gate.reviewFirst).toEqual({ mode: "edits", waiting: 2, blocked: 1 });
    expect(r.h.ofType("error").filter((e) => e.code === "review_first_blocked")).toHaveLength(1);
    // Accepted while the question turn runs (§34.2): lifted at once.
    await r.h.engine.handle({ type: "accept_all" });
    expect(await hook(s, preWrite(r, "x.txt", "p2"))).toEqual({});
  });

  it("prompts: a new prompt is blocked in the TUI; Accept N & Continue (accept_all, then the prompt) goes", async () => {
    const { r, s } = await rig({ reviewFirst: "prompts" });
    await firstTurn(r, s);
    const blocked = await hook(s, ups("p2", "go on"));
    expect(blocked).toEqual({ decision: "block", reason: reviewFirstPromptReason(["more.txt", "notes.txt"]) });
    expect(r.h.engine.state.gate.phase).toBe("reviewing");
    // A slash command is never held.
    expect((await hook(s, ups("p3", "/help"))).decision).toBeUndefined();
    await hook(s, { hook_event_name: "Stop", stop_hook_active: false });
    await r.h.waitFor((x) => x.gate.phase === "reviewing", "slash turn over");
    await r.h.engine.handle({ type: "accept_all" });
    const go = await hook(s, ups("p4", "Continue."));
    expect(go.decision).toBeUndefined();
    expect(context(go)).toContain("[Review gate] Accepted:");
    expect(context(go)).not.toContain("await review");
    expect(await hook(s, preWrite(r, "x.txt", "p4"))).toEqual({});
  });

  it("a Request changes delivered at Stop lets the rest of that turn edit", async () => {
    const { r, s } = await rig();
    await firstTurn(r, s);
    await r.h.engine.handle({ type: "add_note", path: "notes.txt", line: 1, side: "new", excerpt: "note", body: "rename it" });
    await hook(s, ups("p2", "a question"));
    expect((await hook(s, preWrite(r, "other.txt", "p2"))).hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    await r.h.engine.handle({ type: "request_changes" });
    expect((await hook(s, { hook_event_name: "Stop", stop_hook_active: false })).decision).toBe("block");
    expect(await hook(s, preWrite(r, "other.txt", "p2"))).toEqual({});
  });
});
