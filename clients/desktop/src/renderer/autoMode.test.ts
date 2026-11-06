import { describe, expect, it } from "vitest";
import type { ReviewState } from "@reviewgate/engine";
import { autoModeErrorText, autoModeHelp, busyModeHelp, dueScheduledMode, isAutoModeRow, pickMode, scheduledModeHelp } from "./autoMode";
import { presentationOf } from "./errorCodes";
import { modeSwitchesNow } from "./storeAutoMode";

// MARK: wave4b w4b-auto — docs/PROTOCOL.md §39.5 in Electron, as on the Mac (AutoModeTests.swift): what auto mode blocked
// is a gray row naming the call and the reason; a mode picked while Claude works applies from its next step (plan mode
// waits for the turn's end).

describe("auto mode words (§39.5)", () => {
  it("a blocked call names the call and the reason; without either the row still says what happened", () => {
    expect(autoModeErrorText({ code: "auto_mode_denied", message: "x", detail: "mvn -v — [Security Weaken]" })).toBe("Auto mode blocked: mvn -v — [Security Weaken]");
    expect(autoModeErrorText({ code: "auto_mode_denied", message: "x", detail: "  " })).toBe("Auto mode blocked a call");
    expect(autoModeErrorText({ code: "auto_mode_unavailable", message: "x" })).toBe("Auto mode is not available for this model (or is turned off), so Claude Code asks before commands");
    expect(autoModeErrorText({ code: "hook_blocked", message: "x" })).toBeNull();
    expect(autoModeHelp()).toBe("Commands run on Claude Code's own judgment. File changes are still reviewed.");
  });

  it("both codes are gray rows only — no banner", () => {
    for (const code of ["auto_mode_denied", "auto_mode_unavailable"]) {
      expect(isAutoModeRow(code)).toBe(true);
      expect(presentationOf(code)).toBe("row");
    }
    expect(isAutoModeRow(undefined)).toBe(false);
    expect(isAutoModeRow("tool_call_limit")).toBe(false);
  });
});

describe("picking a mode (§39.5)", () => {
  const idle = { open: true, busy: false, current: "default" as const };
  const busy = { ...idle, busy: true };

  it("idle: switches now; the mode already running sends nothing", () => {
    expect(pickMode("auto", idle)).toEqual({ send: "auto", scheduled: null });
    expect(pickMode("default", idle)).toEqual({ send: null, scheduled: null });
  });

  it("while Claude works: the pick waits for the turn to end; picking the running mode drops the wait", () => {
    expect(pickMode("auto", busy)).toEqual({ send: null, scheduled: "auto" });
    expect(pickMode("default", busy)).toEqual({ send: null, scheduled: null });
  });

  it("no open session: nothing", () => {
    expect(pickMode("auto", { ...idle, open: false })).toEqual({ send: null, scheduled: null });
  });

  it("while a turn runs the engine takes default / acceptEdits / auto at once; plan (into or out of it), a start or a collection waits", () => {
    const state = (phase: string, starting = false) => ({ session: { starting }, gate: { phase } }) as unknown as ReviewState;
    expect(modeSwitchesNow(state("idle"), "plan", "default")).toBe(true);
    expect(modeSwitchesNow(state("running"), "auto", "default")).toBe(true);
    expect(modeSwitchesNow(state("running"), "acceptEdits", "auto")).toBe(true);
    expect(modeSwitchesNow(state("running"), "plan", "default")).toBe(false);
    expect(modeSwitchesNow(state("running"), "auto", "plan")).toBe(false);
    expect(modeSwitchesNow(state("collecting"), "auto", "default")).toBe(false);
    expect(modeSwitchesNow(state("reverting"), "auto", "default")).toBe(false);
    expect(modeSwitchesNow(state("starting"), "auto", "default")).toBe(false);
    expect(modeSwitchesNow(state("idle", true), "auto", "default")).toBe(false);
    expect(busyModeHelp(true)).toBe("Claude is working — a new mode applies from its next step (plan mode: when this turn ends)");
    expect(busyModeHelp(false)).toBe(scheduledModeHelp());
  });

  it("after a snapshot: the waiting mode goes out once idle, waits while busy, is dropped for a closed session or another project", () => {
    const s = { open: true, busy: false, current: "default" as const, projectChanged: false };
    expect(dueScheduledMode(null, s)).toEqual({ send: null, keep: false });
    expect(dueScheduledMode("auto", { ...s, busy: true })).toEqual({ send: null, keep: true });
    expect(dueScheduledMode("auto", s)).toEqual({ send: "auto", keep: false });
    expect(dueScheduledMode("auto", { ...s, current: "auto" })).toEqual({ send: null, keep: false });
    expect(dueScheduledMode("auto", { ...s, open: false })).toEqual({ send: null, keep: false });
    expect(dueScheduledMode("auto", { ...s, projectChanged: true })).toEqual({ send: null, keep: false });
  });
});
