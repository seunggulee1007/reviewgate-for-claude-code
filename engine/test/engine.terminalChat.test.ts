import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalSpecEvent } from "../src/protocol.js";
import { cliSessionFile } from "../src/session/cliRecords.js";
import { RETIRED_REASON } from "../src/session/hookServer.js";
import { CONTINUED_TITLE_SUFFIX } from "../src/engine.js";
import { TERMINAL_GIT_ASK_REASON, TERMINAL_GIT_DENY_REASON, TERMINAL_GIT_NO_ASK_REASON } from "../src/session/terminalGuard.js";
import { BACKGROUND_PROMPT_REASON, BACKGROUND_TOOL_REASON, movingReason, STOP_FEEDBACK_PREFIX } from "../src/session/terminalSession.js";
import { spawn, type ChildProcess } from "node:child_process";
import { NO_MANAGED_POLICY, type ManagedPolicy } from "../src/statusline/managed.js";
import { fakePlatform, makeHarness, type Harness } from "./helpers/engine.js";
import { makeFakeClaude } from "./helpers/fakeClaude.js";
import { fileExists, makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §57: terminal chats through the engine — `session_new {kind}`, `terminal_spec`, the hooks over real
 * HTTP on 127.0.0.1 driving the review gate, the refusals. Never the real `claude` (a fake answering `--version`) and
 * never the real ~/.claude (a temp CLAUDE_CONFIG_DIR).
 */

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
  const dir = temp("rg-term-engine");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "hello\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

/**
 * The engine sees the platform it runs on: on Windows the fake `claude` is npm's `claude.cmd` shim, which only an engine
 * that knows it is on Windows looks through (helpers/fakeClaude.ts). Terminal chats are Mac-only for the clients, but the
 * engine side tested here is the same everywhere.
 */
const platform = { ...fakePlatform, isWindows: process.platform === "win32" };

type Rig = { h: Harness; dir: string; config: string; claude: string };

async function rig(o: { client?: "mac" | "windows" | "test"; version?: string; managed?: ManagedPolicy; dir?: string; config?: string; newChatKind?: "chat" | "terminal"; promptWaitMs?: number } = {}): Promise<Rig> {
  const dir = o.dir ?? makeRepo();
  const config = o.config ?? temp("rg-term-config");
  const claude = makeFakeClaude(temp("rg-term-bin"), o.version);
  const h = makeHarness({ platform, env: { CLAUDE_CONFIG_DIR: config }, managedPolicy: () => o.managed ?? NO_MANAGED_POLICY, dataDir: temp("rg-term-data"), ...(o.promptWaitMs ? { terminalPromptWaitMs: o.promptWaitMs } : {}) });
  harnesses.push(h);
  await h.engine.handle({ type: "hello", protocolVersion: 2, client: o.client ?? "mac", settings: { budget: { maxFiles: 0, maxLines: 0 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", claudePath: claude, ghHost: "github.com", ...(o.newChatKind ? { newChatKind: o.newChatKind } : {}) } });
  await h.settle();
  const opened = await h.open(dir);
  expect(opened.session.open).toBe(true);
  return { h, dir, config, claude };
}

async function newTerminal(r: Rig): Promise<string> {
  await r.h.engine.handle({ type: "session_new", kind: "terminal" });
  const s = await r.h.waitFor((st) => st.session.terminal !== undefined && st.session.open, "terminal chat");
  return s.sessions.currentId!;
}

async function refusal(h: Harness, cmd: Parameters<Harness["engine"]["handle"]>[0]): Promise<{ ok: boolean; error?: string; code?: string } | undefined> {
  const id = `r${Math.random().toString(36).slice(2)}`;
  await h.engine.handle({ ...cmd, id } as typeof cmd);
  return h.ofType("result").find((e) => e.id === id) as { ok: boolean; error?: string; code?: string } | undefined;
}

type Spec = TerminalSpecEvent & { url: string; token: string };
async function spec(r: Rig, sessionId: string): Promise<Spec> {
  const ev = await r.h.engine.request({ type: "terminal_spec", sessionId });
  const settings = JSON.parse(ev.argv[ev.argv.indexOf("--settings") + 1]!) as { hooks: { Stop: { hooks: { url: string }[] }[] } };
  return { ...ev, url: settings.hooks.Stop[0]!.hooks[0]!.url, token: ev.env.RG_HOOK_TOKEN! };
}

async function hook(s: Spec, body: Record<string, unknown>, token = s.token): Promise<Record<string, unknown>> {
  const res = await fetch(s.url, { method: "POST", headers: { "Content-Type": "application/json", "X-ReviewGate-Token": token }, body: JSON.stringify({ session_id: s.sessionId, cwd: s.cwd, transcript_path: "/dev/null", permission_mode: "default", ...body }) });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const ups = (prompt_id: string, prompt = "add a note") => ({ hook_event_name: "UserPromptSubmit", prompt, prompt_id });
const write_ = (file: string, id: string, prompt_id = "p1") => ({ tool_name: "Write", tool_input: { file_path: file, content: "note\n" }, tool_use_id: id, prompt_id });

/** One full turn: prompt → Write → Stop; resolves with the prompt's answer once the review is collected. */
async function turn(r: Rig, s: Spec, promptId: string, file = "notes.txt", prompt = "add a note"): Promise<Record<string, unknown>> {
  const answer = await hook(s, ups(promptId, prompt));
  write(r.dir, file, `note ${promptId}\n`);
  expect(await hook(s, { hook_event_name: "PreToolUse", ...write_(file, `w-${promptId}`, promptId) })).toEqual({});
  await hook(s, { hook_event_name: "PostToolUse", ...write_(file, `w-${promptId}`, promptId), tool_response: { type: "create", filePath: join(r.dir, file) } });
  expect(await hook(s, { hook_event_name: "Stop", stop_hook_active: false })).toEqual({});
  await r.h.waitFor((st) => st.gate.phase === "reviewing" && st.changedFiles.some((f) => f.path === file), "terminal turn collected");
  return answer;
}

describe("terminal chats (§57)", () => {
  it("session_new {kind: terminal} is stored, starts no CLI, and survives a reopen", async () => {
    const r = await rig();
    const before = r.h.sessions.length;
    const id = await newTerminal(r);
    expect(r.h.sessions.length).toBe(before); // no CLI session object of the chat kind
    const st = r.h.engine.state;
    expect(st.sessions.list.find((m) => m.id === id)?.kind).toBe("terminal");
    expect(st.session.terminal).toEqual({ running: false, hooksSeen: false, promptId: null, waiting: null, interruptSuspected: false });
    expect(st.session.ready).toBe(true);
    // A chat stays a chat (no kind, no terminal state).
    await r.h.engine.handle({ type: "session_new" });
    const chat = await r.h.waitFor((s) => s.session.terminal === undefined && s.sessions.currentId !== id, "chat");
    expect(chat.sessions.list.find((m) => m.id === chat.sessions.currentId)?.kind).toBeUndefined();
    // Reopened (another engine on the same repo): the terminal chat is still one.
    await r.h.engine.handle({ type: "session_open", sessionId: id });
    await r.h.waitFor((s) => s.session.terminal !== undefined, "terminal again");
    await r.h.engine.dispose();
    const again = await rig({ dir: r.dir, config: r.config });
    expect(again.h.engine.state.sessions.currentId).toBe(id);
    expect(again.h.engine.state.session.terminal).toBeDefined();
  });

  it("§57.7 newChatKind: a project with no chat opens with a terminal chat (Mac); other clients and session_new keep chats", async () => {
    const mac = await rig({ newChatKind: "terminal" });
    const first = mac.h.engine.state;
    expect(first.sessions.list.find((m) => m.id === first.sessions.currentId)?.kind).toBe("terminal");
    expect(first.session.terminal).toBeDefined();
    // session_new names its kind itself: none is a chat whatever the default.
    await mac.h.engine.handle({ type: "session_new" });
    const chat = await mac.h.waitFor((s) => s.session.terminal === undefined && s.sessions.currentId !== first.sessions.currentId, "chat");
    expect(chat.sessions.list.find((m) => m.id === chat.sessions.currentId)?.kind).toBeUndefined();
    // An existing chat keeps its kind: reopened with the default on, the chat is still the current one and a chat.
    await mac.h.engine.dispose();
    const again = await rig({ dir: mac.dir, config: mac.config, newChatKind: "terminal" });
    expect(again.h.engine.state.sessions.currentId).toBe(chat.sessions.currentId);
    expect(again.h.engine.state.session.terminal).toBeUndefined();
    // Windows never gets a terminal chat from the setting (it cannot run one).
    const win = await rig({ client: "windows", newChatKind: "terminal" });
    const w = win.h.engine.state;
    expect(w.sessions.list.find((m) => m.id === w.sessions.currentId)?.kind).toBeUndefined();
    expect(w.session.terminal).toBeUndefined();
    // Absent = chat.
    const plain = await rig();
    expect(plain.h.engine.state.session.terminal).toBeUndefined();
  });

  it("terminal_spec: the claude argv, the token in env only, the project folder", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    expect(s.argv.slice(0, 3)).toEqual([r.claude, `--session-id=${id}`, "--settings"]);
    expect(s.argv[4]).toBe("--append-system-prompt");
    expect(s.resume).toBe(false);
    expect(s.cwd).toBe(r.dir);
    expect(Object.keys(s.env)).toEqual(["RG_HOOK_TOKEN"]);
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
    expect(s.argv.join(" ")).not.toContain(s.token);
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook$/);
    // A second spec retires the first token.
    const s2 = await spec(r, id);
    expect(s2.token).not.toBe(s.token);
    expect(await hook(s, ups("p0"), s.token)).toEqual({ decision: "block", reason: RETIRED_REASON });
  });

  it("a full turn over HTTP: prompt → Write → Stop gives a review; a rejected file goes back with the next prompt", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    await r.h.engine.handle({ type: "terminal_started", sessionId: id, pid: 4242 });
    expect(r.h.engine.state.session.terminal?.running).toBe(true);
    expect([...((r.h.engine as unknown as { ownCliPids(): Set<number> | null }).ownCliPids() ?? [])]).toEqual([4242]);

    expect(await turn(r, s, "p1")).toEqual({});
    const st = r.h.engine.state;
    expect(st.changedFiles.map((f) => f.path)).toEqual(["notes.txt"]);
    expect(st.session.terminal).toMatchObject({ hooksSeen: true, promptId: null });
    expect(r.h.ofType("turn_end")).toHaveLength(1);
    expect(r.h.ofType("user_message").at(-1)).toMatchObject({ text: "add a note", turn: 1 });
    const meta = st.sessions.list.find((m) => m.id === id)!;
    expect(meta).toMatchObject({ title: "add a note", lastUserText: "add a note", cliKnown: true });

    await r.h.engine.handle({ type: "reject", paths: ["notes.txt"] });
    expect(fileExists(join(r.dir, "notes.txt"))).toBe(false);
    const next = await hook(s, ups("p2", "go on"));
    expect(next).toMatchObject({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } });
    expect(String((next.hookSpecificOutput as { additionalContext: string }).additionalContext)).toContain("Rejected (reverted on disk");
    expect(r.h.engine.state.gate.phase).toBe("running");
    expect(r.h.engine.state.session.terminal?.promptId).toBe("p2");
  });

  it("refusals: chat-only commands (terminal_chat), another chat (terminal_not_current)", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    for (const cmd of [{ type: "restart_session" }, { type: "send", text: "hi" }, { type: "interrupt" }, { type: "set_model", model: "haiku" }, { type: "btw_ask", question: "q" }, { type: "side_promote", threadId: "t", as: "message" }, { type: "permission_response", requestId: "x", allow: true }] as const) {
      expect(await refusal(r.h, cmd), cmd.type).toMatchObject({ ok: false, code: "terminal_chat" });
    }
    expect(await refusal(r.h, { type: "terminal_spec", sessionId: "other" })).toMatchObject({ ok: false, code: "terminal_not_current" });
    expect(await refusal(r.h, { type: "terminal_started", sessionId: "other", pid: 1 })).toMatchObject({ ok: false, code: "terminal_not_current" });
    // In a chat, terminal_spec of the chat itself is not current either.
    await r.h.engine.handle({ type: "session_new" });
    const chat = (await r.h.waitFor((s) => s.session.terminal === undefined && s.sessions.currentId !== id, "chat")).sessions.currentId!;
    expect(await refusal(r.h, { type: "terminal_spec", sessionId: chat })).toMatchObject({ ok: false, code: "terminal_not_current" });
    expect(await refusal(r.h, { type: "send", text: "fine in a chat" })).toMatchObject({ ok: true });
  });

  it("refusals: windows clients (terminal_unsupported), an old CLI, hooks turned off", async () => {
    const win = await rig({ client: "windows" });
    expect(await refusal(win.h, { type: "session_new", kind: "terminal" })).toMatchObject({ ok: false, code: "terminal_unsupported" });

    const old = await rig({ version: "2.1.200" });
    const oldId = await newTerminal(old);
    expect(await refusal(old.h, { type: "terminal_spec", sessionId: oldId })).toMatchObject({ ok: false, code: "terminal_cli_too_old" });

    const off = await rig();
    const offId = await newTerminal(off);
    writeFileSync(join(off.config, "settings.json"), JSON.stringify({ disableAllHooks: true }));
    expect(await refusal(off.h, { type: "terminal_spec", sessionId: offId })).toMatchObject({ ok: false, code: "terminal_hooks_disabled" });
    writeFileSync(join(off.config, "settings.json"), "{}");
    mkdirSync(join(off.dir, ".claude"), { recursive: true });
    writeFileSync(join(off.dir, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));
    expect(await refusal(off.h, { type: "terminal_spec", sessionId: offId })).toMatchObject({ ok: false, code: "terminal_hooks_disabled" });

    const managed = await rig({ managed: { settings: { allowManagedHooksOnly: true }, sources: [{ kind: "file", path: "/etc/example/managed-settings.json" }], failed: null } });
    const mId = await newTerminal(managed);
    expect(await refusal(managed.h, { type: "terminal_spec", sessionId: mId })).toMatchObject({ ok: false, code: "terminal_hooks_disabled", error: "terminal_hooks_disabled:allowManagedHooksOnly" });
  });

  it("§57.8 the guard: git that changes the repository asks, git that throws work away is denied, an outside edit asks", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    await r.h.engine.handle({ type: "terminal_started", sessionId: id, pid: 4343 });
    await hook(s, ups("p1", "fix the README"));
    const pre = (tool_name: string, tool_input: Record<string, unknown>, permission_mode = "auto") =>
      hook(s, { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: `t${Math.random()}`, prompt_id: "p1", permission_mode });
    const answer = (decision: string, reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });
    // The incident: auto mode, `git commit` before the review was accepted — the TUI must ask.
    expect(await pre("Bash", { command: "git add -A && git commit -m 'feat: done'" })).toEqual(answer("ask", TERMINAL_GIT_ASK_REASON));
    expect(await pre("Bash", { command: "git push origin main" }, "bypassPermissions")).toEqual(answer("deny", TERMINAL_GIT_NO_ASK_REASON));
    write(r.dir, "README.md", "edited\n");
    expect(await pre("Bash", { command: "git reset --hard" })).toEqual(answer("deny", TERMINAL_GIT_DENY_REASON));
    expect(await pre("Bash", { command: "git status && git diff" })).toEqual({});
    // Another repository (a clone in the temp folder is real work, not a scratch file).
    const other = temp("rg-term-outside");
    sh(other, "init", "-q");
    const outside = join(other, "notes.md");
    expect((await pre("Write", { file_path: outside, content: "x" })).hookSpecificOutput).toMatchObject({ permissionDecision: "ask" });
    expect(await pre("Write", { file_path: join(r.dir, "inside.md"), content: "x" })).toEqual({});
    // A denied git command before any prompt starts no turn.
    await hook(s, { hook_event_name: "Stop", stop_hook_active: false });
    // Collected, not merely over: a phase read while the collection runs (`collecting`) is gone by the check below.
    await r.h.waitFor((st) => st.gate.phase === "reviewing" || st.gate.phase === "idle", "turn collected");
    const phase = r.h.engine.state.gate.phase;
    expect(await pre("Bash", { command: "git clean -fdx" })).toEqual(answer("deny", TERMINAL_GIT_DENY_REASON));
    await new Promise((res) => setTimeout(res, 200));
    expect(r.h.engine.state.gate.phase).toBe(phase);
    expect(phase).not.toBe("running");
  });

  it("§57.9 session_continue_terminal: a chat's conversation goes on in a new terminal chat; the chat stays a record", async () => {
    const r = await rig();
    const chatId = r.h.engine.state.sessions.currentId!;
    // Refused before the chat has a conversation of the CLI's.
    expect(await refusal(r.h, { type: "session_continue_terminal", sessionId: chatId })).toMatchObject({ ok: false, code: "nothing_to_continue" });
    // One turn: the CLI reports the chat's id.
    const classic = r.h.session();
    await r.h.engine.handle({ type: "send", text: "hello" });
    classic.emitTurnEnd({ sessionId: chatId });
    await r.h.waitFor((st) => st.gate.phase !== "running" && st.gate.phase !== "collecting", "turn over");
    // A file waiting in the review: refused (accept or reject it first).
    const turn2 = r.h.session();
    await r.h.engine.handle({ type: "send", text: "write a note" });
    write(r.dir, "pending.txt", "x\n");
    turn2.emitTurnEnd({ sessionId: chatId, toolFiles: [{ path: "pending.txt", tools: ["Write"], count: 1 }] });
    await r.h.waitFor((st) => st.changedFiles.some((f) => f.path === "pending.txt"), "a pending file");
    expect(await refusal(r.h, { type: "session_continue_terminal", sessionId: chatId })).toMatchObject({ ok: false, code: "review_pending" });
    await r.h.engine.handle({ type: "accept", paths: ["pending.txt"] });
    await r.h.waitFor((st) => !st.changedFiles.some((f) => f.path === "pending.txt" && f.state === "pending"), "accepted");

    expect(await refusal(r.h, { type: "session_continue_terminal", sessionId: chatId })).toMatchObject({ ok: true });
    const st = await r.h.waitFor((x) => x.session.terminal !== undefined && x.sessions.currentId !== chatId, "the terminal chat");
    const id = st.sessions.currentId!;
    const meta = st.sessions.list.find((m) => m.id === id)!;
    const src = st.sessions.list.find((m) => m.id === chatId)!;
    expect(meta).toMatchObject({ kind: "terminal", cliSessionId: chatId, continuedFrom: chatId, cliKnown: true });
    expect(meta.title.endsWith(CONTINUED_TITLE_SUFFIX)).toBe(true);
    expect(src.continuedIn).toBe(id);
    expect(classic.disposed && turn2.disposed).toBe(true); // its CLI stopped first (two processes on one conversation conflict)
    // The terminal resumes the chat's conversation; its first review turn starts at its own first prompt.
    const s = await spec(r, id);
    expect(s.resume).toBe(true);
    expect(s.argv[1]).toBe(`--resume=${chatId}`);
    expect(r.h.engine.state.gate.phase === "idle" || r.h.engine.state.changedFiles.every((f) => f.state !== "pending")).toBe(true);

    // The chat is a record now: opening it never resumes its conversation; continuing it again is refused.
    expect(await refusal(r.h, { type: "session_continue_terminal", sessionId: chatId })).toMatchObject({ ok: false, code: "chat_is_record" });
    expect(await refusal(r.h, { type: "session_continue_terminal", sessionId: id })).toMatchObject({ ok: false, code: "not_a_chat" });
    await r.h.engine.handle({ type: "session_open", sessionId: chatId });
    await r.h.waitFor((x) => x.sessions.currentId === chatId && x.session.open, "the record");
    expect(r.h.session().opts.settings.resumeSessionId).toBeUndefined();
    // Reloaded from disk, the link stays.
    await r.h.engine.dispose();
    const again = await rig({ dir: r.dir, config: r.config });
    const list = again.h.engine.state.sessions.list;
    expect(list.find((m) => m.id === chatId)?.continuedIn).toBe(id);
    expect(list.find((m) => m.id === id)?.continuedFrom).toBe(chatId);

    // Windows has no terminal chat.
    const win = await rig({ client: "windows" });
    expect(await refusal(win.h, { type: "session_continue_terminal", sessionId: win.h.engine.state.sessions.currentId! })).toMatchObject({ ok: false, code: "terminal_unsupported" });
  });

  it("terminal_exited ends the open turn and collects it", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    await r.h.engine.handle({ type: "terminal_started", sessionId: id, pid: 77 });
    await hook(s, ups("p1"));
    write(r.dir, "half.txt", "half\n");
    await hook(s, { hook_event_name: "PostToolUse", ...write_("half.txt", "w1"), tool_response: {} });
    await r.h.engine.handle({ type: "terminal_exited", sessionId: id, exitCode: 0 });
    await r.h.waitFor((st) => st.gate.phase === "reviewing", "collected");
    expect(r.h.engine.state.changedFiles.map((f) => f.path)).toEqual(["half.txt"]);
    expect(r.h.engine.state.session.terminal?.running).toBe(false);
    // A chat no longer current: nothing to end, no refusal.
    expect(await refusal(r.h, { type: "terminal_exited", sessionId: "gone", exitCode: null })).toMatchObject({ ok: true });
  });

  it("a chat switch retires the token: the old terminal's prompts are blocked", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    await r.h.engine.handle({ type: "session_new" });
    await r.h.waitFor((st) => st.session.terminal === undefined && st.sessions.currentId !== id, "chat");
    expect(await hook(s, ups("p1"))).toEqual({ decision: "block", reason: RETIRED_REASON });
    expect(await hook(s, { hook_event_name: "PreToolUse", ...write_("x.txt", "w1") })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("after a turn, another engine on the same repo resumes the conversation; /clear in the TUI is followed", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    await turn(r, s, "p1");
    await r.h.engine.handle({ type: "accept_all" });
    // The TUI's /clear: the next prompt carries another session id (a forged, non-UUID one before it is ignored).
    const cleared = "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a";
    await hook(s, { hook_event_name: "SessionEnd", reason: "clear", session_id: "--dangerously-skip-permissions" });
    await hook(s, { ...ups("p2", "/help"), session_id: cleared });
    await r.h.waitFor((st) => st.sessions.list.find((m) => m.id === id)?.cliSessionId === cleared, "cliSessionId");
    expect(r.h.engine.state.sessions.currentId).toBe(id); // the chat keeps its id
    await r.h.engine.dispose();
    const again = await rig({ dir: r.dir, config: r.config });
    expect(again.h.engine.state.sessions.currentId).toBe(id);
    const s2 = await spec(again, id);
    expect(s2.resume).toBe(true);
    expect(s2.argv[1]).toBe(`--resume=${cleared}`);
    expect(s2.argv).not.toContain("--dangerously-skip-permissions");
  });

  it("a conversation the CLI no longer has (purged) starts fresh under a new id instead of --resume failing again", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    await turn(r, s, "p1");
    // The CLI keeps this project's conversations here; it has none of this chat's (unknown folder: resume as before).
    expect((await spec(r, id)).argv[1]).toBe(`--resume=${id}`);
    const projects = dirname(cliSessionFile(r.dir, id, { CLAUDE_CONFIG_DIR: r.config }));
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a.jsonl"), "");
    const fresh = await spec(r, id);
    expect(fresh.resume).toBe(false);
    const cliId = /^--session-id=(.+)$/.exec(fresh.argv[1]!)?.[1];
    expect(cliId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(cliId).not.toBe(id);
    const meta = r.h.engine.state.sessions.list.find((m) => m.id === id);
    expect(meta?.cliSessionId).toBe(cliId); // the chat keeps its id
    expect(r.h.engine.state.sessions.currentId).toBe(id);
    // Once the CLI has the new conversation, it is resumed.
    writeFileSync(join(projects, `${cliId}.jsonl`), "");
    expect((await spec(r, id)).argv[1]).toBe(`--resume=${cliId}`);
  });

  it("Notification: waiting is set (permission / question) and cleared by the next hook", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    await hook(s, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
    let st = await r.h.waitFor((x) => x.session.terminal?.waiting !== null, "waiting");
    expect(st.session.terminal?.waiting).toMatchObject({ kind: "permission", message: "Claude needs your permission to use Bash" });
    await hook(s, ups("p1"));
    st = await r.h.waitFor((x) => x.session.terminal?.waiting === null, "cleared");
    await hook(s, { hook_event_name: "Notification", notification_type: "elicitation_dialog", message: "Which one?" });
    st = await r.h.waitFor((x) => x.session.terminal?.waiting !== null, "question");
    expect(st.session.terminal?.waiting?.kind).toBe("question");
  });

  it("the Esc rule: an interrupted turn stays running; Review now (terminal_end_turn) collects it; no_turn after", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    await hook(s, ups("p1"));
    write(r.dir, "esc.txt", "esc\n");
    await hook(s, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo esc > esc.txt" }, tool_use_id: "b1", prompt_id: "p1" });
    await hook(s, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "echo esc > esc.txt" }, tool_use_id: "b1", error: "Interrupted by user", is_interrupt: true });
    const st = await r.h.waitFor((x) => x.session.terminal?.interruptSuspected === true, "interrupt suspected");
    expect(st.gate.phase).toBe("running"); // no Stop on Esc: the turn stays open
    await r.h.engine.handle({ type: "terminal_end_turn", sessionId: id });
    await r.h.waitFor((x) => x.gate.phase === "reviewing", "collected");
    expect(r.h.engine.state.changedFiles.map((f) => f.path)).toEqual(["esc.txt"]);
    expect(r.h.engine.state.session.terminal).toMatchObject({ interruptSuspected: false, promptId: null });
    expect(await refusal(r.h, { type: "terminal_end_turn", sessionId: id })).toMatchObject({ ok: false, code: "no_turn" });
    expect(await refusal(r.h, { type: "terminal_end_turn", sessionId: "other" })).toMatchObject({ ok: false, code: "terminal_not_current" });
  });

  it("the Esc rule: idle_prompt ends the open turn; a new prompt_id ends it before the next one starts", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    await hook(s, ups("p1"));
    write(r.dir, "one.txt", "1\n");
    await hook(s, { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" });
    await r.h.waitFor((x) => x.gate.phase === "reviewing" && x.changedFiles.some((f) => f.path === "one.txt"), "idle_prompt collected");
    await r.h.engine.handle({ type: "accept_all" });

    await hook(s, ups("p2"));
    write(r.dir, "two.txt", "2\n");
    // The user pressed Esc, then typed a new prompt: p2's turn is collected first, then p3 starts.
    expect(await hook(s, ups("p3"))).toBeDefined();
    const st = await r.h.waitFor((x) => x.gate.phase === "running" && x.session.terminal?.promptId === "p3", "p3 running");
    expect(r.h.ofType("turn_end")).toHaveLength(2);
    expect(r.h.ofType("user_message").map((e) => e.text)).toEqual(["add a note", "add a note", "add a note"]);
    expect(st.changedFiles.map((f) => f.path)).toContain("two.txt"); // p2's review stands while p3 answers it
  });

  it("two prompts at once are adopted one after the other; each answer reaches its own prompt", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    // A turn ends: its collection runs while p1 comes, so p1's adoption waits for it — and p2 comes meanwhile (the CLI
    // gave up on p1, or a forged hook): p1 is blocked by the session, the turn its adoption opens ends at once, then p2
    // is adopted on its own — never with p1's answer.
    await hook(s, ups("p0", "zero prompt"));
    write(r.dir, "zero.txt", "0\n");
    await hook(s, { hook_event_name: "Stop" });
    const first = hook(s, ups("p1", "first prompt"));
    const second = await hook(s, ups("p2", "second prompt"));
    expect(await first).toMatchObject({ decision: "block" });
    expect(second.decision).toBeUndefined();
    const st = await r.h.waitFor((x) => x.gate.phase === "running" && x.session.terminal?.promptId === "p2", "p2 running");
    expect(st.sessions.list.find((m) => m.id === id)?.lastUserText).toBe("second prompt");
    // p1's turn was opened and closed (prompt_timeout) before p2's started — never two turns over each other.
    expect(r.h.ofType("user_message").map((e) => [e.text, e.turn])).toEqual([["zero prompt", 1], ["first prompt", 2], ["second prompt", 3]]);
    expect(r.h.ofType("turn_end").map((e) => e.stopReason)).toEqual(["end_turn", "prompt_timeout"]);
    expect(r.h.ofType("user_message").at(-1)).toMatchObject({ text: "second prompt" });
  });

  it("a review summary the CLI never got (its prompt was blocked meanwhile) goes with the next prompt", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    await turn(r, s, "p0");
    await r.h.engine.handle({ type: "reject", paths: ["notes.txt"] });
    // A turn Claude starts itself keeps the summary; its collection is in flight while p1 and p2 come.
    expect(await hook(s, { hook_event_name: "PreToolUse", ...write_("auto.txt", "w1", "pa") })).toEqual({});
    write(r.dir, "auto.txt", "auto\n");
    await hook(s, { hook_event_name: "PostToolUse", ...write_("auto.txt", "w1", "pa"), tool_response: {} });
    await hook(s, { hook_event_name: "Stop" });
    // p1's adoption takes the summary, but p1 is blocked by p2 before its answer: p2 carries it.
    const first = hook(s, ups("p1", "first prompt"));
    const second = await hook(s, ups("p2", "second prompt"));
    expect(await first).toMatchObject({ decision: "block" });
    expect(String((second.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext)).toContain("Rejected (reverted on disk");
  });

  it("a write tool with no prompt (Claude went on by itself) is taken as a turn of its own", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    expect(await hook(s, { hook_event_name: "PreToolUse", ...write_("auto.txt", "w1", "p9") })).toEqual({});
    write(r.dir, "auto.txt", "auto\n"); // the tool runs once its PreToolUse answered (after snapshot A)
    await hook(s, { hook_event_name: "PostToolUse", ...write_("auto.txt", "w1", "p9"), tool_response: {} });
    await hook(s, { hook_event_name: "Stop" });
    await r.h.waitFor((st) => st.gate.phase === "reviewing", "collected");
    expect(r.h.engine.state.changedFiles.map((f) => f.path)).toEqual(["auto.txt"]);
    expect(r.h.ofType("auto_turn").map((e) => e.trigger)).toEqual(["continue"]);
  });

  it("§57.4 a prompt adoption that never settles holds the queue only until its deadline + 10 s", async () => {
    const r = await rig({ promptWaitMs: 300 });
    const id = await newTerminal(r);
    const s = await spec(r, id);
    const engine = r.h.engine as unknown as { followHeadMove: () => Promise<void> };
    const real = engine.followHeadMove.bind(r.h.engine);
    engine.followHeadMove = () => new Promise<void>(() => undefined); // the seam: this adoption never settles
    expect(await hook(s, ups("p1"))).toMatchObject({ decision: "block" }); // the session's own timer (wait + 10 s)
    engine.followHeadMove = real;
    // The queue moved on: the next prompt is adopted (not blocked with "still starting the review of your previous prompt").
    const next = await hook(s, ups("p2", "go on"));
    expect(next.decision).toBeUndefined();
    await r.h.waitFor((st) => st.gate.phase === "running" && st.session.terminal?.promptId === "p2", "p2 running");
  });

  it("§57.16 the config dir the terminal really uses is learned from transcript_path and used by the gone and hooks checks", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    await turn(r, s, "p1");
    const other = temp("rg-term-config-b"); // the PTY's login shell exported another CLAUDE_CONFIG_DIR
    const record = cliSessionFile(r.dir, id, { CLAUDE_CONFIG_DIR: other });
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, "");
    await hook(s, { hook_event_name: "Notification", notification_type: "idle_prompt", message: "", transcript_path: record });
    await r.h.waitFor((st) => st.sessions.list.find((m) => m.id === id)?.cliConfigDir === other, "cliConfigDir");
    // The engine's own dir has the project's folder without the record: not gone, it is in the learned one.
    const ownProjects = dirname(cliSessionFile(r.dir, id, { CLAUDE_CONFIG_DIR: r.config }));
    mkdirSync(ownProjects, { recursive: true });
    expect((await spec(r, id)).argv[1]).toBe(`--resume=${id}`);
    // Hooks off in the learned dir refuse the spec too.
    writeFileSync(join(other, "settings.json"), JSON.stringify({ disableAllHooks: true }));
    expect(await refusal(r.h, { type: "terminal_spec", sessionId: id })).toMatchObject({ ok: false, code: "terminal_hooks_disabled" });
    // Reloaded from disk, the learned dir stays.
    await r.h.engine.dispose();
    const again = await rig({ dir: r.dir, config: r.config });
    expect(again.h.engine.state.sessions.list.find((m) => m.id === id)?.cliConfigDir).toBe(other);
  });

  describe("§57.10 background terminals", () => {
    const pids = (r: Rig): number[] => [...((r.h.engine as unknown as { ownCliPids(): Set<number> | null }).ownCliPids() ?? [])].sort();
    const toChat = async (r: Rig, id: string): Promise<string> =>
      (await (async () => {
        await r.h.engine.handle({ type: "session_new" });
        return r.h.waitFor((st) => st.session.terminal === undefined && st.sessions.currentId !== id, "chat");
      })()).sessions.currentId!;

    it("a switch keeps the running terminal's token: its hooks answer fail-closed; switching back needs no spec", async () => {
      const r = await rig();
      const id = await newTerminal(r);
      const s = await spec(r, id);
      await r.h.engine.handle({ type: "terminal_started", sessionId: id, pid: 5151 });
      await turn(r, s, "p1");
      await r.h.engine.handle({ type: "accept_all" });
      const chat = await toChat(r, id);
      let st = r.h.engine.state;
      expect(st.sessions.backgroundTerminals).toEqual([{ chatId: id, running: true, hooksSeen: true, waiting: null }]);
      expect(pids(r)).toContain(5151);
      // Not RETIRED_REASON: the background answers.
      expect(await hook(s, ups("p2"))).toEqual({ decision: "block", reason: BACKGROUND_PROMPT_REASON });
      const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
      expect(await hook(s, { hook_event_name: "PreToolUse", ...write_("bg.txt", "w9", "p2") })).toEqual(deny(BACKGROUND_TOOL_REASON));
      write(r.dir, "README.md", "edited elsewhere\n");
      expect(await hook(s, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git reset --hard" }, tool_use_id: "b9", prompt_id: "p2" })).toEqual(deny(TERMINAL_GIT_DENY_REASON));
      sh(r.dir, "checkout", "--", "README.md");
      // A wait still raises attention, on the background entry.
      await hook(s, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
      st = await r.h.waitFor((x) => x.sessions.backgroundTerminals?.[0]?.waiting !== null, "background waiting");
      expect(st.sessions.backgroundTerminals?.[0]?.waiting).toMatchObject({ kind: "permission" });
      expect(st.session.terminal).toBeUndefined(); // the chat's own state shows nothing of it
      expect(st.gate.phase).not.toBe("running"); // nothing reached the review
      // /clear in the background terminal is still followed for its own chat.
      const cleared = "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a";
      await hook(s, { hook_event_name: "SessionEnd", reason: "clear", session_id: cleared });
      await r.h.waitFor((x) => x.sessions.list.find((m) => m.id === id)?.cliSessionId === cleared, "background cliSessionId");
      expect(r.h.engine.state.sessions.list.find((m) => m.id === chat)?.cliSessionId).toBeUndefined();

      // Back: the same session and token, running, no new spec; the next prompt is reviewed.
      await r.h.engine.handle({ type: "session_open", sessionId: id });
      st = await r.h.waitFor((x) => x.sessions.currentId === id && x.session.terminal !== undefined, "terminal current");
      expect(st.session.terminal?.running).toBe(true);
      expect(st.sessions.backgroundTerminals).toBeUndefined();
      await turn(r, s, "p3", "again.txt");
    });

    it("parking is refused while a turn is open: the switch ends the terminal (its token retired)", async () => {
      const r = await rig();
      const id = await newTerminal(r);
      const s = await spec(r, id);
      await r.h.engine.handle({ type: "terminal_started", sessionId: id, pid: 5252 });
      await hook(s, ups("p1"));
      // A switch is refused while the turn runs (session_busy); Review now ends it, then the review stands.
      expect(await refusal(r.h, { type: "session_new" })).toMatchObject({ ok: false });
      // The never-started terminal: nothing to keep either.
      const r2 = await rig();
      const id2 = await newTerminal(r2);
      const s2 = await spec(r2, id2);
      await toChat(r2, id2);
      expect(r2.h.engine.state.sessions.backgroundTerminals).toBeUndefined();
      expect(await hook(s2, ups("p1"))).toEqual({ decision: "block", reason: RETIRED_REASON });
    });

    it("terminal_exited, session_delete and close_project end a background terminal", async () => {
      const r = await rig();
      const one = await newTerminal(r);
      const s1 = await spec(r, one);
      await r.h.engine.handle({ type: "terminal_started", sessionId: one, pid: 6001 });
      const two = await newTerminal(r);
      const s2 = await spec(r, two);
      await r.h.engine.handle({ type: "terminal_started", sessionId: two, pid: 6002 });
      const three = await newTerminal(r);
      const s3 = await spec(r, three);
      await r.h.engine.handle({ type: "terminal_started", sessionId: three, pid: 6003 });
      await toChat(r, three);
      expect(r.h.engine.state.sessions.backgroundTerminals?.map((b) => b.chatId).sort()).toEqual([one, two, three].sort());
      expect(pids(r)).toEqual([6001, 6002, 6003]);
      await r.h.engine.handle({ type: "terminal_exited", sessionId: one, exitCode: 0 });
      expect(await hook(s1, ups("x"))).toEqual({ decision: "block", reason: RETIRED_REASON });
      expect(await refusal(r.h, { type: "session_delete", sessionId: two })).toMatchObject({ ok: true });
      expect(await hook(s2, ups("x"))).toEqual({ decision: "block", reason: RETIRED_REASON });
      expect(r.h.engine.state.sessions.backgroundTerminals?.map((b) => b.chatId)).toEqual([three]);
      await r.h.engine.handle({ type: "close_project" });
      expect(await hook(s3, ups("x"))).toEqual({ decision: "block", reason: RETIRED_REASON });
      expect(r.h.engine.state.sessions.backgroundTerminals).toBeUndefined();
    });
  });

  it("§57.11 a workbench outside the main checkout: --mcp-config names a 0600 file with the servers above it, ${VAR} unexpanded", async () => {
    const root = temp("rg-term-mcp");
    const acme = join(root, "work", "acme");
    const app = join(acme, "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(acme, ".mcp.json"), JSON.stringify({ mcpServers: {
      db: { command: "node", args: ["db.js"], env: { TOKEN: "${ACME_TOKEN}" } },
      gh: { command: "node" }, local1: { command: "node" }, rejected: { command: "node" }, docs: { type: "http", url: "https://docs.example.com/mcp" },
    } }));
    sh(app, "init", "-q", "-b", "main");
    sh(app, "config", "user.email", "test@example.com");
    sh(app, "config", "user.name", "Test");
    write(app, "a.txt", "a\n");
    sh(app, "add", "-A");
    sh(app, "commit", "-qm", "init");
    const wt = join(root, "managed", "feat");
    mkdirSync(join(root, "managed"), { recursive: true });
    sh(app, "worktree", "add", "-q", "-b", "feat", wt);
    const config = temp("rg-term-config");
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ mcpServers: { gh: { command: "x" } }, projects: { [wt]: { mcpServers: { local1: { command: "x" } } } } }));
    writeFileSync(join(config, "settings.json"), JSON.stringify({ disabledMcpjsonServers: ["rejected"] }));
    const r = await rig({ dir: wt, config });
    const id = await newTerminal(r);
    const s = await spec(r, id);
    const i = s.argv.indexOf("--mcp-config");
    expect(i).toBe(2);
    expect(s.argv[i + 2]).toBe("--settings");
    const file = s.argv[i + 1]!;
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    const cfg = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, { env?: Record<string, string> }> };
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["db", "docs"]);
    expect(cfg.mcpServers.db!.env).toEqual({ TOKEN: "${ACME_TOKEN}" });
    expect(s.argv.join(" ")).not.toContain("ACME_TOKEN"); // the config is a file, not argv

    // The main checkout itself gets none.
    const main = await rig({ dir: app });
    const mid = await newTerminal(main);
    expect((await spec(main, mid)).argv).not.toContain("--mcp-config");
  });

  it("§57.13 the statusLine tee: the user's line wrapped, /status feeds the strip and the HUD, the turn's cost reaches the chat", async () => {
    const config = temp("rg-term-config");
    writeFileSync(join(config, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "acme-status", padding: 1, refreshInterval: 10 } }));
    const r = await rig({ config });
    const id = await newTerminal(r);
    const s = await spec(r, id);
    const settings = JSON.parse(s.argv[s.argv.indexOf("--settings") + 1]!) as { statusLine: { command: string; padding: number; refreshInterval: number } };
    expect(settings.statusLine).toMatchObject({ type: "command", padding: 1, refreshInterval: 10 });
    expect(settings.statusLine.command).toContain(`/bin/sh -c 'acme-status'`);
    expect(settings.statusLine.command).toContain(s.url.replace(/\/hook$/, "/status"));
    const status = async (cost: number) => {
      const res = await fetch(s.url.replace(/\/hook$/, "/status"), { method: "POST", headers: { "Content-Type": "application/json", "X-ReviewGate-Token": s.token }, body: JSON.stringify({ cost: { total_cost_usd: cost }, model: { id: "claude-acme-test", display_name: "Acme" }, context_window: { context_window_size: 200000, current_usage: { input_tokens: 4000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }) });
      expect(res.status).toBe(200);
    };
    await status(0.01);
    const st = await r.h.waitFor((x) => x.session.terminal?.status != null, "status");
    expect(st.session.terminal?.status).toMatchObject({ costUsd: 0.01, model: "claude-acme-test", modelName: "Acme", contextTokens: 4000, contextWindow: 200000 });
    expect(st.hud).toMatchObject({ contextTokens: 4000, contextWindow: 200000 });
    const answer = await hook(s, ups("p1"));
    expect(answer.decision).toBeUndefined();
    await status(0.0223);
    await hook(s, { hook_event_name: "Stop", stop_hook_active: false });
    const done = await r.h.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn over");
    expect(done.hud.sessionCostUSD).toBeCloseTo(0.0123);
    expect(done.sessions.list.find((m) => m.id === id)?.costUSD).toBeCloseTo(0.0123);
  });

  describe("§57.14 Request changes", () => {
    const note = (r: Rig, body: string) => r.h.engine.handle({ type: "add_note", path: "notes.txt", line: 1, side: "new", excerpt: "note", body });

    it("via next_prompt: staged, then the next prompt carries the notes message; the noted file is changesRequested", async () => {
      const r = await rig();
      const id = await newTerminal(r);
      const s = await spec(r, id);
      expect(await refusal(r.h, { type: "request_changes" })).toMatchObject({ ok: false });
      await turn(r, s, "p1");
      await note(r, "use a bullet list");
      expect(await refusal(r.h, { type: "request_changes", extra: "keep it short" })).toMatchObject({ ok: true });
      expect(r.h.engine.state.session.terminal?.requestQueued).toMatchObject({ via: "next_prompt", noteIds: null, extra: "keep it short" });
      // A slash command keeps it staged.
      await hook(s, ups("p2", "/help"));
      await hook(s, { hook_event_name: "Stop", stop_hook_active: false });
      await r.h.waitFor((x) => x.gate.phase === "reviewing", "slash turn over");
      expect(r.h.engine.state.session.terminal?.requestQueued?.via).toBe("next_prompt");
      const answer = await hook(s, ups("p3", "go ahead"));
      const ctx = String((answer.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext);
      expect(ctx).toContain("[Review gate] Requested changes");
      expect(ctx).toContain("use a bullet list");
      expect(ctx).toContain("keep it short");
      const st = await r.h.waitFor((x) => x.gate.phase === "running", "request turn");
      expect(st.session.terminal?.requestQueued).toBeUndefined();
      expect(st.changedFiles.find((f) => f.path === "notes.txt")?.state).toBe("changesRequested");
      expect(st.gate.canRequestChanges).toBe(false);
      expect(r.h.ofType("user_message").at(-1)).toMatchObject({ text: "go ahead" });
    });

    it("via stop: the running turn's Stop is blocked with the notes once, the turn ends at the next Stop", async () => {
      const r = await rig();
      const id = await newTerminal(r);
      const s = await spec(r, id);
      await turn(r, s, "p1");
      await note(r, "rename the file");
      await hook(s, ups("p2", "a question"));
      await r.h.waitFor((x) => x.gate.phase === "running", "p2 running");
      expect(await refusal(r.h, { type: "request_changes" })).toMatchObject({ ok: true });
      expect(r.h.engine.state.session.terminal?.requestQueued?.via).toBe("stop");
      const stop = await hook(s, { hook_event_name: "Stop", stop_hook_active: false });
      expect(stop.decision).toBe("block");
      expect(String(stop.reason).startsWith(STOP_FEEDBACK_PREFIX)).toBe(true);
      expect(String(stop.reason)).toContain("rename the file");
      let st = r.h.engine.state;
      expect(st.gate.phase).toBe("running"); // the turn stays open
      expect(st.session.terminal?.requestQueued).toBeUndefined();
      expect(st.gate.canRequestChanges).toBe(false);
      expect(await hook(s, { hook_event_name: "Stop", stop_hook_active: true })).toEqual({});
      st = await r.h.waitFor((x) => x.gate.phase === "reviewing", "collected");
      expect(r.h.ofType("turn_end")).toHaveLength(2);
    });

    it("terminal_request_cancel unstages; refused no_request_queued when nothing is staged", async () => {
      const r = await rig();
      const id = await newTerminal(r);
      const s = await spec(r, id);
      expect(await refusal(r.h, { type: "terminal_request_cancel", sessionId: id })).toMatchObject({ ok: false, code: "no_request_queued" });
      await turn(r, s, "p1");
      await note(r, "x");
      await r.h.engine.handle({ type: "request_changes" });
      expect(await refusal(r.h, { type: "terminal_request_cancel", sessionId: id })).toMatchObject({ ok: true });
      expect(r.h.engine.state.session.terminal?.requestQueued).toBeUndefined();
      const answer = await hook(s, ups("p2", "go on"));
      expect(String((answer.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "")).not.toContain("Requested changes");
      expect(await refusal(r.h, { type: "terminal_request_cancel", sessionId: "other" })).toMatchObject({ ok: false, code: "terminal_not_current" });
    });
  });

  describe("§57.12 worktrees: follow and move", () => {
    const children: ChildProcess[] = [];
    afterEach(() => {
      for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
    });
    /** A stand-in for the PTY's claude: our own `sleep`, ended by pid like the app ends its PTY. */
    const fakePty = (): ChildProcess => {
      const c = spawn("sleep", ["30"], { stdio: "ignore" });
      children.push(c);
      return c;
    };
    const twoWorktrees = (): { dir: string; wt: string } => {
      const dir = makeRepo();
      const wt = join(temp("rg-term-wt"), "feat");
      sh(dir, "worktree", "add", "-q", "-b", "feat", wt);
      return { dir, wt: realpathSync(wt) };
    };

    it.skipIf(process.platform === "win32")("chat_move: moving → the PTY ends → its turn is reviewed here → handoff; the target resumes it with the follow-up as context", async () => {
      const { dir, wt } = twoWorktrees();
      const r = await rig({ dir });
      const id = await newTerminal(r);
      const s = await spec(r, id);
      const pty = fakePty();
      await r.h.engine.handle({ type: "terminal_started", sessionId: id, pid: pty.pid! });
      await hook(s, ups("p1", "make a note"));
      write(r.dir, "moved.txt", "half\n");
      await hook(s, { hook_event_name: "PostToolUse", ...write_("moved.txt", "w1"), tool_response: {} });
      // Busy without interrupt: refused.
      expect(await refusal(r.h, { type: "chat_move", path: wt })).toMatchObject({ ok: false, error: "session_busy" });
      const reply = refusal(r.h, { type: "chat_move", path: wt, interrupt: true, followUp: "Please go on in feat." });
      const st = await r.h.waitFor((x) => x.session.terminal?.moving != null, "moving");
      expect(st.session.terminal?.moving).toEqual({ path: wt, name: "feat" });
      expect(await hook(s, ups("p2"))).toEqual({ decision: "block", reason: movingReason("feat") });
      pty.kill("SIGTERM"); // the app ends the PTY …
      void r.h.engine.handle({ type: "terminal_exited", sessionId: id, exitCode: 0 }); // … and says so (behind chat_move)
      expect(await reply).toMatchObject({ ok: true });
      const moved = r.h.ofType("chat_moved").at(-1)!;
      expect(moved).toMatchObject({ sessionId: id, path: wt, interrupted: true });
      const after = await r.h.waitFor((x) => x.gate.phase === "reviewing", "reviewed here");
      expect(after.changedFiles.map((f) => f.path)).toEqual(["moved.txt"]);
      const meta = after.sessions.list.find((m) => m.id === id)!;
      expect(meta.movedTo?.path).toBe(wt);
      expect(await refusal(r.h, { type: "terminal_spec", sessionId: id })).toMatchObject({ ok: false, code: "chat_is_record" });
      expect(await refusal(r.h, { type: "chat_move", path: wt })).toMatchObject({ ok: false, code: "chat_is_record" });

      // The target: its window takes the chat; the CLI's record is under the source folder, the target's projects folder
      // exists without it — resumed all the same (never a silent fresh start).
      const record = cliSessionFile(r.dir, id, { CLAUDE_CONFIG_DIR: r.config });
      mkdirSync(dirname(record), { recursive: true });
      writeFileSync(record, "");
      mkdirSync(dirname(cliSessionFile(wt, id, { CLAUDE_CONFIG_DIR: r.config })), { recursive: true });
      const there = await rig({ dir: wt, config: r.config });
      const tst = await there.h.waitFor((x) => x.sessions.currentId === id && x.session.terminal !== undefined, "the moved terminal chat");
      expect(tst.sessions.list.find((m) => m.id === id)).toMatchObject({ kind: "terminal", cliKnown: true, movedFrom: { path: r.dir } });
      const s2 = await spec(there, id);
      expect(s2.resume).toBe(true);
      expect(s2.argv[1]).toBe(`--resume=${id}`);
      expect(s2.cwd).toBe(wt);
      const first = await hook(s2, ups("q1", "continue"));
      const ctx = String((first.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext);
      expect(ctx).toContain("Please go on in feat.");
      await hook(s2, { hook_event_name: "Stop" });
      await there.h.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "q1 over");
      const second = await hook(s2, ups("q2", "more"));
      expect(String((second.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "")).not.toContain("Please go on");
    });

    it("EnterWorktree (not auto) and a cd offer the move (elsewhere); a cd back clears it; auto mode follows at once", async () => {
      const { dir, wt } = twoWorktrees();
      const r = await rig({ dir });
      const id = await newTerminal(r);
      const s = await spec(r, id);
      await hook(s, { hook_event_name: "PostToolUse", tool_name: "EnterWorktree", tool_input: { name: "feat" }, tool_use_id: "e1", tool_response: { worktreePath: wt, worktreeBranch: "feat" } });
      let st = await r.h.waitFor((x) => x.session.terminal?.elsewhere != null, "elsewhere");
      expect(st.session.terminal?.elsewhere).toEqual({ path: wt, name: "feat", toolName: "EnterWorktree", canMove: true });
      await hook(s, { hook_event_name: "CwdChanged", old_cwd: wt, new_cwd: r.dir });
      st = await r.h.waitFor((x) => x.session.terminal?.elsewhere == null, "back here");
      await hook(s, { hook_event_name: "CwdChanged", old_cwd: r.dir, new_cwd: join(wt) });
      st = await r.h.waitFor((x) => x.session.terminal?.elsewhere != null, "cd elsewhere");
      expect(st.session.terminal?.elsewhere).toMatchObject({ toolName: "CwdChanged", path: wt });
      expect(st.sessions.list.find((m) => m.id === id)?.movedTo).toBeUndefined(); // a cd never moves the chat

      // Auto mode (the TUI's own, from the hook): EnterWorktree moves the chat at once (no PTY running here: nothing to end).
      await hook(s, { hook_event_name: "PostToolUse", tool_name: "EnterWorktree", tool_input: { name: "feat" }, tool_use_id: "e2", tool_response: { worktreePath: wt }, permission_mode: "auto" });
      await r.h.waitFor((x) => x.sessions.list.find((m) => m.id === id)?.movedTo !== undefined, "followed");
      expect(r.h.ofType("chat_moved").at(-1)).toMatchObject({ sessionId: id, path: wt });
    });
  });

  it("§57.15 the permission bridge end to end: the app's answer reaches the hook; follow arms the next EnterWorktree; refusals; setting off", async () => {
    const dir = makeRepo();
    const wt = join(temp("rg-term-wt"), "feat");
    sh(dir, "worktree", "add", "-q", "-b", "feat", wt);
    const r = await rig({ dir });
    const id = await newTerminal(r);
    const s = await spec(r, id);
    const settings = JSON.parse(s.argv[s.argv.indexOf("--settings") + 1]!) as { hooks: Record<string, unknown> };
    expect(settings.hooks.PermissionRequest).toBeDefined();
    const pending = hook(s, { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo hi" } });
    const st = await r.h.waitFor((x) => (x.session.terminal?.permissions?.length ?? 0) > 0, "bridged");
    const p = st.session.terminal!.permissions![0]!;
    expect(p).toMatchObject({ toolName: "Bash", summary: "Bash: echo hi" });
    expect(await refusal(r.h, { type: "terminal_permission_response", sessionId: id, requestId: p.requestId, allow: true, follow: true })).toMatchObject({ ok: false, code: "follow_not_allowed" });
    expect(await refusal(r.h, { type: "terminal_permission_response", sessionId: id, requestId: p.requestId, allow: false, message: "not now" })).toMatchObject({ ok: true });
    expect(await pending).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not now" } } });
    expect(await refusal(r.h, { type: "terminal_permission_response", sessionId: id, requestId: p.requestId, allow: true })).toMatchObject({ ok: false, code: "permission_gone" });
    // Allow and follow: the EnterWorktree it allowed moves the chat (default mode: it would only be offered otherwise).
    const enter = hook(s, { hook_event_name: "PermissionRequest", tool_name: "EnterWorktree", tool_input: { name: "feat" } });
    const st2 = await r.h.waitFor((x) => x.session.terminal?.permissions?.some((q) => q.toolName === "EnterWorktree") === true, "EnterWorktree bridged");
    const q = st2.session.terminal!.permissions!.find((x) => x.toolName === "EnterWorktree")!;
    expect(q.canFollow).toBe(true);
    expect(await refusal(r.h, { type: "terminal_permission_response", sessionId: id, requestId: q.requestId, allow: true, follow: true })).toMatchObject({ ok: true });
    expect(await enter).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
    await hook(s, { hook_event_name: "PostToolUse", tool_name: "EnterWorktree", tool_input: { name: "feat" }, tool_use_id: "e1", tool_response: { worktreePath: realpathSync(wt) } });
    await r.h.waitFor((x) => x.sessions.list.find((m) => m.id === id)?.movedTo !== undefined, "followed");

    // The setting off: answered {} at once, nothing bridged.
    const off = await rig();
    await off.h.engine.handle({ type: "set_settings", settings: { terminalPermissionBridge: false } });
    const oid = await newTerminal(off);
    const os = await spec(off, oid);
    expect(await hook(os, { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } })).toEqual({});
    expect(off.h.engine.state.session.terminal?.permissions).toBeUndefined();
  });
});
