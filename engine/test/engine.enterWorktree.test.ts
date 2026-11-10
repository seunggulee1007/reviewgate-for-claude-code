import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "../src/protocol.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir, sh, write } from "./helpers/repo.js";
import { parseWorktreeList } from "../src/git/worktrees.js";

/**
 * M05b — docs/PROTOCOL.md §39.4: EnterWorktree moves the CLI into a worktree; in auto mode the chat follows at once (the
 * running turn stops, the chat and its review go on in that worktree's window, reviewed from its HEAD when this chat made
 * it), otherwise its row offers the move. ExitWorktree takes the CLI back; the chat follows it back the same way.
 */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function opened(path: string, settings: Partial<Settings> = {}): Promise<Harness> {
  const h = makeHarness();
  harnesses.push(h);
  await h.hello(settings);
  await h.open(path);
  return h;
}

/** One finished turn (the CLI reports the conversation: the chat is resumable). */
async function turn(h: Harness, text = "remember the word cobalt"): Promise<void> {
  await h.engine.handle({ type: "send", text });
  h.session().emitSessionInfo({ sessionId: h.engine.state.sessions.currentId! });
  h.session().emitTurnEnd({ sessionId: h.engine.state.sessions.currentId! });
  await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn end");
}

/** The handoff waiting in `worktree`'s incoming folder for chat `id`. */
function handoff(worktree: string, id: string): { followUp: string | null; baseline: string } {
  const file = join(sh(worktree, "rev-parse", "--absolute-git-dir").trim(), "reviewgate", "incoming", `${id}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as { followUp: string | null; baseline: string };
}

describe("EnterWorktree: the chat follows (M05b, §39.4)", () => {
  it("auto mode: once it ran the chat moves into the worktree it made — the turn stops, the review there starts at HEAD, the follow-up in the client's words", async () => {
    const main = realpathSync(makeRepo());
    dirs.push(main);
    const wt = join(main, ".claude", "worktrees", "acme-42");
    const src = await opened(main, { chatMoveFollowUp: "작업 폴더를 옮겼어요 ({name}). 하던 일을 이어서 해 줘." });
    await turn(src);
    const chatId = src.engine.state.sessions.currentId!;
    await src.engine.handle({ type: "set_permission_mode", mode: "auto" });
    await src.engine.handle({ type: "send", text: "/acme-task 42" });
    const s = src.session();
    const before = parseWorktreeList(sh(main, "worktree", "list", "--porcelain"));
    // What the CLI's EnterWorktree did: a worktree, and a first edit in it before the move.
    sh(main, "worktree", "add", "-q", "-b", "worktree-acme-42", wt);
    write(wt, "README.md", "line1\nchanged\nline3\n");
    s.emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "EnterWorktree", toolUseId: "e1", path: wt, branch: "worktree-acme-42", reasonCode: "worktree_command", worktreesBefore: before });
    await src.waitFor(() => src.ofType("chat_moved").length > 0, "the move", 10_000);
    expect(src.ofType("chat_moved").at(-1)).toMatchObject({ sessionId: chatId, path: wt, baseline: "head", interrupted: true });
    expect(s.interrupts).toBe(1);
    // Followed: no "outside the review" row for it.
    expect(src.ofType("error").filter((e) => e.code === "worktree_outside_review")).toEqual([]);
    expect(handoff(wt, chatId)).toMatchObject({ baseline: "head", followUp: "작업 폴더를 옮겼어요 (acme-42). 하던 일을 이어서 해 줘." });
    // The main checkout's branch is as it was.
    expect(sh(main, "branch", "--show-current").trim()).not.toBe("worktree-acme-42");

    const dst = await opened(wt);
    expect(dst.engine.state.sessions.currentId).toBe(chatId);
    expect(dst.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);
    expect(dst.ofType("error").find((e) => e.code === "chat_moved_in")).toMatchObject({ path: main, sessionId: chatId });
  });

  it("without settings.chatMoveFollowUp the follow-up is the engine's English one", async () => {
    const main = realpathSync(makeRepo());
    dirs.push(main);
    const wt = join(main, ".claude", "worktrees", "acme-7");
    const src = await opened(main);
    await turn(src);
    const chatId = src.engine.state.sessions.currentId!;
    await src.engine.handle({ type: "set_permission_mode", mode: "auto" });
    await src.engine.handle({ type: "send", text: "work in a worktree" });
    sh(main, "worktree", "add", "-q", "-b", "worktree-acme-7", wt);
    src.session().emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "EnterWorktree", toolUseId: "e2", path: wt, reasonCode: "worktree_command" });
    await src.waitFor(() => src.ofType("chat_moved").length > 0, "the move", 10_000);
    expect(handoff(wt, chatId).followUp).toBe("The working folder moved to acme-7. Please continue what you were doing.");
  });

  it("the default mode: no move without the card's 허용하고 따라가기 — the row offers it, also for a worktree that was there", async () => {
    const main = realpathSync(makeRepo());
    const existing = `${main}-wt`;
    dirs.push(main, existing);
    sh(main, "worktree", "add", "-q", "-b", "feat", existing);
    const src = await opened(main);
    await src.engine.handle({ type: "send", text: "go into the worktree" });
    const s = src.session();
    const before = parseWorktreeList(sh(main, "worktree", "list", "--porcelain"));
    s.emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "EnterWorktree", toolUseId: "e3", path: existing, reasonCode: "worktree_command", worktreesBefore: before });
    await src.waitFor(() => src.ofType("error").some((e) => e.code === "worktree_outside_review"), "the row", 10_000);
    expect(src.ofType("error").find((e) => e.code === "worktree_outside_review")).toMatchObject({ toolName: "EnterWorktree", path: existing, fatal: false });
    expect(src.ofType("chat_moved")).toEqual([]);
    expect(src.engine.state.gate.phase).toBe("running");
  });
});

describe("ExitWorktree: the chat follows back (M05b, §39.4)", () => {
  it("auto mode in the worktree's window: the chat moves back to the folder the CLI returned to, reviewed there from the disk", async () => {
    const main = realpathSync(makeRepo());
    dirs.push(main);
    const wt = join(main, ".claude", "worktrees", "acme-42");
    sh(main, "worktree", "add", "-q", "-b", "worktree-acme-42", wt);
    write(main, "users-own.txt", "mine\n");
    const h = await opened(wt, { chatMoveFollowUp: "작업 폴더를 옮겼어요 ({name}). 하던 일을 이어서 해 줘." });
    await turn(h);
    const chatId = h.engine.state.sessions.currentId!;
    await h.engine.handle({ type: "set_permission_mode", mode: "auto" });
    await h.engine.handle({ type: "send", text: "finish and leave the worktree" });
    h.session().emit({ type: "scope_notice", code: "worktree_exited", toolName: "ExitWorktree", toolUseId: "x1", path: main });
    await h.waitFor(() => h.ofType("chat_moved").length > 0, "the move back", 10_000);
    expect(h.ofType("chat_moved").at(-1)).toMatchObject({ sessionId: chatId, path: main, baseline: "disk", interrupted: true });
    expect(handoff(main, chatId).followUp).toBe(`작업 폴더를 옮겼어요 (${main.split(/[\\/]/).pop()}). 하던 일을 이어서 해 줘.`);
    // The worktree stays (its review is here).
    expect(existsSync(wt)).toBe(true);
  });

  it("the default mode offers the move back in a row; the CLI back in this window's own folder says nothing", async () => {
    const main = realpathSync(makeRepo());
    dirs.push(main);
    const wt = join(main, ".claude", "worktrees", "acme-43");
    sh(main, "worktree", "add", "-q", "-b", "worktree-acme-43", wt);
    const h = await opened(wt);
    await h.engine.handle({ type: "send", text: "leave the worktree" });
    h.session().emit({ type: "scope_notice", code: "worktree_exited", toolName: "ExitWorktree", toolUseId: "x2", path: main });
    await h.waitFor(() => h.ofType("error").some((e) => e.code === "worktree_outside_review"), "the row", 10_000);
    expect(h.ofType("error").find((e) => e.code === "worktree_outside_review")).toMatchObject({ toolName: "ExitWorktree", path: main });
    expect(h.ofType("chat_moved")).toEqual([]);

    const m = await opened(main);
    await m.engine.handle({ type: "send", text: "x" });
    m.session().emit({ type: "scope_notice", code: "worktree_exited", toolName: "ExitWorktree", toolUseId: "x3", path: main });
    await m.settle();
    await new Promise((r) => setTimeout(r, 200));
    expect(m.ofType("error").filter((e) => e.code === "worktree_outside_review" || e.code === "chat_move_failed")).toEqual([]);
    expect(m.ofType("chat_moved")).toEqual([]);
  });
});
