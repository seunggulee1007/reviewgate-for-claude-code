/**
 * MARK: wave3 desktop-agents — the agent screens (docs/PROTOCOL.md §36.1–36.4, the §36.10 chip) through the store with the
 * engine bridge mocked: the §36 JSON shapes are injected as events / snapshots / replies (no engine behavior yet), the views
 * rendered to static markup. Also: an engine before §36 (none of the fields) shows what it showed before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentNode, EngineCommand, EngineEvent, GateState, ReviewState, SideThread, TranscriptItem } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import type { ChatItem } from "./store";

// DOMPurify needs a DOM: markdown is shown as its source text here (the sanitizer has its own tests).
vi.mock("./components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => createElement("div", { className: "markdown" }, text) }));

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return respond(c);
      },
      setSettings: async (patch: Record<string, unknown>) => patch,
      getSettings: async () => ({}),
      setUI: async () => undefined,
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
      sep: "/",
    },
  };
  return (await import("./store")).useStore;
}
type UseStore = Awaited<ReturnType<typeof loadStore>>;

const gate = (p: Partial<GateState> = {}): GateState => ({
  phase: "idle",
  canSend: true,
  canRequestChanges: false,
  blockedReason: null,
  collectError: null,
  pendingCount: 0,
  changesRequestedCount: 0,
  isRequestingChanges: false,
  turnStartTree: null,
  turnEndTree: null,
  lastReviewSummary: null,
  changedOutside: [],
  ignoredTouched: [],
  filteredByPattern: [],
  restored: false,
  reviewSummary: { files: 0, added: 0, deleted: 0 },
  externalPendingCount: 0,
  ...p,
});
const running = { phase: "running" as const, canSend: false, blockedReason: "running" as const };

const node = (patch: Partial<AgentNode> = {}): AgentNode => ({
  id: "task-1",
  toolUseId: "toolu_01Ab",
  type: "oh-my-claudecode:executor",
  description: "쿠폰 코드 사용처 찾기",
  status: "running",
  isBackground: false,
  depth: 1,
  startedAt: Date.now() - 65_000,
  files: [],
  ...patch,
});

/** The Agent call, one inner Bash call and (optionally) the cleaned result — as §36 rows. */
const agentRows = (result?: Partial<Extract<ChatItem, { kind: "toolResult" }>>): ChatItem[] => [
  { kind: "user", id: 1, text: "쿠폰 코드 찾아줘", turn: 1 },
  { kind: "toolUse", id: 2, toolUseId: "toolu_01Ab", name: "Agent", input: { subagent_type: "oh-my-claudecode:executor", description: "쿠폰 코드 사용처 찾기", prompt: "couponCode 가 쓰이는 곳을 **모두** 찾아", model: "opus" } },
  { kind: "toolUse", id: 3, toolUseId: "toolu_inner", name: "Bash", input: { command: "rg couponCode" }, parentToolUseId: "toolu_01Ab" },
  { kind: "toolResult", id: 4, toolUseId: "toolu_inner", isError: false, preview: "api/src/main/a.java", parentToolUseId: "toolu_01Ab" },
  ...(result ? [{ kind: "toolResult", id: 5, toolUseId: "toolu_01Ab", isError: false, preview: "## 쿠폰 코드 사용처 14곳\n- api/src/main/a.java", ...result } as ChatItem] : []),
];

let seq = 9000;

describe("§36 agents (wave3 desktop-agents)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  let useStore: UseStore;
  beforeEach(async () => {
    useStore = await loadStore();
    sent.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    const s = useStore.getState().state;
    useStore.setState({
      transcript: [],
      dialog: null,
      tab: "changes",
      queue: { ...useStore.getState().queue, items: [], paused: null, inflight: false, awaitingTurn: false },
      state: { ...s, seq: ++seq, gate: gate(), hud: { ...s.hud, agents: [], waitingOnAgents: null, turnStartedAt: null }, project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null } } as ReviewState,
    });
    const { useAgentUi } = await import("./agentUi");
    useAgentUi.setState({ stopping: {}, stopUnsupported: false, stopRefused: {}, expand: null });
  });

  const setState = (patch: Partial<ReviewState>) => {
    const s = useStore.getState().state;
    useStore.setState({ state: { ...s, seq: ++seq, ...patch } as ReviewState });
  };
  const setHud = (patch: Partial<ReviewState["hud"]>) => setState({ hud: { ...useStore.getState().state.hud, ...patch } });
  /** Server rendering reads zustand's initial state: copy the current one into it (test-only). */
  const render = async (component: unknown, props: Record<string, unknown> = {}) => {
    const { useAgentUi } = await import("./agentUi");
    Object.assign(useStore.getInitialState(), useStore.getState());
    Object.assign(useAgentUi.getInitialState(), useAgentUi.getState());
    return renderToStaticMarkup(createElement(component as never, props as never));
  };
  const groupHead = (html: string) => {
    const at = html.lastIndexOf('<div class="agent-head"', html.indexOf('data-tool-use-id="toolu_01Ab"'));
    return at < 0 ? "" : html.slice(at, html.indexOf("</div>", html.indexOf('data-testid="Agent menu toolu_01Ab"', at)));
  };

  // ------------------------------------------------------------ store

  it("live events and restored rows keep §36 fields; an older engine's rows stay as they were", () => {
    const events: EngineEvent[] = [
      { type: "tool_use", id: "toolu_02Cd", name: "SendMessage", input: { to: "a1b2c3d4", message: "gradle 테스트도 돌려줘" }, continues: { agentToolUseId: "toolu_01Ab", agentType: "executor" } },
      { type: "tool_result", toolUseId: "toolu_01Ab", isError: false, preview: "## 결과", agentUsage: { tokens: 14794, toolUses: 12, durationMs: 491500 }, cliAgentId: "a1b2c3d4" },
      { type: "tool_result", toolUseId: "toolu_03Ef", isError: true, preview: "[Request interrupted by user for tool use]", stoppedBy: "user" },
      { type: "tool_use", id: "toolu_04Gh", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", toolUseId: "toolu_04Gh", isError: false, preview: "a" },
    ];
    for (const ev of events) useStore.getState().handleEvent(ev);
    const [cont, res, stop, use, plain] = useStore.getState().transcript as Extract<ChatItem, { kind: "toolUse" | "toolResult" }>[];
    expect(cont).toMatchObject({ kind: "toolUse", continues: { agentToolUseId: "toolu_01Ab", agentType: "executor" } });
    expect(res).toMatchObject({ kind: "toolResult", agentUsage: { tokens: 14794, toolUses: 12, durationMs: 491500 }, cliAgentId: "a1b2c3d4" });
    expect(stop).toMatchObject({ kind: "toolResult", stoppedBy: "user" });
    expect("continues" in use!).toBe(false);
    expect("agentUsage" in plain! || "cliAgentId" in plain! || "stoppedBy" in plain!).toBe(false);

    const rows: TranscriptItem[] = [
      { at: "2026-10-23T03:00:00.000Z", turn: 2, kind: "tool_use", id: "toolu_02Cd", name: "SendMessage", input: { to: "a1b2c3d4", message: "m" }, continues: { agentToolUseId: "toolu_01Ab", agentType: "executor" } },
      { at: "2026-10-23T03:00:00.000Z", turn: 2, kind: "tool_result", toolUseId: "toolu_01Ab", isError: false, preview: "p", agentUsage: { tokens: 1, toolUses: 2, durationMs: 3 }, cliAgentId: "a1b2", stoppedBy: "user" },
    ];
    useStore.setState({ transcriptRestored: false, transcript: [] });
    useStore.getState().handleEvent({ type: "transcript_restore", items: rows });
    const restored = useStore.getState().transcript;
    expect(restored.find((i) => i.kind === "toolUse")).toMatchObject({ continues: { agentToolUseId: "toolu_01Ab", agentType: "executor" } });
    expect(restored.find((i) => i.kind === "toolResult")).toMatchObject({ agentUsage: { tokens: 1, toolUses: 2, durationMs: 3 }, cliAgentId: "a1b2", stoppedBy: "user" });
  });

  // ------------------------------------------------------------ chat group

  it("a running group: model chip, 재개됨(N회차), ■ and the ⋯ menu; it opens by itself", async () => {
    useStore.setState({ transcript: agentRows() });
    setState({ gate: gate(running), hud: { ...useStore.getState().state.hud, agents: [node({ model: "opus", resumeCount: 1, resumedBy: "toolu_02Cd" })], turnStartedAt: Date.now() - 70_000 } });
    const { Transcript } = await import("./components/chat/Transcript");
    const html = await render(Transcript);
    const head = groupHead(html);
    expect(head).toContain('class="model-chip purple"');
    expect(head).toContain(">opus<");
    expect(head).toContain("재개됨(2회차)");
    expect(head).toContain('data-testid="Stop agent toolu_01Ab"');
    expect(head).toContain('aria-label="이 에이전트 중지"');
    expect(head).toContain('aria-expanded="true"');
    expect(html).toContain("rg couponCode");
  });

  it("a finished group with a §36 result: the cleaned report as markdown with 보고서 전체 보기; its first line under the collapsed head", async () => {
    useStore.setState({ transcript: agentRows({ agentUsage: { tokens: 14794, toolUses: 12, durationMs: 491500 }, cliAgentId: "a1b2c3d4" }) });
    const { Transcript } = await import("./components/chat/Transcript");
    const html = await render(Transcript);
    // Collapsed (finished, no node): the report's first line stays visible.
    expect(html).toContain('class="agent-summary truncate" title="쿠폰 코드 사용처 14곳"');
    expect(groupHead(html)).toContain(">opus<");
    expect(groupHead(html)).not.toContain("Stop agent");
    // Opened: the §36 report row.
    const { useAgentUi } = await import("./agentUi");
    useAgentUi.setState({ expand: { toolUseId: "toolu_01Ab", nonce: 1 } });
    const { AgentReportRow } = await import("./components/agents/AgentBits");
    const { agentViewOf } = await import("./agentDetails");
    const rows = useStore.getState().transcript;
    const result = rows[4] as Extract<ChatItem, { kind: "toolResult" }>;
    const view = agentViewOf({ use: rows[1] as Extract<ChatItem, { kind: "toolUse" }>, result, running: false, continuations: 0 });
    const row = await render(AgentReportRow, { result, view });
    expect(row).toContain('data-testid="View full report"');
    expect(row).toContain("보고서 전체 보기");
    expect(row).toContain("에이전트 보고");
    expect(row).toContain("쿠폰 코드 사용처 14곳");
  });

  it("in an open group a §36 result is the report row, an older engine's the plain row; a stop by the user reads 사용자가 중지", async () => {
    const { Transcript } = await import("./components/chat/Transcript");
    // A continued agent works again: its group is open and keeps its first report.
    useStore.setState({ transcript: agentRows({ agentUsage: { tokens: 1, toolUses: 1, durationMs: 1 }, cliAgentId: "a1b2c3d4" }) });
    setState({ gate: gate(running), hud: { ...useStore.getState().state.hud, agents: [node({ resumeCount: 1 })] } });
    const cleaned = await render(Transcript);
    expect(cleaned).toContain('data-testid="Agent report row"');
    expect(cleaned).toContain("보고서 전체 보기");
    // An older engine's raw result (no §36 fields): the plain row as before, no "보고서 전체 보기".
    useStore.setState({ transcript: agentRows({ preview: "[Subagent hand-back] The text below is the final report…", truncated: true }) });
    setHud({ agents: [node()] });
    const raw = await render(Transcript);
    expect(raw).not.toContain("Agent report row");
    expect(raw).not.toContain("보고서 전체 보기");
    expect(raw).toContain("✓ 에이전트 보고<button");
    expect(raw).toContain('data-testid="Show full output"');
    // Stopped by the user, after the next turn dropped the node: the row and the chip say so.
    setState({ gate: gate(), hud: { ...useStore.getState().state.hud, agents: [] } });
    useStore.setState({ transcript: agentRows({ isError: true, preview: "[Request interrupted by user for tool use]", stoppedBy: "user" }) });
    const html = await render(Transcript);
    expect(groupHead(html)).toContain("사용자가 중지");
    expect(groupHead(html)).toContain('data-testid="Agent status stopped"');
  });

  it("§36.3 a SendMessage that continues a known agent reads “executor에게 이어서: …”; one to another session stays a tool row", async () => {
    useStore.setState({
      transcript: [
        ...agentRows({ agentUsage: { tokens: 1, toolUses: 1, durationMs: 1 } }),
        { kind: "toolUse", id: 6, toolUseId: "toolu_02Cd", name: "SendMessage", input: { to: "a1b2c3d4", message: "gradle 테스트도 돌려줘\n그리고 보고해" }, continues: { agentToolUseId: "toolu_01Ab", agentType: "oh-my-claudecode:executor" } },
        { kind: "toolUse", id: 7, toolUseId: "toolu_05Ij", name: "SendMessage", input: { to: "acme-b4", message: "리뷰 부탁해" } },
      ],
    });
    const { Transcript } = await import("./components/chat/Transcript");
    const html = await render(Transcript);
    expect(html).toContain('data-testid="Continue row"');
    expect(html).toContain("executor에게 이어서: gradle 테스트도 돌려줘");
    expect(html.match(/data-testid="Continue row"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="Tool SendMessage"');
    // Continued once (the node is gone): the group says the run.
    expect(groupHead(html)).toContain("재개됨(2회차)");
  });

  it("§36.3 the SendMessage card says when the message continues a subagent of this session (it still asks)", async () => {
    const req = (to: string) => ({ requestId: `S-${to}`, toolName: "SendMessage", input: { to, message: "gradle 테스트도 돌려줘" } });
    setHud({ agents: [node({ status: "completed", endedAt: Date.now(), cliAgentId: "a1b2c3d4" })] });
    const session = useStore.getState().state.session;
    setState({ session: { ...session, open: true, pendingPermission: req("a1b2c3d4"), pendingPermissions: [req("a1b2c3d4")], peerTurn: null } });
    const { PermissionCard } = await import("./components/chat/PermissionCard");
    const html = await render(PermissionCard, { request: req("a1b2c3d4"), decision: null });
    expect(html).toContain('data-testid="SendMessage continues"');
    expect(html).toContain("서브에이전트 executor에게 이어서");
    expect(html).toContain('data-testid="SendMessage send"');
    const other = await render(PermissionCard, { request: req("acme-b4"), decision: null });
    expect(other).not.toContain("SendMessage continues");
  });

  // ------------------------------------------------------------ agent panel

  it("the agent card: model chip, 재개됨, hover ■, the report with 보고서 전체 보기 once finished, 사용자가 중지", async () => {
    // One after another: three side by side are compact rows since wave5 w5-board (§43.1, boardScreens.test.ts).
    const t0 = Date.now();
    setHud({ agents: [node({ model: "sonnet", resumeCount: 2 }), node({ id: "task-2", toolUseId: "toolu_09", status: "completed", startedAt: t0 - 300_000, endedAt: t0 - 250_000, reportPreview: "## 결과\n- 14곳", model: "haiku" }), node({ id: "task-3", toolUseId: "toolu_10", status: "stopped", stoppedBy: "user", startedAt: t0 - 200_000, endedAt: t0 - 150_000 })] });
    const { AgentPanel } = await import("./components/agents/AgentPanel");
    const html = await render(AgentPanel);
    const card = (id: string) => {
      const at = html.indexOf(`data-testid="Agent card ${id}"`);
      const next = html.indexOf('data-testid="Agent card ', at + 10);
      return html.slice(at, next < 0 ? undefined : next);
    };
    expect(card("toolu_01Ab")).toContain('class="model-chip blue"');
    expect(card("toolu_01Ab")).toContain("재개됨(3회차)");
    expect(card("toolu_01Ab")).toContain('data-testid="Stop agent toolu_01Ab"');
    expect(card("toolu_01Ab")).toContain('title="에이전트 상세"');
    expect(card("toolu_09")).toContain('class="model-chip green"');
    expect(card("toolu_09")).toContain('data-testid="Agent report preview"');
    expect(card("toolu_09")).toContain("보고서 전체 보기");
    expect(card("toolu_09")).not.toContain("Stop agent");
    expect(card("toolu_10")).toContain("사용자가 중지");
    // An engine before §36: no chip, no badge, no report line.
    setHud({ agents: [node({ status: "completed", endedAt: Date.now(), summary: "done" })] });
    const plain = await render(AgentPanel);
    expect(plain).not.toContain("model-chip");
    expect(plain).not.toContain("회차");
    expect(plain).not.toContain("Agent report preview");
    expect(plain).toContain("done");
  });

  it("■ is off with its reason before the task id arrives and when the engine cannot stop one agent", async () => {
    setHud({ agents: [node({ id: "toolu_01Ab" })] });
    const { StopAgentButton } = await import("./components/agents/AgentBits");
    const noTask = await render(StopAgentButton, { node: node({ id: "toolu_01Ab" }) });
    expect(noTask).toContain("disabled");
    expect(noTask).toContain("작업 id");
    const { useAgentUi } = await import("./agentUi");
    useAgentUi.setState({ stopUnsupported: true });
    const old = await render(StopAgentButton, { node: node() });
    expect(old).toContain("disabled");
    expect(old).toContain("업데이트");
    expect(await render(StopAgentButton, { node: node({ status: "completed" }) })).toBe("");
  });

  // ------------------------------------------------------------ composer / queue

  it("§36.4 the composer line and the queue while the main turn waits on subagents", async () => {
    const startedAt = Date.now() - 252_000;
    setState({ gate: gate(running), hud: { ...useStore.getState().state.hud, agents: [node()], turnStartedAt: Date.now() - 300_000, waitingOnAgents: { count: 2, longest: { toolUseId: "toolu_01Ab", type: "oh-my-claudecode:executor", startedAt } } } });
    useStore.setState({ queue: { ...useStore.getState().queue, items: [{ id: 1, text: "다음 할 일" }] } });
    const { Composer } = await import("./components/chat/Composer");
    const html = await render(Composer);
    expect(html).toMatch(/data-testid="Composer waiting">.*<span class="truncate">메인은 서브에이전트 2개를 기다리는 중 · executor 4분 1[23]초<\/span>/);
    expect(html).toContain('data-testid="Queue status">에이전트가 끝나면 보냄<');
    // The footer's hint keeps the gate's reason (§50: and that ⌘↩ sends it now); a permission still says so there and in the queue.
    expect(html).toContain('data-testid="Composer hint">Claude가 작업 중… — ⌘↩로 바로 보내기<');
    setState({ gate: gate({ ...running, blockedReason: "awaiting_permission" }) });
    const perm = await render(Composer);
    expect(perm).toContain('data-testid="Composer hint">권한 결정 대기 중<');
    expect(perm).not.toContain("에이전트가 끝나면 보냄");
    // An engine before §36: everything as before.
    setState({ gate: gate(running), hud: { ...useStore.getState().state.hud, waitingOnAgents: undefined } });
    const old = await render(Composer);
    expect(old).not.toContain("Composer waiting");
    expect(old).toContain('data-testid="Composer hint">Claude가 작업 중… — ⌘↩로 바로 보내기<');
    expect(old).not.toContain("에이전트가 끝나면 보냄");
  });

  // ------------------------------------------------------------ side panel

  it("§36.10 the side thread head says only a summary of the running turn was shared; the new-question hint while a turn runs", async () => {
    const thread = (fork: SideThread["fork"]): SideThread => ({ id: "th1", mainSessionId: "s1", anchor: null, createdAt: "2026-10-23T03:00:00.000Z", updatedAt: "2026-10-23T03:00:00.000Z", title: "왜 gradle?", messages: [], status: "idle", error: null, sessionId: "x", fork, costUSD: 0 });
    useStore.setState({ sidePanelOpen: true, sideView: { kind: "thread", threadId: "th1" }, side: { mainSessionId: "s1", threads: { th1: thread({ mode: "fork_at", fromSessionId: "s1", at: "u1", atTurn: 6, runningTurn: 7 }) }, live: {} } });
    const { SidePanel } = await import("./components/side/SidePanel");
    const html = await render(SidePanel);
    expect(html).toContain('data-testid="Side running turn"');
    expect(html).toContain("턴 7 진행 중 — 요약만 전달됨");
    expect(html).toContain("턴 6까지의 대화");
    // fresh while the first turn ran: the chip, not "the anchor context is all it knows"
    useStore.setState({ side: { mainSessionId: "s1", threads: { th1: thread({ mode: "fresh", fromSessionId: null, at: null, atTurn: null, runningTurn: 1 }) }, live: {} } });
    const fresh = await render(SidePanel);
    expect(fresh).toContain("턴 1 진행 중 — 요약만 전달됨");
    expect(fresh).not.toContain("side-fork\"");
    // An engine before §36 (no field): no chip; a fresh thread keeps its old hint.
    useStore.setState({ side: { mainSessionId: "s1", threads: { th1: thread({ mode: "fresh", fromSessionId: null, at: null }) }, live: {} } });
    const old = await render(SidePanel);
    expect(old).not.toContain("Side running turn");
    expect(old).toContain('class="tiny faint side-fork"');
    // New question while a turn runs: what it would know — never the review list.
    setState({ gate: gate(running) });
    useStore.setState({ sideView: { kind: "new", anchor: null, question: "", nonce: 1 } });
    const ask = await render(SidePanel);
    expect(ask).toContain('data-testid="Side fork hint"');
    expect(ask).toContain("진행 중인 턴의 요약");
    setState({ gate: gate() });
    expect(await render(SidePanel)).not.toContain("Side fork hint");
  });

  // ------------------------------------------------------------ details sheet

  it("the details sheet: instructions, report, tool calls, files, usage and model; ■ while it runs", async () => {
    useStore.setState({ transcript: agentRows({ agentUsage: { tokens: 14794, toolUses: 12, durationMs: 491500 }, cliAgentId: "a1b2c3d4" }) });
    const { AgentDetailSheet } = await import("./components/agents/AgentDetailSheet");
    const html = await render(AgentDetailSheet, { toolUseId: "toolu_01Ab", onClose: () => undefined });
    expect(html).toContain("에이전트 상세");
    expect(html).toContain('data-testid="Agent sheet instructions"');
    expect(html).toContain("couponCode 가 쓰이는 곳을");
    expect(html).toContain('data-testid="Agent sheet report"');
    expect(html).toContain("쿠폰 코드 사용처 14곳");
    expect(html).toContain("메인으로 보내기");
    expect(html).toContain("곁질문으로 묻기");
    expect(html).toContain("rg couponCode");
    expect(html).toContain("14.8k 토큰");
    expect(html).toContain("8분 11초");
    expect(html).toContain('class="model-chip purple"');
    expect(html).not.toContain("Stop agent");
    // Running: ■ with its words, no report yet (its buttons off with the reason).
    useStore.setState({ transcript: agentRows() });
    setState({ gate: gate(running), hud: { ...useStore.getState().state.hud, agents: [node({ model: null, prompt: "짧은 지시" })] } });
    const live = await render(AgentDetailSheet, { toolUseId: "toolu_01Ab", onClose: () => undefined });
    expect(live).toContain('data-testid="Stop agent toolu_01Ab"');
    expect(live).toContain("이 에이전트 중지");
    expect(live).toContain("끝나면 보고서가 와요");
    expect(live).toContain("에이전트 기본값");
    // the transcript's input prompt is longer than the node's
    expect(live).toContain("couponCode 가 쓰이는 곳을");
    // §36.3 continued: the previous run's report stays readable (and its buttons on) while the agent works again.
    useStore.setState({ transcript: agentRows({ agentUsage: { tokens: 1, toolUses: 1, durationMs: 1 } }) });
    setHud({ agents: [node({ resumeCount: 1, reportPreview: "## 쿠폰 코드 사용처 14곳" })] });
    const again = await render(AgentDetailSheet, { toolUseId: "toolu_01Ab", onClose: () => undefined });
    expect(again).toContain("이전 실행의 보고서예요");
    expect(again).toContain("쿠폰 코드 사용처 14곳");
    expect(again).not.toMatch(/disabled="" title="[^"]*" data-testid="Agent report to main"/);
    // Asked for an agent this chat does not have (another chat became current): says so.
    const unknown = await render(AgentDetailSheet, { toolUseId: "toolu_gone", onClose: () => undefined });
    expect(unknown).toContain('data-testid="Agent sheet unknown"');
    expect(unknown).toContain("이 대화에서 이 에이전트를 찾지 못했어요");
  });

  it("the HUD lists the agents for their details", async () => {
    const { AgentListButton } = await import("./components/agents/AgentBits");
    expect(await render(AgentListButton)).toBe("");
    setHud({ agents: [node()] });
    expect(await render(AgentListButton)).toContain('data-testid="HUD agent list"');
  });

  // ------------------------------------------------------------ actions

  it("stop_agent: the request, and refusals that keep ■ off with the reason", async () => {
    const { stopAgent, useAgentUi } = await import("./agentUi");
    const { useToast } = await import("./toast");
    expect(await stopAgent("toolu_01Ab")).toBeNull();
    expect(sent.at(-1)).toEqual({ type: "stop_agent", toolUseId: "toolu_01Ab" });
    respond = () => ({ ok: false, error: "not_running", code: "not_running" });
    expect(await stopAgent("toolu_01Ab")).toBe("이 에이전트는 이미 끝났어요");
    expect(useToast.getState().text).toBe("이 에이전트는 이미 끝났어요");
    respond = () => ({ ok: false, error: "not_supported", code: "not_supported" });
    await stopAgent("toolu_01Ab");
    expect(useAgentUi.getState().stopRefused["toolu_01Ab"]).toContain("턴 전체");
    respond = () => ({ ok: false, error: "unknown command: stop_agent", code: "unknown_command" });
    await stopAgent("toolu_09");
    expect(useAgentUi.getState().stopUnsupported).toBe(true);
    expect(useAgentUi.getState().stopping).toEqual({});
  });

  it("agent_report: the whole report, or the refusal in words", async () => {
    const { fetchAgentReport } = await import("./agentUi");
    respond = () => ({ ok: true, reply: { type: "agent_report", toolUseId: "toolu_01Ab", text: "## 전체", truncated: false, usage: { tokens: 1, toolUses: 2, durationMs: 3 }, model: "opus", prompt: "지시 전문" } });
    const ok = await fetchAgentReport("toolu_01Ab");
    expect(ok).toMatchObject({ ok: true, report: { text: "## 전체", prompt: "지시 전문" } });
    expect(sent.at(-1)).toEqual({ type: "agent_report", toolUseId: "toolu_01Ab" });
    respond = () => ({ ok: false, error: "no_report", code: "no_report" });
    expect(await fetchAgentReport("toolu_01Ab")).toMatchObject({ ok: false, code: "no_report" });
  });

  it("the OS notification is asked once per turn when the waited-on subagents finished in the background", async () => {
    const { notifyWhenAgentsFinish } = await import("./agentUi");
    const asked: string[] = [];
    let listener: ((s: { state: ReviewState }, prev: { state: ReviewState }) => void) | null = null;
    const store = { subscribe: (l: typeof listener) => ((listener = l), () => undefined) };
    notifyWhenAgentsFinish(store as never, { focused: () => false, notify: async (n) => asked.push(n.body) });
    const base = useStore.getState().state;
    const st = (w: unknown) => ({ state: { ...base, gate: gate(running), hud: { ...base.hud, turnStartedAt: 42, waitingOnAgents: w } } as ReviewState });
    const w = { count: 1, longest: { toolUseId: "toolu_01Ab", type: "executor", startedAt: 1 } };
    listener!(st(null), st(w));
    listener!(st(null), st(w));
    expect(asked).toEqual(["서브에이전트가 모두 끝났어요 — Claude가 이어서 작업 중"]);
  });

  it("메인으로 보내기 hands the report to the composer (it waits for one that is not mounted)", async () => {
    const { insertIntoComposer, joinDraft } = await import("./composerBridge");
    expect(insertIntoComposer("> 보고")).toBe(false);
    expect(joinDraft("", "> 보고")).toBe("> 보고");
    expect(joinDraft("먼저 쓴 말  \n", "> 보고")).toBe("먼저 쓴 말\n\n> 보고");
  });
});
