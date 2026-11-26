import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { applyTaskTool, taskItemsAsTodos, todoWriteItems, type TaskItem } from "../src/review/planSources.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §71.2: Ctrl+T — Claude's to-do checklist, live (`state.session.todos`). */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-todos"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "a.txt", "a\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

describe("§71.2 the checklist's items", () => {
  it("TodoWrite: text, status and the running words; an odd status is pending; an empty item is left out", () => {
    expect(todoWriteItems({ todos: [
      { content: "Edit `FooService.java`", status: "completed", activeForm: "Editing FooService" },
      { content: "Run the tests", status: "in_progress", activeForm: "Running the tests" },
      { content: "Write the notes", status: "weird" },
      { content: "  ", status: "pending" },
    ] })).toEqual([
      { text: "Edit FooService.java", status: "completed", activeForm: "Editing FooService" },
      { text: "Run the tests", status: "in_progress", activeForm: "Running the tests" },
      { text: "Write the notes", status: "pending" },
    ]);
    expect(todoWriteItems({})).toBeNull();
  });

  it("the Task tools: created pending, updated in progress / completed, deleted gone", () => {
    let tasks: TaskItem[] = [];
    tasks = applyTaskTool(tasks, "TaskCreate", { subject: "Add mapper", activeForm: "Adding the mapper" })!;
    tasks = applyTaskTool(tasks, "TaskCreate", { subject: "Add test" })!;
    tasks = applyTaskTool(tasks, "TaskCreate", { subject: "Drop me" })!;
    tasks = applyTaskTool(tasks, "TaskUpdate", { taskId: "1", status: "in_progress" })!;
    tasks = applyTaskTool(tasks, "TaskUpdate", { taskId: 2, status: "completed" })!;
    tasks = applyTaskTool(tasks, "TaskUpdate", { taskId: "3", status: "deleted" })!;
    expect(taskItemsAsTodos(tasks)).toEqual([
      { text: "Add mapper", status: "in_progress", activeForm: "Adding the mapper" },
      { text: "Add test", status: "completed" },
    ]);
    // A list kept before §71.2 (no status): done reads completed, the rest pending.
    expect(taskItemsAsTodos([{ id: "1", text: "old", body: "old", done: true }, { id: "2", text: "older", body: "", done: false }]))
      .toEqual([{ text: "old", status: "completed" }, { text: "older", status: "pending" }]);
  });
});

describe("§71.2 state.session.todos", () => {
  it("follows the main thread's calls live, the tool Claude used last; a subagent's list is not the chat's", async () => {
    const repo = makeRepo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(repo);
    expect(h.engine.state.session.todos).toEqual([]);

    await h.engine.request({ type: "send", text: "do the steps" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    const s = h.session();
    s.emit({ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [
      { content: "Read the code", status: "in_progress", activeForm: "Reading the code" },
      { content: "Fix it", status: "pending" },
    ] } });
    await h.waitFor((st) => (st.session.todos ?? []).length === 2, "checklist");
    expect(h.engine.state.session.todos![0]).toEqual({ text: "Read the code", status: "in_progress", activeForm: "Reading the code" });

    // A subagent's own TodoWrite is not the chat's list.
    s.emit({ type: "tool_use", id: "t2", name: "TodoWrite", parentToolUseId: "agent-1", input: { todos: [{ content: "sub", status: "pending" }] } });
    s.emit({ type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: [
      { content: "Read the code", status: "completed" },
      { content: "Fix it", status: "in_progress", activeForm: "Fixing it" },
    ] } });
    await h.waitFor((st) => st.session.todos?.[1]?.status === "in_progress", "updated");
    expect(h.engine.state.session.todos!.map((t) => t.text)).toEqual(["Read the code", "Fix it"]);

    // The Task tools used after it: the checklist is theirs.
    s.emit({ type: "tool_use", id: "t4", name: "TaskCreate", input: { subject: "Ship it" } });
    await h.waitFor((st) => st.session.todos?.length === 1, "task list");
    expect(h.engine.state.session.todos).toEqual([{ text: "Ship it", status: "pending" }]);
    s.emitTurnEnd();
    await h.waitFor((st) => st.gate.phase === "idle" && !st.session.starting, "turn over");
    await h.settle();

    // A new chat has none; the first chat's comes back from its rows.
    const first = h.engine.state.sessions.currentId!;
    await h.engine.request({ type: "session_new" });
    await h.waitFor((st) => st.sessions.currentId !== first && st.session.open && !st.session.starting, "new chat");
    expect(h.engine.state.session.todos).toEqual([]);
    await h.engine.request({ type: "session_open", sessionId: first });
    await h.waitFor((st) => st.sessions.currentId === first && (st.session.todos ?? []).length === 1, "back");
    expect(h.engine.state.session.todos).toEqual([{ text: "Ship it", status: "pending" }]);
  });
});
