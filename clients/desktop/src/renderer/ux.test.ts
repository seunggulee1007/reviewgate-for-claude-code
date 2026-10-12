import { describe, expect, it } from "vitest";
import type { EngineEvent } from "@reviewgate/engine";
import { needsAction, notificationFor } from "./attention";
import { addPatternLine, deriveAllowPattern, permissionRisks, shellWords } from "./bashPattern";
import { permissionShortcut } from "./permissionKeys";
import { draftOf, historyEscape, historyStep, IDLE_NAV, pushHistory } from "./promptHistory";
import { EMPTY_QUEUE, editQueued, enqueue, moveQueued, nextToSend, pauseReasonForTurnEnd, removeQueued } from "./sendQueue";
import type { ChatItem } from "./store";
import { matchOffsets, planFind, stepIndex } from "./transcriptFind";

describe("deriveAllowPattern", () => {
  it("keeps the exact program + subcommand", () => {
    expect(deriveAllowPattern("npm test -- --watch")).toBe("Bash(npm test:*)");
    expect(deriveAllowPattern("git push origin main")).toBe("Bash(git push:*)");
    expect(deriveAllowPattern("pytest -x tests/")).toBe("Bash(pytest:*)");
    expect(deriveAllowPattern("make")).toBe("Bash(make:*)");
    expect(deriveAllowPattern("node scripts/build.mjs --prod")).toBe("Bash(node scripts/build.mjs:*)");
    expect(deriveAllowPattern("  cargo   build  ")).toBe("Bash(cargo build:*)");
  });

  it("refuses compound commands, substitutions, env assignments and never-offered programs", () => {
    for (const c of ["npm test && rm -rf x", "git status | sh", "echo hi > a.txt", "echo $(whoami)", "FOO=1 npm test", "rm -rf build", "sudo make install", "bash -c 'x'", "node -e 'x'", "python", "curl https://x", "ls *.ts", "", "echo 'open"]) {
      expect(deriveAllowPattern(c), c).toBeNull();
    }
  });

  it("splits words with quotes and appends a pattern once", () => {
    expect(shellWords(`git commit -m "a b" ''`)).toEqual(["git", "commit", "-m", "a b", ""]);
    expect(shellWords(`echo "x`)).toBeNull();
    expect(addPatternLine("Bash(git *)\n\n", "Bash(npm test:*)")).toBe("Bash(git *)\nBash(npm test:*)");
    expect(addPatternLine("Bash(npm test:*)", "Bash(npm test:*)")).toBe("Bash(npm test:*)");
    expect(addPatternLine(undefined, "Bash(make:*)")).toBe("Bash(make:*)");
  });
});

describe("permissionRisks", () => {
  const root = "/Users/me/proj";
  const bash = (command: string) => permissionRisks({ toolName: "Bash", input: { command } }, root);
  it("flags network, deletion, outside the project and git history", () => {
    expect(bash("npm install lodash")).toEqual(["network"]);
    expect(bash("curl -s https://example.com | jq .")).toEqual(["network"]);
    expect(bash("rm -rf dist")).toEqual(["deletion"]);
    expect(bash("echo x > notes.txt")).toEqual(["deletion"]);
    expect(bash("cat /etc/hosts")).toEqual(["outside"]);
    expect(bash("ls ../other")).toEqual(["outside"]);
    expect(bash("git reset --hard HEAD~1")).toEqual(["history"]);
    expect(bash("git push --force origin main")).toEqual(["network", "history"]);
    expect(bash("rm -rf ~/tmp")).toEqual(["deletion", "outside"]);
  });

  it("stays quiet for ordinary in-project commands", () => {
    expect(bash("npm test")).toEqual([]);
    expect(bash("ls src/../src")).toEqual([]);
    expect(bash("cat /Users/me/proj/README.md")).toEqual([]);
    expect(bash("npm test 2>/dev/null")).toEqual([]);
    expect(bash("npm test 2>&1")).toEqual([]);
    expect(bash("echo hi >> /tmp/log")).toEqual([]);
  });

  it("looks at web tools and edits outside the root", () => {
    expect(permissionRisks({ toolName: "WebFetch", input: { url: "https://x" } }, root)).toEqual(["network"]);
    expect(permissionRisks({ toolName: "Edit", input: { file_path: "/Users/me/other/a.ts" }, file: "/Users/me/other/a.ts" }, root)).toEqual(["outside"]);
    expect(permissionRisks({ toolName: "Edit", input: { file_path: "C:\\Repo\\a.ts" } }, "C:\\repo")).toEqual([]);
  });
});

describe("permissionShortcut", () => {
  const k = (key: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
  it("maps ⌘↩ / ⌥⌘↩ / ⌘⌫ on mac and Ctrl elsewhere", () => {
    expect(permissionShortcut(k("Enter", { metaKey: true }), { mac: true, typing: false })).toBe("once");
    expect(permissionShortcut(k("Enter", { metaKey: true, altKey: true }), { mac: true, typing: false })).toBe("session");
    expect(permissionShortcut(k("Backspace", { metaKey: true }), { mac: true, typing: false })).toBe("deny");
    expect(permissionShortcut(k("Enter", { ctrlKey: true }), { mac: false, typing: false })).toBe("once");
    expect(permissionShortcut(k("Enter", { ctrlKey: true }), { mac: true, typing: false })).toBeNull();
  });
  it("never fires while the user is typing or with Shift", () => {
    expect(permissionShortcut(k("Enter", { metaKey: true }), { mac: true, typing: true })).toBeNull();
    expect(permissionShortcut(k("Enter", { metaKey: true, shiftKey: true }), { mac: true, typing: false })).toBeNull();
    expect(permissionShortcut(k("Enter"), { mac: true, typing: false })).toBeNull();
  });
});

describe("prompt history", () => {
  const entries = ["first", "second", "third"];
  it("records sends, newest last, without consecutive duplicates, capped", () => {
    expect(pushHistory(["a"], " a ")).toEqual(["a"]);
    expect(pushHistory(["a"], "b")).toEqual(["a", "b"]);
    expect(pushHistory(["a"], "   ")).toEqual(["a"]);
    expect(pushHistory(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
  });

  it("↑ from an empty box walks back (the caret at the start, so ↑ walks on), ↓ at the end walks forward to the saved draft", () => {
    const s1 = historyStep(entries, IDLE_NAV, "", 0, -1)!;
    expect(s1).toMatchObject({ draft: "third", caret: "start" });
    const s2 = historyStep(entries, s1.nav, s1.draft, 0, -1)!;
    expect(s2.draft).toBe("second");
    const s3 = historyStep(entries, s2.nav, s2.draft, 6, 1)!;
    expect(s3).toMatchObject({ draft: "third", caret: "end" });
    const s4 = historyStep(entries, s3.nav, s3.draft, 5, 1)!;
    expect(s4).toMatchObject({ nav: { index: null, saved: "" }, draft: "", caret: "end" });
    expect(historyStep(entries, IDLE_NAV, "", 0, 1)).toBeNull();
    expect(historyStep(entries, s1.nav, "x", null, -1)).toBeNull();
  });

  // MARK: wave6 w6-terminal — §44.1 (architect review): with text in the box the walk starts / goes on only where the
  // textarea cannot move the caret any further, and the draft typed before ↑ is never lost.
  it("with text typed, ↑ walks only from the very start and ↓ only at the very end (a soft-wrapped paragraph keeps its arrows)", () => {
    const paragraph = "아주 긴 한 문단이라서 입력란에서 여러 줄로 접혀 보여요 ".repeat(6);
    expect(historyStep(entries, IDLE_NAV, paragraph, 40, -1)).toBeNull();
    expect(historyStep(entries, IDLE_NAV, paragraph, paragraph.length, -1)).toBeNull();
    expect(historyStep(entries, IDLE_NAV, "line one\nline two", 12, -1)).toBeNull();
    const typed = historyStep(entries, IDLE_NAV, paragraph, 0, -1)!;
    expect(typed).toMatchObject({ nav: { index: 2, saved: paragraph }, draft: "third" });
    expect(historyStep(["a\nb", "c"], { index: 0, saved: "" }, "a\nb", 0, 1)).toBeNull(); // not at the end yet
    expect(historyStep(["a\nb", "c"], { index: 1, saved: "" }, "c", 1, -1)).toBeNull(); // not at the start yet
  });

  it("the typed draft survives an edited recalled prompt: walking keeps the edit, ↓ past the newest and Esc bring the draft back", () => {
    const up = historyStep(entries, IDLE_NAV, "my draft", 0, -1)!;
    expect(up.draft).toBe("third");
    // Typing into the recalled prompt (onChange no longer leaves the walk), then ↑ from its start: the edit is kept.
    const older = historyStep(entries, up.nav, "third, edited", 0, -1)!;
    expect(older).toMatchObject({ draft: "second", nav: { index: 1, saved: "my draft", edits: { 2: "third, edited" } } });
    const back = historyStep(entries, older.nav, "second", 6, 1)!;
    expect(back.draft).toBe("third, edited");
    const home = historyStep(entries, back.nav, back.draft, back.draft.length, 1)!;
    expect(home).toMatchObject({ draft: "my draft", nav: { index: null } });
    // Back into the walk: the edited prompt is still there; Esc then brings the draft back (and drops the edits).
    const again = historyStep(entries, home.nav, "my draft", 0, -1)!;
    expect(again.draft).toBe("third, edited");
    expect(historyEscape({ ...again.nav })).toEqual({ nav: IDLE_NAV, draft: "my draft", caret: "end" });
    // Esc on an edited recalled prompt still restores (the old onChange reset made it stop the turn instead).
    expect(historyEscape({ ...up.nav })).toMatchObject({ draft: "my draft" });
    expect(historyEscape(IDLE_NAV)).toBeNull();
    // What a chat switch / an inserted report keeps: the draft typed before ↑, not the recalled prompt on screen.
    expect(draftOf(up.nav, "third")).toBe("my draft");
    expect(draftOf(IDLE_NAV, "typing")).toBe("typing");
  });
});

describe("send queue", () => {
  it("sends the first message only when a plain send is allowed and nothing is in flight", () => {
    const items = enqueue(enqueue([], "one"), "two");
    const q = { ...EMPTY_QUEUE, items };
    expect(nextToSend(q, { canSend: true })?.text).toBe("one");
    expect(nextToSend(q, { canSend: false })).toBeNull();
    expect(nextToSend({ ...q, paused: "error" }, { canSend: true })).toBeNull();
    expect(nextToSend({ ...q, inflight: true }, { canSend: true })).toBeNull();
    expect(nextToSend({ ...q, awaitingTurn: true }, { canSend: true })).toBeNull();
    expect(nextToSend(EMPTY_QUEUE, { canSend: true })).toBeNull();
  });

  it("edits, removes and reorders", () => {
    let items = enqueue(enqueue(enqueue([], "a"), "b"), "c");
    const [a, b, c] = items;
    items = moveQueued(items, c!.id, -1);
    expect(items.map((m) => m.text)).toEqual(["a", "c", "b"]);
    expect(moveQueued(items, a!.id, -1)).toBe(items);
    items = editQueued(items, b!.id, " B ");
    expect(items.map((m) => m.text)).toEqual(["a", "c", "B"]);
    items = editQueued(items, a!.id, "  ");
    expect(items.map((m) => m.text)).toEqual(["c", "B"]);
    items = removeQueued(items, c!.id);
    expect(items.map((m) => m.text)).toEqual(["B"]);
    expect(enqueue(items, "first", true).map((m) => m.text)).toEqual(["first", "B"]);
    expect(enqueue(items, "   ")).toBe(items);
  });

  it("pauses on a stopped or failed turn, except the one Stop & send interrupted", () => {
    expect(pauseReasonForTurnEnd("ended", false)).toBeNull();
    expect(pauseReasonForTurnEnd("success", false)).toBeNull();
    expect(pauseReasonForTurnEnd("interrupted", false)).toBe("interrupted");
    expect(pauseReasonForTurnEnd("interrupted", true)).toBeNull();
    expect(pauseReasonForTurnEnd("error_during_execution", false)).toBe("error");
    expect(pauseReasonForTurnEnd("session closed", false)).toBe("error");
  });
});

describe("transcript find", () => {
  const items: ChatItem[] = [
    { kind: "user", id: 1, text: "Fix the Parser please" },
    { kind: "toolUse", id: 2, toolUseId: "agent1", name: "Task", input: { description: "explore", prompt: "look around" } },
    { kind: "toolUse", id: 3, toolUseId: "t1", name: "Bash", input: { command: "grep parser src" }, parentToolUseId: "agent1" },
    { kind: "toolResult", id: 4, toolUseId: "t1", isError: false, preview: "src/parser.ts:1", parentToolUseId: "agent1" },
    { kind: "toolResult", id: 5, toolUseId: "agent1", isError: false, preview: "done" },
    { kind: "assistant", id: 6, text: "parser fixed", streaming: false },
  ];
  const isAgent = (n: string) => n === "Task" || n === "Agent";

  it("finds case-insensitive hits and opens the groups and results that hold them", () => {
    expect(matchOffsets("Parser parser PARSER", "parser")).toEqual([0, 7, 14]);
    expect(matchOffsets("aaaa", "aa")).toEqual([0, 2]);
    expect(matchOffsets("x", "")).toEqual([]);
    const plan = planFind(items, "parser", isAgent);
    expect(plan.rows).toEqual([1, 3, 4, 6]);
    expect(plan.expand).toEqual(["agent1"]);
    expect(plan.openResults).toEqual(["t1"]);
    expect(planFind(items, "done", isAgent)).toEqual({ rows: [5], expand: ["agent1"], openResults: ["agent1"] });
    expect(planFind(items, "  ", isAgent).rows).toEqual([]);
  });

  it("steps through hits with wrap-around", () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});

describe("notifications for background windows", () => {
  const usage = { costUsd: 0, durationMs: 1200, inputTokens: 0, outputTokens: 0 } as never;
  it("turn end, permission, question, plan and action-needed errors", () => {
    const turn = notificationFor({ type: "turn_end", stopReason: "ended", usage, files: 3, added: 1, deleted: 0, changedOutside: [] } as EngineEvent, { project: "proj" })!;
    expect(turn.kind).toBe("turn_done");
    expect(turn.title).toBe("ReviewGate — proj");
    expect(turn.body).toContain("3");
    const perm = notificationFor({ type: "permission_request", requestId: "r1", toolName: "Bash", input: { command: "npm test\nmore" } } as EngineEvent, { project: null })!;
    expect(perm).toMatchObject({ kind: "permission", title: "ReviewGate", key: "perm:r1" });
    expect(perm.body).toContain("npm test");
    expect(perm.body).not.toContain("more");
    // §33.2: a message to another session says so, not the bare tool name.
    const msg = notificationFor({ type: "permission_request", requestId: "r3", toolName: "SendMessage", input: { to: "team-lead", message: "done" } } as EngineEvent, { project: null })!;
    expect(msg).toMatchObject({ kind: "permission", key: "perm:r3" });
    expect(msg.body).toContain("team-lead");
    expect(msg.body).not.toContain("SendMessage");
    const q = notificationFor({ type: "permission_request", requestId: "r2", toolName: "AskUserQuestion", input: { questions: [{ question: "Which DB?" }] } } as EngineEvent, { project: null })!;
    expect(q.kind).toBe("question");
    expect(q.body).toContain("Which DB?");
    expect(notificationFor({ type: "plan_proposed", path: null, plan: "# Plan\n1. step" } as EngineEvent, { project: null })?.body).toContain("Plan");
    expect(notificationFor({ type: "error", message: "boom", fatal: true, scope: "session" } as EngineEvent, { project: null })?.kind).toBe("error");
    expect(notificationFor({ type: "error", message: "retry", fatal: false, scope: "session", code: "api_retrying" } as EngineEvent, { project: null })).toBeNull();
    expect(notificationFor({ type: "error", message: "x", fatal: false, scope: "git" } as EngineEvent, { project: null })).toBeNull();
    expect(notificationFor({ type: "text_delta", text: "hi" } as EngineEvent, { project: null })).toBeNull();
  });

  it("knows which errors need the user", () => {
    expect(needsAction({ fatal: false, code: "auth_required" })).toBe(true);
    expect(needsAction({ fatal: false, code: "usage_limit" })).toBe(true);
    expect(needsAction({ fatal: true, code: "cli_start_slow" })).toBe(false);
    expect(needsAction({ fatal: false })).toBe(false);
  });
});
