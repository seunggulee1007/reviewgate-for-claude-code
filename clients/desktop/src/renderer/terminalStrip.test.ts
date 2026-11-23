/** §57.5 / plan §4.2: the strip over a terminal chat, "Review now", the overlays and the start refusals. */
import { afterAll, describe, expect, it } from "vitest";
import type { TerminalSessionState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import {
  countsReviewedHint,
  ESCAPE_GRACE_MS,
  escapeMark,
  isEscapeKey,
  readReviewedHint,
  REVIEW_NOW_IDLE_MS,
  REVIEWED_HINT_COUNT_KEY,
  showsReviewedHint,
  showsReviewNow,
  stripStatus,
  terminalActivityKey,
  terminalOverlay,
  terminalStartRefusal,
  writeReviewedHint,
} from "./terminalStrip";

const term = (over: Partial<TerminalSessionState> = {}): TerminalSessionState => ({
  running: true,
  hooksSeen: false,
  promptId: null,
  waiting: null,
  interruptSuspected: false,
  ...over,
});

describe("the strip", () => {
  afterAll(() => initI18n("en", "darwin"));

  it("before the first hook: the trust hint, in the accent colour", () => {
    const s = stripStatus({ disconnected: false, info: term(), working: false });
    expect(s.kind).toBe("trust");
    expect(s.tone).toBe("accent");
    expect(s.text).toBe("If Claude Code asks whether to trust this folder, choose Yes");
    expect(s.short).toBe("Trust this folder? Choose Yes");
    expect(s.help).toContain('"Yes, I trust this folder"');
  });

  it("hooks arriving: reviewed; a turn: working", () => {
    expect(stripStatus({ disconnected: false, info: term({ hooksSeen: true }), working: false }).kind).toBe("reviewed");
    const working = stripStatus({ disconnected: false, info: term({ hooksSeen: true }), working: true });
    expect(working.kind).toBe("working");
    expect(working.text).toBe("Claude is working — the review opens when it stops");
  });

  it("a wait in the TUI says which and carries its message", () => {
    const since = "2026-11-20T00:00:00Z";
    const p = stripStatus({ disconnected: false, info: term({ waiting: { kind: "permission", message: "Bash: rm -rf build", since } }), working: true });
    expect(p.text).toBe("Claude Code waits for your permission in the terminal");
    expect(p.help).toBe("Bash: rm -rf build");
    expect(p.tone).toBe("orange");
    const q = stripStatus({ disconnected: false, info: term({ waiting: { kind: "question", message: "Which one?", since } }), working: true });
    expect(q.text).toBe("Claude Code asked you a question in the terminal");
  });

  it("disconnected wins over everything", () => {
    const s = stripStatus({ disconnected: true, info: term({ waiting: { kind: "permission", message: "x", since: "" } }), working: true });
    expect(s.kind).toBe("disconnected");
    expect(s.tone).toBe("orange");
  });

  it("speaks Korean", () => {
    initI18n("ko", "win32");
    expect(stripStatus({ disconnected: false, info: term(), working: false }).text).toMatch(/[가-힣]/);
    expect(stripStatus({ disconnected: true, info: null, working: false }).text).toMatch(/[가-힣]/);
    initI18n("en", "darwin");
  });
});

describe("Review now", () => {
  const base = { working: true, info: term(), lastActivityMs: 0, nowMs: 1000 };
  it("after Esc (interruptSuspected) at once", () => {
    expect(showsReviewNow({ ...base, info: term({ interruptSuspected: true }) })).toBe(true);
  });
  it("after 60 s without a change in the live terminal chat", () => {
    expect(showsReviewNow({ ...base, nowMs: REVIEW_NOW_IDLE_MS - 1 })).toBe(false);
    expect(showsReviewNow({ ...base, nowMs: REVIEW_NOW_IDLE_MS })).toBe(true);
  });
  it("never without a running turn in a running terminal", () => {
    expect(showsReviewNow({ ...base, working: false, info: term({ interruptSuspected: true }) })).toBe(false);
    expect(showsReviewNow({ ...base, info: term({ running: false, interruptSuspected: true }) })).toBe(false);
    expect(showsReviewNow({ ...base, info: null, nowMs: 10 * REVIEW_NOW_IDLE_MS })).toBe(false);
  });
  it("2 s after an Esc the window saw while the turn ran, unless a hook came since (§57.4)", () => {
    const info = term({ hookCount: 4 });
    const escape = escapeMark({ working: true, info, nowMs: 1000 });
    expect(escape).toEqual({ atMs: 1000, hookCount: 4 });
    expect(showsReviewNow({ ...base, info, escape, nowMs: 1000 + ESCAPE_GRACE_MS - 1 })).toBe(false);
    expect(showsReviewNow({ ...base, info, escape, nowMs: 1000 + ESCAPE_GRACE_MS })).toBe(true);
    // A hook followed (Claude Code went on: the Esc closed a menu).
    expect(showsReviewNow({ ...base, info: term({ hookCount: 5 }), escape, nowMs: 10_000 })).toBe(false);
    // Between turns, or with the terminal not running, an Esc is nothing.
    expect(escapeMark({ working: false, info, nowMs: 1000 })).toBeNull();
    expect(escapeMark({ working: true, info: term({ running: false }), nowMs: 1000 })).toBeNull();
    expect(showsReviewNow({ ...base, working: false, info, escape, nowMs: 10_000 })).toBe(false);
  });
  it("the Esc key: a lone ESC or its kitty form — not a paste, an arrow, Alt+key or a release", () => {
    for (const k of ["\x1b", "\x1b[27u", "\x1b[27;1u", "\x1b[27;1:1u"]) expect(isEscapeKey(k)).toBe(true);
    for (const k of ["\x1b[200~hi\x1b[201~", "\x1b[A", "\x1b\r", "\x1b[27;1:3u", "\x1b[27;5u", "\x1b\x1b", "a", ""]) expect(isEscapeKey(k)).toBe(false);
  });
  it("activity: the state's seq, the gate's phase, the terminal state", () => {
    const s = { seq: 4, gate: { phase: "running" }, session: { terminal: term() } };
    expect(terminalActivityKey(s)).toBe(terminalActivityKey({ ...s }));
    expect(terminalActivityKey({ ...s, seq: 5 })).not.toBe(terminalActivityKey(s));
    expect(terminalActivityKey({ ...s, gate: { phase: "collecting" } })).not.toBe(terminalActivityKey(s));
    expect(terminalActivityKey({ ...s, session: { terminal: term({ hooksSeen: true }) } })).not.toBe(terminalActivityKey(s));
  });
});

describe("the overlay over the terminal", () => {
  it("exited with its code; the trust hint after a quick exit without hooks", () => {
    expect(terminalOverlay({ exit: { exitCode: 1, quickNoHooks: false }, failed: null, disconnected: false })).toEqual({ kind: "exited", title: "Claude Code exited (1)", hint: null });
    const quick = terminalOverlay({ exit: { exitCode: 0, quickNoHooks: true }, failed: null, disconnected: false });
    expect(quick?.hint).toBe("If it asked whether to trust this folder, choose Yes after restarting — ReviewGate cannot review a folder Claude Code does not trust");
  });
  it("stopped without a code (killed)", () => {
    expect(terminalOverlay({ exit: { exitCode: null, quickNoHooks: false }, failed: null, disconnected: false })?.title).toBe("Claude Code was stopped");
  });
  it("a start that failed, then a disconnect", () => {
    expect(terminalOverlay({ exit: null, failed: "nope", disconnected: true })).toEqual({ kind: "failed", title: "nope", hint: null });
    expect(terminalOverlay({ exit: null, failed: null, disconnected: true })?.kind).toBe("disconnected");
    expect(terminalOverlay({ exit: null, failed: null, disconnected: false })).toBeNull();
  });
});

describe("why Claude Code could not start", () => {
  it("main's PTY codes and the engine's refusals in words", () => {
    expect(terminalStartRefusal("terminal_needs_native_claude")).toBe("Terminal chat needs the native Claude Code (claude.exe) or Node on PATH");
    expect(terminalStartRefusal("pty_unavailable", "Terminal chat needs Windows 10 1903 or later")).toBe("Terminals are not available here: Terminal chat needs Windows 10 1903 or later");
    expect(terminalStartRefusal("spawn_failed", "")).toBe("Claude Code could not be started in the terminal");
    expect(terminalStartRefusal("terminal_cli_too_old")).toContain("2.1.295");
    expect(terminalStartRefusal("not_current")).toBe(terminalStartRefusal("terminal_not_current"));
    expect(terminalStartRefusal("something_else")).toBeNull();
  });
  it("each in Korean", () => {
    initI18n("ko", "win32");
    for (const code of ["pty_unavailable", "terminal_needs_native_claude", "terminal_cmdline_too_long", "spawn_failed", "not_current", "terminal_unsupported", "terminal_cli_too_old", "terminal_hooks_disabled", "terminal_chat", "no_turn"]) {
      expect(terminalStartRefusal(code, "x")).toMatch(/[가-힣]/);
    }
    initI18n("en", "darwin");
  });
});

describe("the reviewed hint, the first few times", () => {
  it("shows in the first three chats, keeps the third while on screen, never once closed", () => {
    expect(showsReviewedHint(0, false, false)).toBe(true);
    expect(countsReviewedHint(0, false, false)).toBe(true);
    expect(countsReviewedHint(1, false, true)).toBe(false);
    expect(showsReviewedHint(3, false, true)).toBe(true);
    expect(showsReviewedHint(3, false, false)).toBe(false);
    expect(countsReviewedHint(3, false, false)).toBe(false);
    expect(showsReviewedHint(1, true, true)).toBe(false);
  });

  it("persists the count and the dismissal; blocked storage reads as never shown", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    expect(readReviewedHint(storage)).toEqual({ count: 0, dismissed: false });
    writeReviewedHint({ count: 2 }, storage);
    writeReviewedHint({ dismissed: true }, storage);
    expect(readReviewedHint(storage)).toEqual({ count: 2, dismissed: true });
    map.set(REVIEWED_HINT_COUNT_KEY, "x");
    expect(readReviewedHint(storage).count).toBe(0);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readReviewedHint(blocked)).toEqual({ count: 0, dismissed: false });
    expect(() => writeReviewedHint({ count: 1 }, blocked)).not.toThrow();
  });
});
