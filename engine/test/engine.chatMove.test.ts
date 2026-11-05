import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, makeTempDir, removeDir, sh, write } from "./helpers/repo.js";
import { moveTarget, waitForExit } from "../src/review/chatMove.js";
import { parseWorktreeList } from "../src/git/worktrees.js";

/** docs/PROTOCOL.md §39.4 (wave4b w4b-follow): a chat follows Claude into another worktree of the repository. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** A repository and a linked worktree next to it (`<main>-wt`, branch `feat`). */
function repoWithWorktree(): { main: string; wt: string } {
  const main = realpathSync(makeRepo());
  const wt = `${main}-wt`;
  sh(main, "worktree", "add", "-q", "-b", "feat", wt);
  dirs.push(main, wt);
  return { main, wt };
}

async function opened(path: string): Promise<Harness> {
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
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

function incoming(worktree: string): string[] {
  const dir = join(sh(worktree, "rev-parse", "--absolute-git-dir").trim(), "reviewgate", "incoming");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("chat_move refusals (§39.4)", () => {
  it("no project, a missing path, a folder outside the repository, this window's own worktree, a running turn", async () => {
    const { main, wt } = repoWithWorktree();
    const idle = makeHarness();
    harnesses.push(idle);
    await idle.hello();
    await expect(idle.engine.request({ type: "chat_move", path: wt })).rejects.toThrow(/no_project/);

    const h = await opened(main);
    await expect(h.engine.request({ type: "chat_move", path: join(main, "nope") })).rejects.toThrow(/path_not_found/);
    const elsewhere = makeTempDir("rg-elsewhere");
    dirs.push(elsewhere);
    await expect(h.engine.request({ type: "chat_move", path: elsewhere })).rejects.toThrow(/not_a_worktree/);
    await expect(h.engine.request({ type: "chat_move", path: main })).rejects.toThrow(/same_worktree/);
    await expect(h.engine.request({ type: "chat_move", path: join(main, "README.md") })).rejects.toThrow(/path_not_found/);

    // A turn runs (a card waits): only `interrupt: true` moves.
    await h.engine.handle({ type: "send", text: "work" });
    await expect(h.engine.request({ type: "chat_move", path: wt })).rejects.toThrow(/session_busy/);
    expect(incoming(wt)).toEqual([]);
    expect(h.session().disposed).toBe(false);
  });

  it("moveTarget: a folder inside a worktree names that worktree; bare / prunable rows never match", () => {
    const { main, wt } = repoWithWorktree();
    const list = parseWorktreeList(sh(main, "worktree", "list", "--porcelain"));
    write(wt, "src/x.txt", "x\n");
    expect(moveTarget(join(wt, "src"), main, list)).toMatchObject({ root: wt, name: basename(wt), branch: "feat" });
    expect(moveTarget(wt, main, list.map((w) => (w.path === wt ? { ...w, prunable: true } : w)))).toEqual({ refused: "not_a_worktree" });
    expect(moveTarget(join(main, "sub"), main, list)).toEqual({ refused: "path_not_found" });
    expect(moveTarget("", main, list)).toEqual({ refused: "path_not_found" });
  });

  it("waitForExit: true once the pid is gone, false when it outlives the wait", async () => {
    let alive = 3;
    expect(await waitForExit(1234, 2000, () => alive-- > 0)).toBe(true);
    expect(await waitForExit(1234, 120, () => true)).toBe(false);
  });
});

describe("chat_move hands the chat over (§39.4)", () => {
  it("stops a running turn (its card included) only with interrupt, after the CLI is gone, and keeps the chat here as a record", async () => {
    const { main, wt } = repoWithWorktree();
    const h = await opened(main);
    await turn(h);
    const chatId = h.engine.state.sessions.currentId!;
    const first = h.session();
    await h.engine.handle({ type: "set_permission_mode", mode: "acceptEdits" });
    await h.engine.handle({ type: "send", text: "next step" });
    first.emit({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: "sed -n 1p x" }, toolUseId: "t1" });
    await h.settle();
    // The CLI's dispose takes a while: nothing may be handed over before it has ended.
    let release!: () => void;
    const disposing = new Promise<void>((r) => (release = r));
    const seenWhileDisposing: string[][] = [];
    first.dispose = async () => {
      first.disposed = true;
      seenWhileDisposing.push(incoming(wt));
      await disposing;
    };
    const moved = h.engine.request({ type: "chat_move", path: wt, interrupt: true, followUp: "작업 폴더를 옮겼어요. 하던 일을 이어서 해 줘." });
    await h.waitFor(() => first.disposed, "the CLI being stopped");
    await new Promise((r) => setTimeout(r, 30));
    expect(incoming(wt)).toEqual([]);
    release();
    await moved;
    expect(seenWhileDisposing).toEqual([[]]);
    expect(first.interrupts).toBe(1);
    expect(incoming(wt)).toEqual([`${chatId}.json`, `${chatId}.ndjson`]);
    const ev = h.ofType("chat_moved").at(-1)!;
    expect(ev).toMatchObject({ sessionId: chatId, path: wt, name: basename(wt), baseline: "disk", interrupted: true });
    const s = await h.waitFor((x) => x.session.open && !x.session.starting, "the record's fresh CLI");
    expect(s.sessions.list.find((m) => m.id === chatId)?.movedTo).toMatchObject({ path: wt, name: basename(wt) });
    // This window keeps the chat as a record: a fresh CLI under another id, never this conversation.
    expect(h.sessions).toHaveLength(2);
    expect(h.session().opts.settings.resumeSessionId).toBeUndefined();
    expect(h.session().opts.settings.sessionId).not.toBe(chatId);
    // A record cannot be moved again.
    await expect(h.engine.request({ type: "chat_move", path: wt })).rejects.toThrow(/chat_is_record/);
  });

  it("the target worktree's window takes the chat: current, resumed, its rows, the mode, the notice, then the follow-up once", async () => {
    const { main, wt } = repoWithWorktree();
    const src = await opened(main);
    await turn(src);
    const chatId = src.engine.state.sessions.currentId!;
    await src.engine.handle({ type: "set_permission_mode", mode: "acceptEdits" });
    await src.engine.handle({ type: "send", text: "keep going" });
    await src.engine.request({ type: "chat_move", path: wt, interrupt: true, followUp: "작업 폴더를 옮겼어요. 하던 일을 이어서 해 줘." });

    const dst = await opened(wt);
    const s = dst.engine.state;
    expect(s.sessions.currentId).toBe(chatId);
    expect(s.sessions.openTabIds).toContain(chatId);
    expect(s.sessions.list.find((m) => m.id === chatId)).toMatchObject({ movedFrom: { path: main }, cliKnown: true });
    expect(s.session.permissionMode).toBe("acceptEdits");
    expect(dst.sessions[0]!.opts.settings.resumeSessionId).toBe(chatId);
    const restore = dst.ofType("transcript_restore").at(-1)!;
    expect(restore.items.some((r) => r.kind === "user_message" && r.text === "remember the word cobalt")).toBe(true);
    const notice = dst.ofType("error").find((e) => e.code === "chat_moved_in_disk");
    expect(notice).toMatchObject({ fatal: false, scope: "session", path: main, sessionId: chatId });
    expect(dst.engine.state.lastError).toBeNull();
    await dst.waitFor(() => dst.session().sends.length > 0, "the follow-up turn");
    expect(dst.sessions.map((x) => x.sends.map((m) => m.text))).toEqual([["작업 폴더를 옮겼어요. 하던 일을 이어서 해 줘."]]);
    expect(incoming(wt)).toEqual([]);
    // The rows stay readable in the source window (the record).
    expect(src.engine.state.sessions.list.find((m) => m.id === chatId)?.movedTo?.path).toBe(wt);
  });

  it("an idle move sends no follow-up; a window that already has the target open takes it with chat_receive", async () => {
    const { main, wt } = repoWithWorktree();
    const dst = await opened(wt);
    const before = dst.engine.state.sessions.currentId;
    const src = await opened(main);
    await turn(src);
    const chatId = src.engine.state.sessions.currentId!;
    await src.engine.request({ type: "chat_move", path: wt, followUp: "ignored when no turn was stopped" });
    expect(src.ofType("chat_moved").at(-1)).toMatchObject({ interrupted: false });
    expect(dst.engine.state.sessions.currentId).toBe(before);
    await dst.engine.request({ type: "chat_receive" });
    const s = await dst.waitFor((x) => x.sessions.currentId === chatId && x.session.open && !x.session.starting, "the received chat");
    expect(s.sessions.list.some((m) => m.id === before)).toBe(true);
    expect(dst.session().opts.settings.resumeSessionId).toBe(chatId);
    expect(dst.session().sends).toEqual([]);
    await expect(dst.engine.request({ type: "chat_receive" })).rejects.toThrow(/nothing_to_receive/);
  });

  it("reopening the source opens the moved chat as a record (never resumed: the conversation goes on in the other worktree)", async () => {
    const { main, wt } = repoWithWorktree();
    const src = await opened(main);
    await turn(src);
    const chatId = src.engine.state.sessions.currentId!;
    await src.engine.request({ type: "chat_move", path: wt });
    await src.engine.dispose();
    const again = await opened(main);
    expect(again.engine.state.sessions.currentId).toBe(chatId);
    expect(again.session().opts.settings.resumeSessionId).toBeUndefined();
    expect(again.session().opts.settings.sessionId).not.toBe(chatId);
  });
});

describe("the moved chat's review baseline (§39.4)", () => {
  it("a worktree this chat created reviews from its HEAD: what Claude did there before the move is in the review", async () => {
    const main = realpathSync(makeRepo());
    const wt = `${main}-made`;
    dirs.push(main, wt);
    const src = await opened(main);
    await turn(src);
    const chatId = src.engine.state.sessions.currentId!;
    await src.engine.handle({ type: "send", text: "make a worktree" });
    const s = src.session();
    s.emit({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: `git worktree add -b made ${wt}` }, toolUseId: "b1", reason: { code: "worktree_command", message: "creates a worktree", path: wt } });
    await src.settle();
    await src.engine.handle({ type: "permission_response", requestId: "r1", allow: true, follow: true, followUp: "작업 폴더를 옮겼어요. 하던 일을 이어서 해 줘." });
    // The command ran: the worktree exists, a file was copied and one edited there.
    sh(main, "worktree", "add", "-q", "-b", "made", wt);
    write(wt, "copied.txt", "copied\n");
    write(wt, "README.md", "line1\nchanged\nline3\n");
    s.emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "Bash", toolUseId: "b1", path: wt, reasonCode: "worktree_command" });
    await src.waitFor(() => src.ofType("chat_moved").length > 0, "the followed move", 10_000);
    expect(src.ofType("chat_moved").at(-1)).toMatchObject({ sessionId: chatId, path: wt, baseline: "head", interrupted: true });
    // Followed: no "outside the review" warning for that command.
    expect(src.ofType("error").filter((e) => e.code === "worktree_outside_review")).toEqual([]);

    const dst = await opened(wt);
    const files = dst.engine.state.changedFiles.map((f) => [f.path, f.state]).sort();
    expect(files).toEqual([["README.md", "pending"], ["copied.txt", "pending"]]);
    expect(dst.engine.state.gate.restored).toBe(false);
    expect(dst.ofType("error").find((e) => e.code === "chat_moved_in")).toMatchObject({ path: main, sessionId: chatId });
    // The follow-up goes out as a question over that review (A stays HEAD's tree).
    await dst.waitFor((x) => x.gate.phase === "running", "the follow-up turn");
    dst.session().emitTurnEnd({ sessionId: chatId });
    await dst.waitFor((x) => x.gate.phase === "reviewing", "the review");
    expect(dst.engine.state.changedFiles.map((f) => f.path).sort()).toEqual(["README.md", "copied.txt"]);
  });

  it("a worktree that was already there reviews from the disk as it is (the user's changes stay out), and says so", async () => {
    const { main, wt } = repoWithWorktree();
    write(wt, "users-own.txt", "mine\n");
    const src = await opened(main);
    await turn(src);
    await src.engine.request({ type: "chat_move", path: wt });
    expect(src.ofType("chat_moved").at(-1)).toMatchObject({ baseline: "disk" });
    const dst = await opened(wt);
    expect(dst.engine.state.changedFiles).toEqual([]);
    expect(dst.ofType("error").some((e) => e.code === "chat_moved_in_disk")).toBe(true);
  });

  it("a followed command naming a worktree that was already there (`… 2>&1 | tail` hides git's refusal) reviews from the disk", async () => {
    const { main, wt } = repoWithWorktree();
    write(wt, "users-own.txt", "mine\n");
    const src = await opened(main);
    await turn(src);
    await src.engine.handle({ type: "send", text: "make a worktree" });
    const s = src.session();
    s.emit({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: `git worktree add ${wt} 2>&1 | tail -2` }, toolUseId: "b3", reason: { code: "worktree_command", message: "creates a worktree", path: wt } });
    await src.settle();
    await src.engine.handle({ type: "permission_response", requestId: "r1", allow: true, follow: true });
    s.emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "Bash", toolUseId: "b3", path: wt, reasonCode: "worktree_command" });
    await src.waitFor(() => src.ofType("chat_moved").length > 0, "the followed move", 10_000);
    expect(src.ofType("chat_moved").at(-1)).toMatchObject({ path: wt, baseline: "disk" });
    const dst = await opened(wt);
    expect(dst.engine.state.changedFiles).toEqual([]);
  });

  it("a worktree command that was not followed: the new worktree is listed at once, so the warning can offer the move", async () => {
    const main = realpathSync(makeRepo());
    const wt = `${main}-later`;
    dirs.push(main, wt);
    const src = await opened(main);
    await src.engine.handle({ type: "send", text: "make a worktree" });
    const s = src.session();
    s.emit({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: `git worktree add -b later ${wt}` }, toolUseId: "b2", reason: { code: "worktree_command", message: "creates a worktree", path: wt } });
    await src.settle();
    await src.engine.handle({ type: "permission_response", requestId: "r1", allow: true });
    sh(main, "worktree", "add", "-q", "-b", "later", wt);
    s.emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "Bash", toolUseId: "b2", path: wt, reasonCode: "worktree_command" });
    await src.waitFor((x) => x.workbenches.list.some((w) => w.path === wt), "the new worktree in the list (mid-turn)", 10_000);
    expect(src.engine.state.gate.phase).toBe("running");
    expect(src.ofType("error").find((e) => e.code === "worktree_outside_review")).toMatchObject({ path: wt });
    expect(src.ofType("chat_moved")).toEqual([]);
  });

  it("a followed command that did not create the worktree leaves the chat here and says why", async () => {
    const main = realpathSync(makeRepo());
    dirs.push(main);
    const src = await opened(main);
    await src.engine.handle({ type: "send", text: "make a worktree" });
    const s = src.session();
    const wt = `${main}-never`;
    s.emit({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: `git worktree add ${wt}` }, toolUseId: "b9", reason: { code: "worktree_command", message: "creates a worktree", path: wt } });
    await src.settle();
    await src.engine.handle({ type: "permission_response", requestId: "r1", allow: true, follow: true });
    s.emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "Bash", toolUseId: "b9", path: wt, reasonCode: "worktree_command" });
    await src.waitFor(() => src.ofType("error").some((e) => e.code === "chat_move_failed"), "the failure notice");
    // The real reason: nothing is at that path (before, every refusal read "not_a_worktree").
    expect(src.ofType("error").find((e) => e.code === "chat_move_failed")).toMatchObject({ fatal: false, path: wt, detail: "path_not_found" });
    expect(src.ofType("chat_moved")).toEqual([]);
    expect(s.disposed).toBe(false);
  });

  it("a followed command whose words name no usable path (a shell variable) follows the worktree it added", async () => {
    const main = realpathSync(makeRepo());
    const wt = `${main}-issue-42`;
    dirs.push(main, wt);
    const src = await opened(main);
    await turn(src);
    await src.engine.handle({ type: "send", text: "make a worktree" });
    const s = src.session();
    // What the card read from `WT=../x-issue-42 && git worktree add "$WT"`: a path that is no folder.
    const parsed = join(main, "$WT");
    s.emit({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: `WT=${wt} && git worktree add -b issue-42 "$WT"` }, toolUseId: "b7", reason: { code: "worktree_command", message: "creates a worktree", path: parsed } });
    await src.settle();
    await src.engine.handle({ type: "permission_response", requestId: "r1", allow: true, follow: true });
    sh(main, "worktree", "add", "-q", "-b", "issue-42", wt);
    write(wt, "copied.txt", "copied\n");
    s.emit({ type: "scope_notice", code: "worktree_outside_review", toolName: "Bash", toolUseId: "b7", path: parsed, reasonCode: "worktree_command" });
    await src.waitFor(() => src.ofType("chat_moved").length > 0 || src.ofType("error").some((e) => e.code === "chat_move_failed"), "the followed move", 10_000);
    expect(src.ofType("error").filter((e) => e.code === "chat_move_failed")).toEqual([]);
    expect(src.ofType("chat_moved").at(-1)).toMatchObject({ path: wt, baseline: "head" });
  });
});
