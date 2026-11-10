import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, PermissionMode, ReviewState } from "@reviewgate/engine";
import type { AppSettings } from "../shared/ipc";
import { initI18n } from "./i18n";
import { autoModeMayRunAgain, isModeCycleKey, modeLine, nextPermissionMode, planApproveMode } from "./terminalMode";

// MARK: wave6 w6-terminal — docs/PROTOCOL.md §44.1 in Electron, as on the Mac (TerminalModeTests.swift): Shift+Tab cycles the
// permission mode like the terminal, the mode line says which one runs, a plan made in an auto chat is approved back into auto.

const state = (session: Partial<ReviewState["session"]>, extra: Partial<ReviewState> = {}): ReviewState =>
  ({ project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null }, session: { permissionMode: "default", ...session }, ...extra }) as ReviewState;

describe("the terminal's mode cycle (§44.1)", () => {
  it("default → accept edits → plan → auto → default; auto is skipped where it cannot run", () => {
    expect(nextPermissionMode("default", true)).toBe("acceptEdits");
    expect(nextPermissionMode("acceptEdits", true)).toBe("plan");
    expect(nextPermissionMode("plan", true)).toBe("auto");
    expect(nextPermissionMode("auto", true)).toBe("default");
    expect(nextPermissionMode("plan", false)).toBe("default");
    expect(nextPermissionMode("auto", false)).toBe("default");
  });

  it("only Shift+Tab alone cycles (Ctrl / Alt / ⌘ / an input method composing leave it alone)", () => {
    const k = { key: "Tab", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false };
    expect(isModeCycleKey(k)).toBe(true);
    expect(isModeCycleKey({ ...k, shiftKey: false })).toBe(false);
    expect(isModeCycleKey({ ...k, ctrlKey: true })).toBe(false);
    expect(isModeCycleKey({ ...k, altKey: true })).toBe(false);
    expect(isModeCycleKey({ ...k, metaKey: true })).toBe(false);
    expect(isModeCycleKey({ ...k, isComposing: true })).toBe(false);
    expect(isModeCycleKey({ ...k, key: "Enter" })).toBe(false);
  });
});

describe("the mode line (§44.1)", () => {
  it("names the mode in the terminal's words; plan mode from auto says approving goes back", () => {
    expect(modeLine("auto")).toEqual({ text: "⏵⏵ Auto mode (shift+tab to switch)", tone: "auto" });
    expect(modeLine("acceptEdits")).toEqual({ text: "⏵⏵ Accept edits mode (shift+tab to switch)", tone: "acceptEdits" });
    expect(modeLine("plan")).toEqual({ text: "⏸ Plan mode (shift+tab to switch)", tone: "plan" });
    expect(modeLine("plan", { approvesIntoAuto: true }).text).toBe("⏸ Plan mode — approving goes back to auto mode (shift+tab to switch)");
    expect(modeLine("default")).toEqual({ text: "Default mode (shift+tab to switch)", tone: "plain" });
    expect(modeLine("default", { scheduledLabel: "Plan" }).text).toBe("Default mode · From the next turn: Plan (shift+tab to switch)");
    // Auto mode the engine said cannot run here: the CLI runs the default mode, and the line says so.
    expect(modeLine("auto", { autoUnavailable: true })).toEqual({ text: "Auto mode is not available here — running in default mode (shift+tab to switch)", tone: "plain" });
  });

  it("in Korean", () => {
    initI18n("ko", "win32");
    try {
      expect(modeLine("auto").text).toBe("⏵⏵ 자동 모드 (shift+tab 전환)");
      expect(modeLine("plan", { approvesIntoAuto: true }).text).toBe("⏸ 계획 모드 — 승인하면 자동 모드로 돌아가요 (shift+tab 전환)");
      expect(modeLine("acceptEdits").text).toBe("⏵⏵ 편집 바로 허용 모드 (shift+tab 전환)");
      expect(modeLine("default").text).toBe("기본 모드 (shift+tab 전환)");
      expect(modeLine("auto", { autoUnavailable: true }).text).toBe("자동 모드를 쓸 수 없어 기본 모드로 동작해요 (shift+tab 전환)");
    } finally {
      initI18n("en", "darwin");
    }
  });
});

describe("approving a plan (§44.1)", () => {
  it("goes back to auto when the chat came from auto mode, else to default as before (an older engine sends nothing)", () => {
    expect(planApproveMode(state({ permissionMode: "plan", prePlanMode: "auto" }))).toBe("auto");
    expect(planApproveMode(state({ permissionMode: "plan", prePlanMode: "acceptEdits" }))).toBe("default");
    expect(planApproveMode(state({ permissionMode: "plan", prePlanMode: null }))).toBe("default");
    expect(planApproveMode(state({ permissionMode: "plan" }))).toBe("default");
    // Not into an auto mode the engine said cannot run here: that switch would be refused and the plan would wait.
    expect(planApproveMode(state({ permissionMode: "plan", prePlanMode: "auto" }), true)).toBe("default");
  });

  it("auto mode may run again in another project or with another model", () => {
    const a = state({ selectedModel: null });
    expect(autoModeMayRunAgain(a, state({ selectedModel: null }))).toBe(false);
    expect(autoModeMayRunAgain(a, state({ selectedModel: "opus" }))).toBe(true);
    expect(autoModeMayRunAgain(a, state({}, { project: { path: "/b", root: "/b", name: "b", branch: null, remoteURL: null } }))).toBe(true);
  });
});

// ---------------------------------------------------------------- the store (engine bridge mocked, as in permissionStore.test.ts)

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string };
const calls: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => calls.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        calls.push(c);
        return respond(c);
      },
      setSettings: async (patch: Partial<AppSettings>) => patch,
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}

type UseStore = Awaited<ReturnType<typeof loadStore>>;
const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const modeCalls = () => calls.filter((c): c is Extract<EngineCommand, { type: "set_permission_mode" }> => c.type === "set_permission_mode").map((c) => c.mode);

describe("Shift+Tab in the store (§44.1)", () => {
  beforeEach(() => {
    calls.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  /** The engine's next snapshot: an open session in `mode`, idle unless `running`. */
  const snapshot = (useStore: UseStore, mode: PermissionMode, opts: { running?: boolean; selectedModel?: string | null } = {}) => {
    const s = useStore.getState().state;
    const session = { ...s.session, open: true, permissionMode: mode, ...(opts.selectedModel !== undefined ? { selectedModel: opts.selectedModel } : {}) };
    const gate = { ...s.gate, phase: opts.running ? "running" : "idle", canSend: !opts.running } as ReviewState["gate"];
    useStore.getState().handleEvent({ type: "state", state: { ...s, seq: s.seq + 1, project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null }, session, gate } });
  };

  it("switches to the next mode now; while a plan-mode turn runs it waits for the turn's end and goes on from the waiting one", async () => {
    const useStore = await loadStore();
    useStore.setState({ scheduledPermissionMode: null, autoModeUnavailable: false });
    snapshot(useStore, "default");
    useStore.getState().cyclePermissionMode();
    await flush();
    snapshot(useStore, "acceptEdits");
    useStore.getState().cyclePermissionMode();
    await flush();
    expect(modeCalls()).toEqual(["acceptEdits", "plan"]);
    calls.length = 0;
    snapshot(useStore, "plan", { running: true });
    useStore.getState().cyclePermissionMode();
    useStore.getState().cyclePermissionMode();
    expect(modeCalls()).toEqual([]);
    expect(useStore.getState().scheduledPermissionMode).toBe("default");
  });

  // §39.5: a pick goes out while Claude works — the CLI applies it from its next tool call; plan mode waits for the turn's end.
  it("while a turn runs in the default mode: accept edits and auto go out at once, plan waits (and Shift+Tab goes on from it)", async () => {
    const useStore = await loadStore();
    useStore.setState({ scheduledPermissionMode: null, autoModeUnavailable: false, requestedPermissionMode: null });
    snapshot(useStore, "default", { running: true });
    useStore.getState().cyclePermissionMode();
    expect(modeCalls()).toEqual(["acceptEdits"]);
    await flush();
    snapshot(useStore, "acceptEdits", { running: true });
    await until(() => useStore.getState().requestedPermissionMode === null);
    useStore.getState().cyclePermissionMode();
    expect(modeCalls()).toEqual(["acceptEdits"]);
    expect(useStore.getState().scheduledPermissionMode).toBe("plan");
    useStore.getState().cyclePermissionMode();
    expect(modeCalls()).toEqual(["acceptEdits", "auto"]);
    expect(useStore.getState().scheduledPermissionMode).toBeNull();
    await flush();
    snapshot(useStore, "auto", { running: true });
    await until(() => useStore.getState().requestedPermissionMode === null);
  });

  it("a switch the engine refuses session_busy (the turn began to be collected) waits for the turn's end, with no banner", async () => {
    const useStore = await loadStore();
    useStore.setState({ scheduledPermissionMode: null, autoModeUnavailable: false, requestedPermissionMode: null, errorBanner: null });
    respond = (c) =>
      c.type === "set_permission_mode" ? { ok: false, error: "session_busy", code: "session_busy" } : { ok: true, reply: { type: "result", ok: true } };
    snapshot(useStore, "default", { running: true });
    useStore.getState().pickPermissionMode("auto");
    expect(modeCalls()).toEqual(["auto"]);
    await flush();
    snapshot(useStore, "default", { running: true }); // ends the refusal's settle()
    await until(() => useStore.getState().scheduledPermissionMode === "auto");
    expect(useStore.getState().errorBanner).toBeNull();
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    calls.length = 0;
    snapshot(useStore, "default"); // the turn ended: the waiting pick goes out
    expect(modeCalls()).toEqual(["auto"]);
    await flush();
    snapshot(useStore, "auto");
    await until(() => useStore.getState().requestedPermissionMode === null);
  });

  it("a refused auto (or the engine's notice) makes Shift+Tab skip auto until another model", async () => {
    const useStore = await loadStore();
    useStore.setState({ scheduledPermissionMode: null, autoModeUnavailable: false });
    respond = (c) =>
      c.type === "set_permission_mode" && c.mode === "auto"
        ? { ok: false, error: "auto_mode_unavailable: Cannot set permission mode to auto: auto mode unavailable for this model", code: "auto_mode_unavailable" }
        : { ok: true, reply: { type: "result", ok: true } };
    snapshot(useStore, "plan");
    useStore.getState().cyclePermissionMode();
    await flush();
    snapshot(useStore, "plan"); // the engine's next state ends the refusal's settle()
    await until(() => useStore.getState().autoModeUnavailable);
    useStore.getState().cyclePermissionMode();
    await flush();
    expect(modeCalls()).toEqual(["auto", "default"]);
    snapshot(useStore, "default", { selectedModel: "opus" });
    expect(useStore.getState().autoModeUnavailable).toBe(false);
    useStore.getState().handleEvent({ type: "error", message: "Auto mode is not available here", fatal: false, scope: "session", code: "auto_mode_unavailable", detail: "default" });
    expect(useStore.getState().autoModeUnavailable).toBe(true);
  });

  // Architect review (§44.1): Shift+Tab pressed again before the engine's state came back goes on from the mode on its way.
  it("a second Shift+Tab before the engine answered goes on from the requested mode (never the same mode twice)", async () => {
    const useStore = await loadStore();
    useStore.setState({ scheduledPermissionMode: null, autoModeUnavailable: false, requestedPermissionMode: null });
    snapshot(useStore, "default");
    useStore.getState().cyclePermissionMode();
    useStore.getState().cyclePermissionMode();
    useStore.getState().cyclePermissionMode();
    expect(modeCalls()).toEqual(["acceptEdits", "plan", "auto"]);
    expect(useStore.getState().requestedPermissionMode).toBe("auto");
    // Back to the mode the snapshot shows while another switch is on its way: still sent.
    useStore.getState().cyclePermissionMode();
    expect(modeCalls()).toEqual(["acceptEdits", "plan", "auto", "default"]);
    // The engine's snapshot after its answers ends every switch's settle(), in the order sent. Sent before the answers, it
    // left each switch waiting out settle()'s 500 ms, and the "auto" one could finish after this test had ended and clear
    // the next test's autoModeUnavailable (Windows CI).
    await flush();
    snapshot(useStore, "default");
    await until(() => useStore.getState().requestedPermissionMode === null);
  });

  it("a refused plan answer that says auto mode cannot run is remembered too (the next approval goes into default)", async () => {
    const useStore = await loadStore();
    useStore.setState({ scheduledPermissionMode: null, autoModeUnavailable: false, requestedPermissionMode: null, planAnswering: false });
    respond = (c) =>
      c.type === "plan_response"
        ? { ok: false, error: "auto_mode_unavailable: Cannot set permission mode to auto", code: "auto_mode_unavailable" }
        : { ok: true, reply: { type: "result", ok: true } };
    const s = useStore.getState().state;
    useStore.getState().handleEvent({
      type: "state",
      state: { ...s, seq: s.seq + 1, project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null },
        session: { ...s.session, open: true, permissionMode: "plan", prePlanMode: "auto", pendingPlan: { path: null, plan: "# p", at: "2026-10-26T00:00:00Z" } },
        gate: { ...s.gate, phase: "idle", canSend: true } },
    });
    expect(planApproveMode(useStore.getState().state, useStore.getState().autoModeUnavailable)).toBe("auto");
    const answered = useStore.getState().approvePlan("auto");
    await flush(); // the refusal is in, and its settle() waits for the engine's next snapshot
    const s2 = useStore.getState().state;
    useStore.getState().handleEvent({ type: "state", state: { ...s2, seq: s2.seq + 1 } }); // ends the refusal's settle()
    await answered;
    expect(useStore.getState().autoModeUnavailable).toBe(true);
    expect(planApproveMode(useStore.getState().state, useStore.getState().autoModeUnavailable)).toBe("default");
  });
});

beforeAll(() => initI18n("en", "darwin"));
afterAll(() => initI18n("en", "darwin"));
