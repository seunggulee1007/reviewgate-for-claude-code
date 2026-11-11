// MARK: wave7 w7-state — docs/PROTOCOL.md §45.2: snapshots follow what changed. The HUD's churn (the activity line, a
// subagent's step, the usage windows) goes out at most once per window, the same activity or agent list again sends
// nothing, a prompt or the turn's end goes out at once (and carries the churn that waited), text deltas never wait,
// and the disk reading is sent on a real change only.
import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { STATE_CHURN_GAP_MS } from "../src/engine.js";
import type { DiskSpace, EngineEvent, RateLimitWindow, ReviewState } from "../src/protocol.js";
import { diskChanged } from "../src/review/storage.js";
import { rateLimitChanges, rateLimitWindowsOf } from "../src/session/longWork.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir } from "./helpers/repo.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Longer than the churn window: what waited has gone out, the next churn goes out at once. */
const quiet = async (h: Harness) => {
  await sleep(STATE_CHURN_GAP_MS + 40);
  await h.settle(); // a churn timer that expired with this sleep sends its snapshot from a setImmediate
};

/** A running turn, quiet for longer than the churn window. */
async function running(): Promise<Harness> {
  const dir = realpathSync(makeRepo());
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  await h.engine.handle({ type: "send", text: "go" });
  await h.settle();
  // Background snapshots (disk reading, branches) may still land on a slow runner: count from when none has for 300 ms.
  const deadline = Date.now() + 10_000;
  for (let n = -1; n !== h.states.length && Date.now() < deadline; ) {
    n = h.states.length;
    await sleep(300);
  }
  await quiet(h);
  return h;
}

function indexOfState(events: EngineEvent[], state: ReviewState): number {
  return events.findIndex((e) => e.type === "state" && e.state === state);
}

describe("wave7 §45.2: state snapshots follow what changed", () => {
  it("the same activity again sends no snapshot (the event still goes out); a new one does", async () => {
    const h = await running();
    const s = h.session();
    const before = h.states.length;
    s.emit({ type: "activity", kind: "tool_start", toolName: "Read", detail: "a.ts" });
    await h.settle();
    expect(h.states.length).toBe(before + 1);
    expect(h.states.at(-1)!.hud.activity).toEqual({ kind: "tool", toolName: "Read", detail: "a.ts" });
    await quiet(h);
    // The assistant message repeats the tool_start the stream already announced.
    s.emit({ type: "activity", kind: "tool_start", toolName: "Read", detail: "a.ts" });
    await h.settle();
    await quiet(h);
    expect(h.states.length).toBe(before + 1);
    expect(h.ofType("activity").length).toBe(2);
    s.emit({ type: "activity", kind: "tool_end", toolName: "Read" });
    await h.settle();
    expect(h.states.length).toBe(before + 2);
    expect(h.states.at(-1)!.hud.activity).toEqual({ kind: "working" });
  });

  it("an idle activity twice: one snapshot (the agent fields did not change either)", async () => {
    const h = await running();
    const s = h.session();
    const before = h.states.length;
    s.emit({ type: "activity", kind: "idle" });
    await h.settle();
    await quiet(h);
    expect(h.states.length).toBe(before + 1);
    s.emit({ type: "activity", kind: "idle" });
    await h.settle();
    await quiet(h);
    expect(h.states.length).toBe(before + 1);
    expect(h.engine.state.hud.activity).toEqual({ kind: "idle" });
  });

  it("HUD churn inside the window: the first at once, the rest in one trailing snapshot with the last activity", async () => {
    const h = await running();
    const s = h.session();
    const before = h.states.length;
    const started = Date.now();
    const tools = ["Read", "Grep", "Glob", "Edit", "Bash"];
    for (const [i, tool] of tools.entries()) {
      s.emit({ type: "activity", kind: "tool_start", toolName: tool, detail: `d${i}` });
      await h.settle();
    }
    const elapsed = Date.now() - started;
    const burst = h.states.length - before;
    expect(burst).toBeGreaterThanOrEqual(1);
    expect(burst).toBeLessThanOrEqual(1 + Math.floor(elapsed / STATE_CHURN_GAP_MS));
    await quiet(h);
    expect(h.states.length).toBeLessThanOrEqual(before + 2 + Math.floor(elapsed / STATE_CHURN_GAP_MS));
    expect(h.states.at(-1)!.hud.activity).toEqual({ kind: "tool", toolName: "Bash", detail: "d4" });
    const seqs = h.states.map((x) => x.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("subagent steps are churn too: many steps, few snapshots, the last step shown", async () => {
    const h = await running();
    const s = h.session();
    s.emit({ type: "tool_use", id: "ag1", name: "Agent", input: { description: "look around", prompt: "p" } });
    await h.settle();
    await quiet(h);
    const before = h.states.length;
    const started = Date.now();
    for (let i = 0; i < 8; i++) {
      s.emit({ type: "tool_use", id: `r${i}`, name: "Read", input: { file_path: `/x/f${i}.ts` }, parentToolUseId: "ag1" });
      await h.settle();
    }
    const elapsed = Date.now() - started;
    expect(h.states.length - before).toBeLessThanOrEqual(1 + Math.floor(elapsed / STATE_CHURN_GAP_MS));
    await quiet(h);
    const agent = h.states.at(-1)!.hud.agents.find((a) => a.toolUseId === "ag1");
    expect(agent?.lastTool).toBe("Read");
    expect(h.engine.state.hud.agents.find((a) => a.toolUseId === "ag1")).toEqual(agent);
  });

  it("a permission request goes out at once, after its event, and carries the churn that waited", async () => {
    const h = await running();
    const s = h.session();
    s.emit({ type: "activity", kind: "tool_start", toolName: "Read", detail: "a" });
    await h.settle(); // at once
    s.emit({ type: "activity", kind: "tool_start", toolName: "Bash", detail: "ls" }); // waits for the window
    await h.settle();
    const before = h.states.length;
    s.emit({ type: "permission_request", requestId: "p1", toolName: "Bash", input: { command: "ls" } });
    await h.settle();
    expect(h.states.length).toBe(before + 1);
    const last = h.states.at(-1)!;
    expect(last.session.pendingPermission?.requestId).toBe("p1");
    expect(last.hud.activity).toEqual({ kind: "tool", toolName: "Bash", detail: "ls" });
    expect(h.events.findIndex((e) => e.type === "permission_request")).toBeLessThan(indexOfState(h.events, last));
    await quiet(h);
    expect(h.states.length).toBe(before + 1); // nothing was left to send
  });

  it("the turn's end goes out at once, even inside the churn window", async () => {
    const h = await running();
    const s = h.session();
    s.emit({ type: "activity", kind: "tool_start", toolName: "Read", detail: "a" });
    await h.settle();
    s.emit({ type: "activity", kind: "tool_start", toolName: "Grep", detail: "b" }); // waits
    const before = h.states.length;
    s.emitTurnEnd();
    await h.settle(); // the macrotask after it, not the end of the window
    expect(h.states.length).toBeGreaterThan(before);
    expect(h.states.at(-1)!.gate.phase).not.toBe("running");
    await h.waitFor((x) => x.gate.phase !== "collecting", "collected");
    const ended = h.events.findIndex((e) => e.type === "turn_end");
    expect(ended).toBeGreaterThan(-1);
    expect(h.events.slice(ended).some((e) => e.type === "state" && e.state.gate.phase !== "collecting")).toBe(true);
  });

  it("an error goes out at once with its snapshot", async () => {
    const h = await running();
    const s = h.session();
    s.emit({ type: "activity", kind: "tool_start", toolName: "Read", detail: "a" });
    await h.settle();
    s.emit({ type: "activity", kind: "tool_start", toolName: "Grep", detail: "b" }); // waits
    const before = h.states.length;
    s.emit({ type: "error", message: "boom", fatal: false });
    await h.settle();
    expect(h.ofType("error").at(-1)).toMatchObject({ message: "boom" });
    expect(h.states.length).toBe(before + 1);
    expect(h.states.at(-1)!.lastError).toBe("boom");
  });

  it("text deltas go out at once and send no snapshot", async () => {
    const h = await running();
    const s = h.session();
    const before = h.states.length;
    s.emit({ type: "text_delta", text: "Hel" });
    expect(h.events.at(-1)).toMatchObject({ type: "text_delta", text: "Hel" });
    s.emit({ type: "text_delta", text: "lo" });
    expect(h.events.at(-1)).toMatchObject({ type: "text_delta", text: "lo" });
    await h.settle();
    await quiet(h);
    expect(h.states.length).toBe(before);
  });

  it("the same usage windows again send no snapshot — received later (another `at`), the other kind first", async () => {
    const h = await running();
    const s = h.session();
    // What claude.ts makes of the CLI's rate_limit_event (2099 resets: none passes during the test).
    const info = (five: number) => ({
      status: "allowed",
      rateLimitType: "five_hour",
      resetsAt: 4_070_908_800,
      unifiedWindows: { five_hour: { utilization: five, resetsAt: 4_070_908_800 }, seven_day: { utilization: 0.1, resetsAt: 4_071_513_600 } },
    });
    const send = (windows: RateLimitWindow[]) => {
      for (const window of windows) s.emit({ type: "rate_limit_info", window });
    };
    const before = h.states.length;
    send(rateLimitWindowsOf(info(0.4), Date.now()));
    await h.settle();
    await quiet(h);
    const after = h.states.length;
    expect(after).toBeGreaterThan(before);
    expect(h.states.at(-1)!.hud.rateLimits!.map((w) => [w.kind, w.percent])).toEqual([["five_hour", 40], ["seven_day", 10]]);
    await sleep(5);
    send(rateLimitWindowsOf(info(0.4), Date.now()).reverse());
    await h.settle();
    await quiet(h);
    expect(h.states.length).toBe(after);
    send(rateLimitWindowsOf(info(0.45), Date.now()));
    await h.settle();
    await quiet(h);
    expect(h.states.length).toBe(after + 1);
    expect(h.states.at(-1)!.hud.rateLimits!.find((w) => w.kind === "five_hour")?.percent).toBe(45);
  });

  it("a usage window changes the list when a client would see it: its kind, status, use or reset, or another kind's reset passed", () => {
    const NOW = Date.parse("2026-10-27T00:00:00.000Z");
    const five: RateLimitWindow = { kind: "five_hour", status: "allowed", percent: 40, utilization: 0.4, resetsAt: "2026-10-27T03:00:00.000Z", at: "2026-10-27T00:00:00.000Z" };
    const week: RateLimitWindow = { kind: "seven_day", status: "allowed", percent: 10, utilization: 0.1, resetsAt: "2026-11-01T00:00:00.000Z", at: "2026-10-27T00:00:00.000Z" };
    const later = "2026-10-27T00:05:00.000Z";
    expect(rateLimitChanges([five, week], { ...five, at: later }, NOW)).toBe(false);
    expect(rateLimitChanges([five, week], { ...week, at: later }, NOW)).toBe(false);
    expect(rateLimitChanges([five, week], { ...five, percent: 41, utilization: 0.41 }, NOW)).toBe(true);
    expect(rateLimitChanges([five, week], { ...five, status: "allowed_warning" }, NOW)).toBe(true);
    expect(rateLimitChanges([five, week], { ...five, resetsAt: "2026-10-27T04:00:00.000Z" }, NOW)).toBe(true);
    const { percent: _percent, utilization: _utilization, ...bare } = five;
    expect(rateLimitChanges([five], bare, NOW)).toBe(true);
    expect(rateLimitChanges([five], week, NOW)).toBe(true);
    expect(rateLimitChanges([], five, NOW)).toBe(true);
    expect(rateLimitChanges([five, week], { ...week, at: later }, Date.parse(five.resetsAt!))).toBe(true); // five_hour goes
  });

  it("the disk reading: a level change always, a quarter while ok, a tenth below it — not every 256 MB", () => {
    const GB = 1024 ** 3;
    const MB = 1024 ** 2;
    const d = (freeBytes: number, level: DiskSpace["level"]): DiskSpace => ({ freeBytes, totalBytes: 500 * GB, level, at: "2026-10-27T00:00:00.000Z" });
    expect(diskChanged(null, d(20 * GB, "ok"))).toBe(true);
    expect(diskChanged(d(20 * GB, "ok"), null)).toBe(true);
    expect(diskChanged(null, null)).toBe(false);
    expect(diskChanged(d(20 * GB, "ok"), d(20 * GB - 300 * MB, "ok"))).toBe(false); // swap grew: nothing to send
    expect(diskChanged(d(20 * GB, "ok"), d(16 * GB, "ok"))).toBe(false);
    expect(diskChanged(d(20 * GB, "ok"), d(15 * GB, "ok"))).toBe(true);
    expect(diskChanged(d(2.2 * GB, "ok"), d(1.9 * GB, "low"))).toBe(true);
    expect(diskChanged(d(1.8 * GB, "low"), d(1.7 * GB, "low"))).toBe(false);
    expect(diskChanged(d(1.8 * GB, "low"), d(1.6 * GB, "low"))).toBe(true);
    expect(diskChanged(d(0.8 * GB, "critical"), d(0.7 * GB, "critical"))).toBe(true);
    expect(diskChanged(d(0.8 * GB, "critical"), d(0.75 * GB, "critical"))).toBe(false);
    expect(diskChanged(d(1.1 * GB, "low"), d(0.9 * GB, "critical"))).toBe(true);
  });
});
