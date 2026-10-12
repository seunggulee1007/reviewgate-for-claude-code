import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineCommand, RateLimitWindow, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { errorEventText, presentationOf } from "./errorCodes";
import { errorSubline, errorTone, pausesQueue } from "./sessionErrors";
import { notificationFor } from "./attention";
import { TurnStopTracker } from "./workSafety";
import {
  activeLimitReset,
  isUsageLimited,
  limitChipText,
  limitResumeStep,
  leftChat,
  longWorkRowFacts,
  maxTurnsOf,
  NO_LIMIT_RESUME,
  usageMeter,
  weeklyPercent,
} from "./longWork";

// wave4 w4-longwork — docs/PROTOCOL.md §38.2 in Electron, as on the Mac (Core/Tests/…/LongWorkTests.swift).

describe("words and presentation", () => {
  it("the tool-call limit, hooks and the CLI's words", () => {
    expect(errorEventText({ code: "max_turns", message: "x", maxTurns: 200 })).toBe("Claude stopped at the tool-call limit (200 calls)");
    expect(errorEventText({ code: "max_turns", message: "x" })).toBe("Claude stopped at the tool-call limit");
    expect(errorEventText({ code: "hook_failed", message: "x", hookName: "PostToolUse:Bash" })).toBe("A hook failed: PostToolUse:Bash");
    expect(errorEventText({ code: "hook_blocked", message: "x", detail: "blocked: commit first" })).toBe("A hook stopped this turn");
    expect(errorEventText({ code: "cli_warning", message: "Context is low", detail: "Context is low" })).toBe("Context is low");
    expect(presentationOf("max_turns")).toBe("warning");
    for (const code of ["hook_failed", "hook_blocked", "cli_warning", "cli_notice"]) expect(presentationOf(code)).toBe("row");
    expect(errorTone("hook_failed", false)).toBe("warning");
    expect(errorTone("cli_warning", false)).toBe("warning");
    expect(errorTone("cli_notice", false)).toBe("info");
    expect(errorTone("max_turns", false)).toBe("warning");
    for (const code of ["max_turns", "hook_failed", "hook_blocked", "cli_warning", "cli_notice"]) expect(pausesQueue({ fatal: false, code })).toBe(false);
    expect(errorSubline({ code: "cli_warning", cliDetail: "Context is low" })).toBe("");
    expect(errorSubline({ code: "hook_blocked", cliDetail: "blocked: commit first" })).toBe("blocked: commit first");
    expect(longWorkRowFacts({ maxTurns: 150, hookName: "" })).toEqual({ maxTurns: 150 });
  });

  // MARK: wave4b w4b-check4 — §40.1
  it("a hook that blocked on purpose names itself and its reason in one row (no second copy); a failure stays a failure", () => {
    expect(errorEventText({ code: "hook_blocked", message: "x", hookName: "PreToolUse:Bash", detail: "no rm -rf in this repo" })).toBe("Blocked by a hook: PreToolUse:Bash — no rm -rf in this repo");
    expect(errorEventText({ code: "hook_blocked", message: "x", hookName: "Stop" })).toBe("Blocked by a hook: Stop");
    expect(errorSubline({ code: "hook_blocked", cliDetail: "no rm -rf in this repo", exitCode: 2 })).toBe("");
    expect(errorEventText({ code: "hook_failed", message: "x", hookName: "PostToolUse:Bash" })).toBe("A hook failed: PostToolUse:Bash");
    expect(errorSubline({ code: "hook_failed", cliDetail: "not found", exitCode: 1 })).toBe("not found · exit code 1");
  });

  it("the turn that stopped at the limit says why in its notification (the one stop-reason list of workSafety.ts)", () => {
    const end = { type: "turn_end", stopReason: "error_max_turns", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 }, files: 0, added: 0, deleted: 0, changedOutside: [] } as never;
    const tracker = new TurnStopTracker();
    // The max_turns notice of the running turn waits for its end, which says why.
    expect(tracker.observe({ type: "error", message: "x", fatal: false, scope: "session", code: "max_turns", maxTurns: 200 } as never, true)).toEqual({ stop: null, suppress: true });
    const { stop, suppress } = tracker.observe(end, false);
    expect(suppress).toBe(false);
    expect(notificationFor(end, { project: "p", stop })).toMatchObject({ kind: "turn_done", body: "Stopped at the tool-call limit" });
    // A notice that came while no turn was seen running: the turn_end's own stopReason still says it.
    expect(new TurnStopTracker().observe(end, false).stop?.kind).toBe("maxTurns");
    // A stronger reason of the same turn wins (a login problem explains the stop).
    const both = new TurnStopTracker();
    both.observe({ type: "error", message: "x", fatal: false, scope: "session", code: "max_turns" } as never, true);
    both.observe({ type: "error", message: "x", fatal: false, scope: "session", code: "auth_required" } as never, true);
    expect(both.observe(end, false).stop?.kind).toBe("loginRequired");
    expect(notificationFor({ type: "error", message: "x", fatal: false, scope: "session", code: "hook_failed" }, { project: "p" })).toBeNull();
  });

  it("maxTurns: 10–1000, default 200", () => {
    expect(maxTurnsOf(undefined)).toBe(200);
    expect(maxTurnsOf(5)).toBe(10);
    expect(maxTurnsOf(5000)).toBe(1000);
    expect(maxTurnsOf(300)).toBe(300);
  });
});

describe("usage limit (pure)", () => {
  const reset = 1_000_000_000;
  it("fires once idle a minute past the reset; another turn or no reset time cancels", () => {
    const s = { ...NO_LIMIT_RESUME, limitResetAt: reset, armed: true };
    expect(limitResumeStep({ ...s, armed: false }, { running: false, idle: true, now: reset + 61_000 })).toBe("wait");
    expect(limitResumeStep(s, { running: false, idle: true, now: reset + 30_000 })).toBe("wait");
    expect(limitResumeStep(s, { running: false, idle: false, now: reset + 61_000 })).toBe("wait");
    expect(limitResumeStep(s, { running: false, idle: true, now: reset + 61_000 })).toBe("fire");
    expect(limitResumeStep(s, { running: true, idle: false, now: reset })).toBe("wait");
    expect(limitResumeStep({ ...s, idleSinceArmed: true }, { running: true, idle: false, now: reset })).toBe("cancel");
    expect(limitResumeStep({ ...s, limitResetAt: null }, { running: false, idle: true, now: reset })).toBe("cancel");
  });

  it("the limit in force and the use meter", () => {
    const windows: RateLimitWindow[] = [
      { kind: "five_hour", status: "rejected", resetsAt: new Date(reset + 10_000).toISOString(), at: "" },
      { kind: "seven_day_opus", status: "allowed", percent: 85, at: "" },
    ];
    expect(activeLimitReset(windows, null, reset)).toBe(reset + 10_000);
    expect(activeLimitReset(windows, null, reset + 20_000)).toBeNull();
    expect(isUsageLimited([{ kind: "five_hour", status: "rejected", at: "" }], null, reset)).toBe(true);
    expect(weeklyPercent(windows)).toBe(85);
    expect(usageMeter(windows)).toEqual({ text: "Week 85%", high: true });
    expect(usageMeter([{ kind: "five_hour", status: "allowed", percent: 30, at: "" }])).toEqual({ text: "5h 30%", high: false });
    expect(usageMeter([])).toBeNull();
    expect(limitChipText("3:00 PM", true)).toBe("Usage limit — resets at 3:00 PM · continues after");
  });
});

// ---------------------------------------------------------------- store

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string };
const sent: EngineCommand[] = [];

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand): Promise<Reply> => {
        sent.push(c);
        return { ok: true, reply: { type: "result", ok: true } };
      },
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}

type UseStore = Awaited<ReturnType<typeof loadStore>>;
const flush = () => new Promise((r) => setTimeout(r, 0));
const sends = () => sent.filter((c) => c.type === "send").map((c) => (c as { text: string }).text);

function reset(useStore: UseStore, gate: Partial<ReviewState["gate"]> = {}) {
  const s = useStore.getState().state;
  useStore.setState({
    state: {
      ...s,
      seq: s.seq + 1,
      project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null },
      session: { ...s.session, open: true, ready: true, peerInbox: [], externalTurn: null },
      gate: { ...s.gate, canSend: true, phase: "idle", blockedReason: null, ...gate },
    } as ReviewState,
    transcript: [],
    errorBanner: null,
    lastError: null,
    limitResume: { ...NO_LIMIT_RESUME },
    queue: { items: [], paused: null, inflight: false, awaitingTurn: false, skipInterruptPause: false },
  });
  sent.length = 0;
}

function snapshot(useStore: UseStore, gate: Partial<ReviewState["gate"]> = {}) {
  const s = useStore.getState().state;
  useStore.getState().handleEvent({ type: "state", state: { ...s, seq: s.seq + 1, gate: { ...s.gate, ...gate } } });
}

describe("store (§38.2)", () => {
  let useStore: UseStore;
  beforeAll(async () => {
    initI18n("en", "darwin");
    useStore = await loadStore();
  });
  afterAll(() => {
    useStore.getState().cancelLimitResume();
  });

  it("max_turns: an orange banner with [이어서 계속] that sends “continue” by the queue rules; no stopped queue", async () => {
    reset(useStore);
    useStore.getState().handleEvent({ type: "error", message: "stopped", fatal: false, scope: "session", code: "max_turns", maxTurns: 150 });
    const st = useStore.getState();
    expect(st.errorBanner).toMatchObject({ code: "max_turns", message: "Claude stopped at the tool-call limit (150 calls)" });
    expect(st.transcript.filter((i) => i.kind === "error").map((i) => (i as { message: string }).message)).toEqual(["Claude stopped at the tool-call limit (150 calls)"]);
    expect(st.queue.paused).toBeNull();
    st.continueWork();
    await flush();
    expect(sends()).toEqual(["Please continue."]);
  });

  it("while Claude works, [이어서 계속] waits in the queue", () => {
    reset(useStore, { canSend: false, phase: "running" });
    useStore.getState().continueWork();
    expect(sends()).toEqual([]);
    expect(useStore.getState().queue.items.map((i) => i.text)).toEqual(["Please continue."]);
  });

  it("hook / CLI notices: rows only (×N), no banner", () => {
    reset(useStore);
    const ev = { type: "error" as const, message: "Context is low", fatal: false, scope: "session" as const, code: "cli_warning", detail: "Context is low" };
    useStore.getState().handleEvent(ev);
    useStore.getState().handleEvent(ev);
    const st = useStore.getState();
    const rows = st.transcript.filter((i) => i.kind === "error") as { message: string; count?: number }[];
    expect(rows.map((r) => [r.message, r.count ?? 1])).toEqual([["Context is low", 2]]);
    expect(st.errorBanner).toBeNull();
  });

  it("풀리면 이어서 하기: armed on a limit with a reset, sends “continue” once past it, a later turn disarms", async () => {
    reset(useStore);
    const resetAt = Date.now() + 3_600_000;
    useStore.getState().handleEvent({ type: "error", message: "limit", fatal: false, scope: "session", code: "usage_limit", resetAt: new Date(resetAt).toISOString() });
    useStore.getState().armLimitResume();
    expect(useStore.getState().limitResume).toMatchObject({ armed: true, limitResetAt: resetAt });
    useStore.getState().stepLimitResume(resetAt + 30_000);
    expect(sends()).toEqual([]);
    useStore.getState().resumeQueue();
    useStore.getState().stepLimitResume(resetAt + 61_000);
    await flush();
    expect(sends()).toEqual(["Please continue."]);
    expect(useStore.getState().limitResume.armed).toBe(false);

    reset(useStore);
    useStore.getState().handleEvent({ type: "error", message: "limit", fatal: false, scope: "session", code: "usage_limit", resetAt: new Date(resetAt).toISOString() });
    useStore.getState().armLimitResume();
    snapshot(useStore, { phase: "running", canSend: false }); // the user sent something
    expect(useStore.getState().limitResume.armed).toBe(false);
  });

  // MARK: wave4b w4b-check4 — §40.1 (as on the Mac, LongWorkTests.armedResumeNeverGoesToAnotherChat)
  it("풀리면 이어서 하기 belongs to its chat: another chat (a switch, a move, another project) disarms it, nothing is sent", async () => {
    reset(useStore);
    const withChat = (id: string) => {
      const s = useStore.getState().state;
      useStore.getState().handleEvent({ type: "state", state: { ...s, seq: s.seq + 1, sessions: { list: [], currentId: id, openTabIds: ["c1", "c2"] } } });
    };
    withChat("c1");
    const resetAt = Date.now() + 3_600_000;
    useStore.getState().handleEvent({ type: "error", message: "limit", fatal: false, scope: "session", code: "usage_limit", resetAt: new Date(resetAt).toISOString() });
    useStore.getState().armLimitResume();
    expect(useStore.getState().limitResume).toMatchObject({ armed: true, chatId: "c1" });
    withChat("c1");
    expect(useStore.getState().limitResume.armed).toBe(true);
    withChat("c2");
    expect(useStore.getState().limitResume.armed).toBe(false);
    useStore.getState().stepLimitResume(resetAt + 120_000);
    await flush();
    expect(sends()).toEqual([]);
    expect(leftChat(null, "c2")).toBe(false); // armed without a chat id: as before
    expect(leftChat("c1", null)).toBe(true);
  });
});
