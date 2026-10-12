import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentNode, ReviewState, SideFork } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { agentResultMetaOf, agentUseMetaOf } from "./agentMeta";
import {
  agentRefusalText,
  agentsDoneNotification,
  agentViewOf,
  continuedAgentOf,
  continuesAgentText,
  continueText,
  modelLabel,
  modelTone,
  newQuestionHint,
  plainPreview,
  reportQuote,
  resumedLabel,
  runningTurnChip,
  runningTurnHelp,
  statusText,
  stopBlockedReason,
  waitingOf,
  waitingText,
} from "./agentDetails";
import type { ToolResultItem, ToolUseItem } from "./agents";

// MARK: wave3 desktop-agents — §36.1–36.4 and the §36.10 chip, the pure part (docs/PROTOCOL.md §36). The JSON below is the
// shape §36 gives: an engine before §36 sends none of the new fields, and every helper falls back to what the client
// showed before.

const node = (patch: Partial<AgentNode> = {}): AgentNode => ({
  id: "task-1",
  toolUseId: "toolu_01Ab",
  type: "oh-my-claudecode:executor",
  description: "쿠폰 코드 사용처 찾기",
  status: "running",
  isBackground: false,
  depth: 1,
  startedAt: 1_792_710_000_000,
  files: [],
  ...patch,
});
const use = (input: Record<string, unknown>, patch: Partial<ToolUseItem> = {}): ToolUseItem => ({ kind: "toolUse", id: 1, toolUseId: "toolu_01Ab", name: "Agent", input, ...patch });
const result = (patch: Partial<ToolResultItem> = {}): ToolResultItem => ({ kind: "toolResult", id: 2, toolUseId: "toolu_01Ab", isError: false, preview: "## 쿠폰 코드 사용처 14곳", ...patch });

describe("§36 row fields are read leniently", () => {
  it("keeps a SendMessage continuation only when it is whole", () => {
    expect(agentUseMetaOf({ continues: { agentToolUseId: "toolu_01Ab", agentType: "executor" } })).toEqual({ continues: { agentToolUseId: "toolu_01Ab", agentType: "executor" } });
    expect(agentUseMetaOf({})).toEqual({});
    expect(agentUseMetaOf({ continues: { agentToolUseId: "toolu_01Ab" } })).toEqual({});
    expect(agentUseMetaOf({ continues: "toolu_01Ab" })).toEqual({});
  });

  it("keeps the parsed <usage>, agentId and who stopped it", () => {
    expect(agentResultMetaOf({ agentUsage: { tokens: 14794, toolUses: 12, durationMs: 491500 }, cliAgentId: "a1b2c3d4", stoppedBy: "user" })).toEqual({
      agentUsage: { tokens: 14794, toolUses: 12, durationMs: 491500 },
      cliAgentId: "a1b2c3d4",
      stoppedBy: "user",
    });
    expect(agentResultMetaOf({})).toEqual({});
    expect(agentResultMetaOf({ agentUsage: { tokens: "many" }, cliAgentId: "", stoppedBy: "engine" })).toEqual({});
    expect(agentResultMetaOf({ agentUsage: { tokens: 10, toolUses: Number.NaN, durationMs: 5 } })).toEqual({});
  });
});

describe("agent details (pure)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("model chips: opus purple, sonnet blue, haiku green, anything else gray", () => {
    expect(modelTone("opus")).toBe("purple");
    expect(modelTone("claude-opus-4-5-20251101")).toBe("purple");
    expect(modelTone("sonnet")).toBe("blue");
    expect(modelTone("haiku")).toBe("green");
    expect(modelTone("fable")).toBe("gray");
    expect(modelLabel("opus")).toBe("opus");
    expect(modelLabel("claude-sonnet-4-5-20250929")).toBe("sonnet 4.5"); // wave4d w4d-agents2: the Mac's label
    expect(modelLabel("claude-opus-4-1[1m]")).toBe("opus 4.1");
  });

  it("the live node wins; the transcript fills in what an older engine or a dropped node lacks", () => {
    const n = node({ prompt: "couponCode 가 쓰이는 곳을 모두 찾아", model: "opus", tokens: 900, toolUses: 3, cliAgentId: "a1b2c3d4", resumeCount: 1 });
    const v = agentViewOf({ node: n, use: use({ subagent_type: "x", description: "old", prompt: "short", model: "haiku" }), running: true, continuations: 0 });
    expect(v.label).toBe("executor");
    expect(v.description).toBe("쿠폰 코드 사용처 찾기");
    expect(v.prompt).toBe("couponCode 가 쓰이는 곳을 모두 찾아");
    expect(v.model).toBe("opus");
    expect(v.usage).toEqual({ tokens: 900, toolUses: 3 });
    expect(v.resumeCount).toBe(1);
    expect(v.live).toBe(true);

    // An engine before §36: no prompt / model on the node → the Agent call's input.
    const old = agentViewOf({ node: node(), use: use({ subagent_type: "executor", description: "d", prompt: "the whole instructions", model: "sonnet" }), running: true, continuations: 0 });
    expect(old.prompt).toBe("the whole instructions");
    expect(old.model).toBe("sonnet");
    expect(old.usage).toBeNull();

    // A message to an agent still running resumes nothing: while the node lives, its own count is the truth.
    expect(agentViewOf({ node: node(), use: use({ prompt: "p" }), running: true, continuations: 1 }).resumeCount).toBe(0);
    // model null = none named (inherits): no chip, even when the input had none either.
    expect(agentViewOf({ node: node({ model: null }), use: use({ prompt: "p" }), running: true, continuations: 0 }).model).toBeNull();
    // The node keeps 8 000 chars; the transcript row's input has the whole prompt.
    const long = "x".repeat(9000);
    expect(agentViewOf({ node: node({ prompt: long.slice(0, 8000) }), use: use({ prompt: long }), running: true, continuations: 0 }).prompt).toHaveLength(9000);
  });

  it("after the next turn dropped the node: status, usage, stop and resumes come from the rows", () => {
    const done = agentViewOf({ use: use({ subagent_type: "executor", description: "d", prompt: "p" }), result: result({ agentUsage: { tokens: 14794, toolUses: 12, durationMs: 491500 }, cliAgentId: "a1b2c3d4" }), running: false, continuations: 2 });
    expect(done.status).toBe("completed");
    expect(done.usage).toEqual({ tokens: 14794, toolUses: 12, durationMs: 491500 });
    expect(done.reportKept).toBe(true);
    expect(done.resumeCount).toBe(2);
    expect(done.cliAgentId).toBe("a1b2c3d4");

    const stopped = agentViewOf({ use: use({ prompt: "p" }), result: result({ isError: true, preview: "[Request interrupted by user for tool use]", stoppedBy: "user" }), running: true, continuations: 0 });
    expect(stopped.status).toBe("stopped");
    expect(stopped.stoppedByUser).toBe(true);
    expect(stopped.reportKept).toBe(false);
    expect(statusText(stopped)).toBe("사용자가 중지");

    // An older engine's result: raw preview, no fields → no "보고서 전체 보기".
    const raw = agentViewOf({ use: use({ prompt: "p" }), result: result({ preview: "[Subagent hand-back] The text below…", truncated: true }), running: false, continuations: 0 });
    expect(raw.reportKept).toBe(false);
    expect(raw.reportPreview).toContain("[Subagent hand-back]");
    expect(statusText(raw)).toBe("완료");
  });

  it("finds the subagent a SendMessage `to` names (agentId or task id), never by the spawning tool_use id", () => {
    const agents = [node({ cliAgentId: "a1b2c3d4" }), node({ id: "toolu_02", toolUseId: "toolu_02", type: "architect" }), node({ id: "task-9", toolUseId: "toolu_09", type: "test-engineer" })];
    expect(continuedAgentOf(agents, "a1b2c3d4")?.toolUseId).toBe("toolu_01Ab");
    expect(continuedAgentOf(agents, "task-9")?.type).toBe("test-engineer");
    expect(continuedAgentOf(agents, "toolu_02")).toBeNull();
    expect(continuedAgentOf(agents, "acme-b4")).toBeNull();
    expect(continuedAgentOf(agents, "")).toBeNull();
    expect(continuesAgentText(agents[0]!)).toContain("executor");
  });

  it("names the run of a continued agent and the SendMessage that continues it", () => {
    expect(resumedLabel(0)).toBeNull();
    expect(resumedLabel(1)).toBe("재개됨(2회차)");
    expect(continueText({ agentToolUseId: "toolu_01Ab", agentType: "oh-my-claudecode:executor" }, { to: "a1b2c3d4", message: "gradle 테스트도 돌려줘\n둘째 줄" })).toBe("executor에게 이어서: gradle 테스트도 돌려줘");
    expect(continueText({ agentToolUseId: "toolu_01Ab", agentType: "executor" }, { to: "a1b2c3d4", summary: "테스트 실행" })).toBe("executor에게 이어서: 테스트 실행");
  });

  it("the composer line while the main turn waits on subagents", () => {
    const hud = { waitingOnAgents: { count: 2, longest: { toolUseId: "toolu_01Ab", type: "oh-my-claudecode:executor", startedAt: 1_792_710_000_000 } } };
    const w = waitingOf(hud)!;
    expect(waitingText(w, 1_792_710_000_000 + 252_000)).toBe("메인은 서브에이전트 2개를 기다리는 중 · executor 4분 12초");
    expect(waitingOf({ waitingOnAgents: null })).toBeNull();
    expect(waitingOf({})).toBeNull();
    expect(waitingOf({ waitingOnAgents: { count: 0, longest: { toolUseId: "t", type: "x", startedAt: 1 } } })).toBeNull();
    expect(waitingOf({ waitingOnAgents: { count: 1 } })).toBeNull();
  });

  it("stop: only a running agent with a task id, unless the engine cannot", () => {
    expect(stopBlockedReason(node(), false)).toBeNull();
    expect(stopBlockedReason(node({ status: "pending" }), false)).toBeNull();
    expect(stopBlockedReason(node({ status: "completed" }), false)).toBe("이 에이전트는 이미 끝났어요");
    expect(stopBlockedReason(undefined, false)).toBe("이 에이전트는 이미 끝났어요");
    expect(stopBlockedReason(node({ id: "toolu_01Ab" }), false)).toContain("작업 id");
    expect(stopBlockedReason(node(), true)).toContain("업데이트");
  });

  it("refusals in words, by command", () => {
    expect(agentRefusalText("stop_agent", "not_running", "x")).toBe("이 에이전트는 이미 끝났어요");
    expect(agentRefusalText("stop_agent", "not_supported", "x")).toContain("턴 전체");
    expect(agentRefusalText("stop_agent", "unknown_command", "x")).toContain("업데이트");
    expect(agentRefusalText("agent_report", "no_report", "x")).toContain("보고");
    expect(agentRefusalText("agent_report", "unknown_agent", "x")).toContain("찾지 못했어요");
    expect(agentRefusalText("agent_report", "something_new", "engine words")).toBe("engine words");
  });

  it("a card shows the report as plain lines", () => {
    expect(plainPreview("## 쿠폰 코드 사용처 14곳\n\n- **api**: 9곳\n1. `batch`\n> 메모\n| 파일 | 용도 |\n|---|---|\n| a.java | 생성 |")).toBe("쿠폰 코드 사용처 14곳\napi: 9곳\nbatch\n메모\n| 파일 | 용도 |\n| a.java | 생성 |");
    expect(plainPreview("")).toBe("");
  });

  it("the report goes to the composer as a quote with its agent named", () => {
    expect(reportQuote("executor", "쿠폰 코드 사용처 찾기", "## 결과\n\n- a\n```ts\nx\n```")).toBe(
      "> **에이전트 보고 · executor — 쿠폰 코드 사용처 찾기**\n>\n> ## 결과\n>\n> - a\n> ```ts\n> x\n> ```\n\n",
    );
    expect(reportQuote("executor", "", "ok\r\n")).toBe("> **에이전트 보고 · executor**\n>\n> ok\n\n");
  });

  it("§36.10: the side thread head says when only a summary of the running turn was shared", () => {
    const at: SideFork = { mode: "fork_at", fromSessionId: "4c2a", at: "b7e1", atTurn: 6, runningTurn: 7 };
    expect(runningTurnChip(at)).toBe("턴 7 진행 중 — 요약만 전달됨");
    expect(runningTurnHelp(at)).toContain("턴 6");
    const fresh: SideFork = { mode: "fresh", fromSessionId: null, at: null, atTurn: null, runningTurn: 1 };
    expect(runningTurnChip(fresh)).toBe("턴 1 진행 중 — 요약만 전달됨");
    expect(runningTurnHelp(fresh)).not.toContain("턴 null");
    // An older engine (no field) or a question asked between turns: no chip.
    expect(runningTurnChip({ mode: "fork_full", fromSessionId: "4c2a", at: null })).toBeNull();
    expect(runningTurnChip({ mode: "fork_at", fromSessionId: "4c2a", at: "b7e1", atTurn: 6, runningTurn: null })).toBeNull();
    expect(runningTurnChip(null)).toBeNull();
    // The new-question hint says only what the fork gets — never the review list.
    expect(newQuestionHint(false)).toBeNull();
    const hint = newQuestionHint(true)!;
    expect(hint).toContain("요약");
    expect(hint).not.toContain("리뷰");
  });
});

describe("§36.4 one OS notification per turn when the subagents finished", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  const waiting = { count: 1, longest: { toolUseId: "toolu_01Ab", type: "executor", startedAt: 1 } };
  const st = (phase: "running" | "idle", waitingOnAgents: unknown, turnStartedAt: number | null = 100) =>
    ({ gate: { phase }, hud: { turnStartedAt, waitingOnAgents } }) as unknown as ReviewState;

  it("fires when the main turn stops waiting and goes on, once per turn, only in the background", () => {
    const memory = { turnStartedAt: null as number | null };
    const ctx = { project: "acme", focused: false };
    expect(agentsDoneNotification(st("running", waiting), st("running", waiting), memory, ctx)).toBeNull();
    const n = agentsDoneNotification(st("running", waiting), st("running", null), memory, ctx)!;
    expect(n.kind).toBe("agents_done");
    expect(n.title).toBe("ReviewGate — acme");
    expect(n.body).toBe("서브에이전트가 모두 끝났어요 — Claude가 이어서 작업 중");
    expect(n.key).toBe("agents:100");
    // A second batch in the same turn: no second notification.
    expect(agentsDoneNotification(st("running", waiting), st("running", null), memory, ctx)).toBeNull();
    // The next turn may notify again.
    expect(agentsDoneNotification(st("running", waiting, 200), st("running", null, 200), memory, ctx)?.key).toBe("agents:200");
  });

  it("not when the turn ended with them (the turn's own notification says so), nor while the window is in front", () => {
    const memory = { turnStartedAt: null as number | null };
    expect(agentsDoneNotification(st("running", waiting), st("idle", null, null), memory, { project: null, focused: false })).toBeNull();
    expect(agentsDoneNotification(st("running", waiting), st("running", null), memory, { project: null, focused: true })).toBeNull();
    // Looking at the window did not use up the turn's notification.
    expect(agentsDoneNotification(st("running", waiting), st("running", null), memory, { project: null, focused: false })?.title).toBe("ReviewGate");
    // An engine without the field never notifies.
    expect(agentsDoneNotification(st("running", undefined), st("running", undefined), { turnStartedAt: null }, { project: null, focused: false })).toBeNull();
  });
});
