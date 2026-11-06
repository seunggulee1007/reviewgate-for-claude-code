// §52 background work: the logic behind the HUD chip, the auto_turn row, "백그라운드로", Ctrl+B and the refusal texts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  autoTurnLines,
  autoTurnRowOf,
  autoTurnTitle,
  backgroundChipText,
  backgroundRefusalText,
  backgroundTasksOf,
  backgroundWorkOn,
  canMoveToBackground,
  hasAutoTurnRow,
  isBackgroundKey,
  movedOf,
  taskBackgroundCommand,
  taskKindLabel,
  taskMetaLine,
  taskOutputCommand,
  taskOutputOf,
  taskStopCommand,
  taskTitle,
} from "./background";
import { initI18n } from "./i18n";

const key = (k: string, p: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key: k, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...p });

describe("§52 background work logic", () => {
  beforeAll(() => initI18n("ko", "win32"));
  afterAll(() => initI18n("en", "win32"));

  it("decodes the task list leniently: none before §52, odd entries skipped, odd fields defaulted", () => {
    expect(backgroundTasksOf({})).toEqual([]);
    expect(backgroundTasksOf(null)).toEqual([]);
    expect(backgroundTasksOf({ backgroundTasks: "x" })).toEqual([]);
    const tasks = backgroundTasksOf({
      backgroundTasks: [
        { taskId: "b1", kind: "bash", description: "npm run dev", toolUseId: "tu1", turn: 3, startedAt: "2026-11-05T00:00:00.000Z", hasOutput: true },
        { taskId: "m1" },
        { taskId: "", kind: "bash" },
        null,
        { kind: "bash" },
        { taskId: "x", kind: "weird", turn: "3", hasOutput: 1 },
      ],
    });
    expect(tasks.map((x) => x.taskId)).toEqual(["b1", "m1", "x"]);
    expect(tasks[0]).toEqual({ taskId: "b1", kind: "bash", description: "npm run dev", toolUseId: "tu1", turn: 3, startedAt: "2026-11-05T00:00:00.000Z", hasOutput: true });
    expect(tasks[1]).toEqual({ taskId: "m1", kind: "other", description: "", toolUseId: null, turn: null, startedAt: "", hasOutput: false });
    expect(tasks[2]).toMatchObject({ kind: "other", turn: null, hasOutput: false });
  });

  it("the chip shows only while tasks run; the list words", () => {
    expect(backgroundChipText([])).toBeNull();
    const [a, b] = backgroundTasksOf({ backgroundTasks: [{ taskId: "b1", kind: "bash", description: "npm run dev", turn: 3, startedAt: new Date(Date.now() - 5 * 60_000).toISOString() }, { taskId: "m1", kind: "monitor" }] });
    expect(backgroundChipText([a!, b!])).toBe("백그라운드 2");
    expect(["bash", "monitor", "agent", "other"].map((k) => taskKindLabel(k as never))).toEqual(["명령", "모니터", "에이전트", "작업"]);
    expect(taskTitle(a!)).toBe("npm run dev");
    expect(taskTitle(b!)).toBe("m1"); // no description: the id
    expect(taskMetaLine(a!)).toBe("명령 · 3번째 턴 · 5분 전");
    expect(taskMetaLine(b!)).toBe("모니터"); // no turn, no time
  });

  it("the auto_turn row: titles by trigger and status, lines, once per turn", () => {
    const bg = autoTurnRowOf({ turn: 4, trigger: "background", task: { taskId: "b1", description: "npm test", status: "completed", summary: "Background command completed (exit code 0)" } }, 1)!;
    expect(autoTurnTitle(bg)).toBe("백그라운드 작업이 끝나 Claude가 이어서 했어요");
    expect(autoTurnLines(bg)).toEqual({ detail: "npm test", summary: "Background command completed (exit code 0)" });
    expect(autoTurnTitle({ trigger: "background", task: { taskId: "b", description: "x", status: "failed" } })).toBe("백그라운드 작업이 실패해 Claude가 이어서 했어요");
    expect(autoTurnTitle({ trigger: "background", task: { taskId: "b", description: "x", status: "stopped" } })).toBe("백그라운드 작업이 멈춰 Claude가 이어서 했어요");
    const sched = autoTurnRowOf({ turn: 5, trigger: "schedule", wakeupSource: "schedule_wakeup" }, 2)!;
    expect(autoTurnTitle(sched)).toBe("예약된 작업이 실행됐어요 (/loop)");
    expect(autoTurnLines(sched)).toEqual({ detail: "이 턴의 변경도 다른 턴처럼 리뷰해요.", summary: null });
    expect(sched.wakeupSource).toBe("schedule_wakeup");
    const cont = autoTurnRowOf({ turn: 6, trigger: "something-new" }, 3)!;
    expect(cont.trigger).toBe("continue");
    expect(autoTurnTitle(cont)).toBe("Claude가 이어서 작업했어요");
    // the summary equal to the description is not repeated
    expect(autoTurnLines({ trigger: "background", task: { taskId: "b", description: "same", status: "completed", summary: "same" } }).summary).toBeNull();
    expect(autoTurnRowOf({ turn: Number.NaN, trigger: "background" }, 9)).toBeNull();
    expect(hasAutoTurnRow([bg, sched], 4)).toBe(true);
    expect(hasAutoTurnRow([bg, sched], 7)).toBe(false);
  });

  it("§52.2: a subagent that worked in the background — its own titles, its report as the summary, its call", () => {
    const agent = autoTurnRowOf({ turn: 3, trigger: "background", task: { taskId: "a1", description: "PR 다시 검토", status: "completed", summary: "리뷰 3건", kind: "agent", toolUseId: "toolu_a" } }, 1)!;
    expect(agent.task).toEqual({ taskId: "a1", description: "PR 다시 검토", status: "completed", summary: "리뷰 3건", kind: "agent", toolUseId: "toolu_a" });
    expect(autoTurnTitle(agent)).toBe("백그라운드 에이전트가 끝나 Claude가 이어서 했어요");
    expect(autoTurnLines(agent)).toEqual({ detail: "PR 다시 검토", summary: "리뷰 3건" });
    expect(autoTurnTitle({ trigger: "background", task: { taskId: "a", description: "x", status: "failed", kind: "agent" } })).toBe("백그라운드 에이전트가 실패해 Claude가 이어서 했어요");
    expect(autoTurnTitle({ trigger: "background", task: { taskId: "a", description: "x", status: "stopped", kind: "agent" } })).toBe("백그라운드 에이전트가 멈춰 Claude가 이어서 했어요");
    // An odd kind reads as `other` (a background task); an older engine's task has none.
    expect(autoTurnRowOf({ turn: 3, trigger: "background", task: { taskId: "x", description: "d", status: "completed", kind: "daemon" } }, 2)!.task?.kind).toBe("other");
    expect(autoTurnRowOf({ turn: 3, trigger: "background", task: { taskId: "x", description: "d", status: "completed" } }, 2)!.task).not.toHaveProperty("kind");
  });

  it("[백그라운드로] only on a main-thread Bash call that still runs, with the setting on", () => {
    const ok = { name: "Bash", parentToolUseId: undefined, hasResult: false, turnRunning: true, externalTurn: false, enabled: true };
    expect(canMoveToBackground(ok)).toBe(true);
    expect(canMoveToBackground({ ...ok, name: "Edit" })).toBe(false);
    expect(canMoveToBackground({ ...ok, parentToolUseId: "agent1" })).toBe(false); // a subagent's call
    expect(canMoveToBackground({ ...ok, hasResult: true })).toBe(false);
    expect(canMoveToBackground({ ...ok, turnRunning: false })).toBe(false);
    expect(canMoveToBackground({ ...ok, externalTurn: true })).toBe(false);
    expect(canMoveToBackground({ ...ok, enabled: false })).toBe(false);
    expect(backgroundWorkOn(null)).toBe(true);
    expect(backgroundWorkOn({})).toBe(true);
    expect(backgroundWorkOn({ backgroundWork: false })).toBe(false);
  });

  it("Ctrl+B moves only from an empty box while a turn runs (and the setting is on)", () => {
    const on = { draftEmpty: true, turnRunning: true, enabled: true };
    expect(isBackgroundKey(key("b"), on)).toBe(true);
    expect(isBackgroundKey(key("B"), on)).toBe(true);
    expect(isBackgroundKey(key("b"), { ...on, draftEmpty: false })).toBe(false); // does what it did before
    expect(isBackgroundKey(key("b"), { ...on, turnRunning: false })).toBe(false);
    expect(isBackgroundKey(key("b"), { ...on, enabled: false })).toBe(false);
    expect(isBackgroundKey(key("b"), { ...on, viewing: true })).toBe(false);
    expect(isBackgroundKey(key("b", { ctrlKey: false }), on)).toBe(false);
    expect(isBackgroundKey(key("b", { shiftKey: true }), on)).toBe(false);
    expect(isBackgroundKey(key("b", { altKey: true }), on)).toBe(false);
    expect(isBackgroundKey(key("c"), on)).toBe(false);
  });

  it("the commands' JSON and the replies", () => {
    expect(taskStopCommand("b1")).toEqual({ type: "task_stop", taskId: "b1" });
    expect(taskOutputCommand("b1")).toEqual({ type: "task_output", taskId: "b1" });
    expect(taskBackgroundCommand("tu1")).toEqual({ type: "task_background", toolUseId: "tu1" });
    expect(taskBackgroundCommand()).toEqual({ type: "task_background" }); // Ctrl+B: no id
    expect(taskOutputOf({ text: "hi", truncated: true, running: false })).toEqual({ text: "hi", truncated: true, running: false });
    expect(taskOutputOf(undefined)).toEqual({ text: "", truncated: false, running: false });
    expect(movedOf({ moved: true })).toBe(true);
    expect(movedOf({ moved: false })).toBe(false);
    expect(movedOf({})).toBe(false);
  });

  it("refusals in the user's words", () => {
    expect(backgroundRefusalText("task_unknown", "")).toBe("그 작업은 이미 끝났어요.");
    expect(backgroundRefusalText("no_output", "")).toBe("이 작업은 아직 보여 줄 출력이 없어요.");
    expect(backgroundRefusalText("background_off", "")).toBe("백그라운드 작업이 꺼져 있어요 (설정 › 세션, 또는 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).");
    expect(backgroundRefusalText("no_session", "")).toBe("실행 중인 Claude 세션이 없어요.");
    expect(backgroundRefusalText("task_stop_failed", "boom")).toBe("작업을 멈추지 못했어요: boom");
    expect(backgroundRefusalText("task_background_failed", "")).toBe("백그라운드로 옮길 수 없어요");
    expect(backgroundRefusalText("other", "")).toBeNull();
  });
});

describe("§52 Ctrl+B and the Toggle Sidebar accelerator", () => {
  it("the menu action right after the message box took Ctrl+B is dropped; later ones toggle again", async () => {
    const { noteBackgroundKey, backgroundKeyJustHandled } = await import("./background");
    noteBackgroundKey(1_000);
    expect(backgroundKeyJustHandled(1_100)).toBe(true);
    expect(backgroundKeyJustHandled(1_600)).toBe(false);
  });
});
