// §52 on the store: the three requests and their refusals, the auto_turn row live and restored (once per turn), the HUD
// chip, the task list and the "백그라운드로" button as markup.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineCommand, ReviewState, TranscriptItem } from "@reviewgate/engine";
import { initI18n } from "./i18n";

const sent: EngineCommand[] = [];
let answer: (c: EngineCommand) => { ok: true; reply: unknown } | { ok: false; error: string; code?: string } = () => ({ ok: true, reply: { type: "result", ok: true } });

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return answer(c);
      },
      setSettings: async (patch: Record<string, unknown>) => patch,
      getSettings: async () => ({}),
      setUI: async () => undefined,
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "win32",
      sep: "\\",
    },
  };
  return await import("./store");
}

const task = (id: string, p: Record<string, unknown> = {}) => ({ taskId: id, kind: "bash", description: `cmd ${id}`, toolUseId: `tu-${id}`, turn: 2, startedAt: new Date().toISOString(), hasOutput: true, ...p });

describe("§52 background work in the store", () => {
  beforeAll(() => initI18n("ko", "win32"));
  afterAll(() => initI18n("en", "win32"));
  let mod: Awaited<ReturnType<typeof loadStore>>;
  const withSession = (extra: Record<string, unknown>, gate: Record<string, unknown> = {}) => {
    const s = mod.useStore.getState().state;
    mod.useStore.setState({ state: { ...s, session: { ...s.session, ...extra }, gate: { ...s.gate, ...gate } } as ReviewState });
  };
  const render = (component: unknown, props: Record<string, unknown> = {}) => {
    Object.assign(mod.useStore.getInitialState(), mod.useStore.getState());
    return renderToStaticMarkup(createElement(component as never, props as never));
  };

  beforeEach(async () => {
    mod = await loadStore();
    sent.length = 0;
    answer = () => ({ ok: true, reply: { type: "result", ok: true } });
    mod.useStore.setState({ transcript: [], settings: null });
    withSession({ backgroundTasks: undefined, externalTurn: null }, { phase: "reviewing" });
  });

  it("task_stop: ok, and a refusal as one line in the user's words", async () => {
    expect(await mod.useStore.getState().stopBackgroundTask("b1")).toBeNull();
    expect(sent[0]).toEqual({ type: "task_stop", taskId: "b1" });
    answer = () => ({ ok: false, error: "task_unknown" });
    expect(await mod.useStore.getState().stopBackgroundTask("b1")).toBe("그 작업은 이미 끝났어요.");
    answer = () => ({ ok: false, error: "task_stop_failed:nope" });
    expect(await mod.useStore.getState().stopBackgroundTask("b1")).toBe("작업을 멈추지 못했어요: nope");
    answer = () => ({ ok: false, error: "no_session" });
    expect(await mod.useStore.getState().stopBackgroundTask("b1")).toBe("실행 중인 Claude 세션이 없어요.");
  });

  it("task_background: moved, not moved, refused; Ctrl+B sends no id", async () => {
    answer = () => ({ ok: true, reply: { type: "task_background", moved: true } });
    expect(await mod.useStore.getState().moveToBackground("tu1")).toBeNull();
    expect(sent[0]).toEqual({ type: "task_background", toolUseId: "tu1" });
    expect(await mod.useStore.getState().moveToBackground()).toBeNull();
    expect(sent[1]).toEqual({ type: "task_background" });
    answer = () => ({ ok: true, reply: { type: "task_background", moved: false } });
    expect(await mod.useStore.getState().moveToBackground("tu1")).toBe("백그라운드로 옮길 수 없어요");
    answer = () => ({ ok: false, error: "background_off" });
    expect(await mod.useStore.getState().moveToBackground()).toContain("백그라운드 작업이 꺼져 있어요");
  });

  it("task_output: the text, truncated, running; refusals", async () => {
    answer = () => ({ ok: true, reply: { type: "task_output", taskId: "b1", text: "line\n", truncated: true, running: true } });
    expect(await mod.useStore.getState().readTaskOutput("b1")).toEqual({ ok: true, output: { text: "line\n", truncated: true, running: true } });
    expect(sent[0]).toEqual({ type: "task_output", taskId: "b1" });
    answer = () => ({ ok: false, error: "no_output" });
    expect(await mod.useStore.getState().readTaskOutput("b1")).toEqual({ ok: false, error: "이 작업은 아직 보여 줄 출력이 없어요." });
  });

  it("auto_turn live: one row per turn, and restored rows show the same", () => {
    const ev = { type: "auto_turn" as const, turn: 4, trigger: "background" as const, task: { taskId: "b1", description: "npm test", status: "failed" } };
    mod.useStore.getState().handleEvent(ev);
    mod.useStore.getState().handleEvent(ev); // a resend
    expect(mod.useStore.getState().transcript.filter((i) => i.kind === "autoTurn")).toHaveLength(1);
    mod.useStore.getState().handleEvent({ type: "auto_turn", turn: 5, trigger: "schedule", wakeupSource: "schedule_wakeup" });
    const rows = mod.useStore.getState().transcript.filter((i) => i.kind === "autoTurn");
    expect(rows).toHaveLength(2);
    const restored = mod.chatItemsOfRows(
      [
        { kind: "auto_turn", at: "2026-11-05T00:00:00.000Z", turn: 4, trigger: "background", task: { taskId: "b1", description: "npm test", status: "completed" } },
        { kind: "auto_turn", at: "2026-11-05T00:00:00.000Z", turn: 4, trigger: "background" },
        { kind: "auto_turn", at: "2026-11-05T00:01:00.000Z", turn: 6, trigger: "continue" },
      ] as TranscriptItem[],
      mod.useStore.getState().state.budget,
    );
    expect(restored.filter((i) => i.kind === "autoTurn").map((i) => (i as { turn: number }).turn)).toEqual([4, 6]);
  });

  it("renders the auto_turn row, the chip, the task list and the button", async () => {
    const { AutoTurnRowView } = await import("./components/chat/AutoTurnRow");
    const row = render(AutoTurnRowView, { item: { kind: "autoTurn", id: 1, turn: 4, trigger: "background", task: { taskId: "b1", description: "npm test", status: "completed", summary: "exit code 0" } } });
    expect(row).toContain("백그라운드 작업이 끝나 Claude가 이어서 했어요");
    expect(row).toContain("npm test");
    expect(row).toContain("exit code 0");

    const { BackgroundChip, BackgroundList } = await import("./components/chat/BackgroundChip");
    expect(render(BackgroundChip)).toBe(""); // nothing runs
    withSession({ backgroundTasks: [task("b1"), task("m1", { kind: "monitor", hasOutput: false, turn: null })] });
    const chip = render(BackgroundChip);
    expect(chip).toContain("백그라운드 2");
    expect(chip).toContain('data-testid="HUD background"');
    const list = render(BackgroundList, { tasks: [(await import("./background")).backgroundTasksOf(mod.useStore.getState().state.session)[0]], onOutput: () => undefined });
    expect(list).toContain("백그라운드에서 실행 중");
    expect(list).toContain("하나가 끝나면 Claude가 이어서 작업해요. 그사이 바뀐 파일은 다음 리뷰에 들어가요.");
    expect(list).toContain("cmd b1");
    expect(list).toContain("2번째 턴");
    expect(list).toContain("출력 보기");
    expect(list).toContain("중지");

    const { ToolUseRow } = await import("./components/chat/ToolRows");
    const bash = { kind: "toolUse", id: 1, toolUseId: "tu1", name: "Bash", input: { command: "npm run dev" } };
    const rowHtml = () => render(ToolUseRow, { item: bash, result: undefined, root: "/p" });
    expect(rowHtml()).not.toContain("백그라운드로"); // no turn running
    withSession({}, { phase: "running" });
    expect(rowHtml()).toContain('data-testid="Run in background"');
    mod.useStore.setState({ settings: { backgroundWork: false } as never });
    expect(rowHtml()).not.toContain("백그라운드로");
    mod.useStore.setState({ settings: null });
    expect(render(ToolUseRow, { item: { ...bash, parentToolUseId: "a1" }, result: undefined, root: "/p" })).not.toContain("백그라운드로");
    expect(render(ToolUseRow, { item: bash, result: { kind: "toolResult", id: 2, toolUseId: "tu1", isError: false, preview: "" }, root: "/p" })).not.toContain("백그라운드로");
  });
});
