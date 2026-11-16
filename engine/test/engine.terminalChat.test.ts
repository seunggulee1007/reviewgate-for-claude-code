import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalSpecEvent } from "../src/protocol.js";
import { RETIRED_REASON } from "../src/session/hookServer.js";
import { NO_MANAGED_POLICY, type ManagedPolicy } from "../src/statusline/managed.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
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

/** A `claude` that only answers `--version`. */
function fakeClaude(version = "2.1.325"): string {
  const bin = temp("rg-term-bin");
  const path = join(bin, "claude");
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
}

type Rig = { h: Harness; dir: string; config: string; claude: string };

async function rig(o: { client?: "mac" | "windows" | "test"; version?: string; managed?: ManagedPolicy; dir?: string; config?: string } = {}): Promise<Rig> {
  const dir = o.dir ?? makeRepo();
  const config = o.config ?? temp("rg-term-config");
  const claude = fakeClaude(o.version);
  const h = makeHarness({ env: { CLAUDE_CONFIG_DIR: config }, managedPolicy: () => o.managed ?? NO_MANAGED_POLICY });
  harnesses.push(h);
  await h.engine.handle({ type: "hello", protocolVersion: 2, client: o.client ?? "mac", settings: { budget: { maxFiles: 0, maxLines: 0 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", claudePath: claude, ghHost: "github.com" } });
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

  it("terminal_spec: the claude argv, the token in env only, the project folder", async () => {
    const r = await rig();
    const id = await newTerminal(r);
    const s = await spec(r, id);
    expect(s.argv.slice(0, 4)).toEqual([r.claude, "--session-id", id, "--settings"]);
    expect(s.argv[5]).toBe("--append-system-prompt");
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
    for (const cmd of [{ type: "send", text: "hi" }, { type: "interrupt" }, { type: "set_model", model: "haiku" }, { type: "btw_ask", question: "q" }, { type: "side_promote", threadId: "t", as: "message" }] as const) {
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
    // The TUI's /clear: the next hooks carry another session id.
    await hook(s, { hook_event_name: "Notification", notification_type: "other", message: "", session_id: "cli-after-clear" });
    await r.h.waitFor((st) => st.sessions.list.find((m) => m.id === id)?.cliSessionId === "cli-after-clear", "cliSessionId");
    expect(r.h.engine.state.sessions.currentId).toBe(id); // the chat keeps its id
    await r.h.engine.dispose();
    const again = await rig({ dir: r.dir, config: r.config });
    expect(again.h.engine.state.sessions.currentId).toBe(id);
    const s2 = await spec(again, id);
    expect(s2.resume).toBe(true);
    expect(s2.argv.slice(1, 3)).toEqual(["--resume", "cli-after-clear"]);
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
});
