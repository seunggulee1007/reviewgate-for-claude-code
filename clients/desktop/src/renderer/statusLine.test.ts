/**
 * MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the status line on Electron — the store (a reply and the engine's
 * own events, replies reaching the window twice), what is shown, the width in columns, how a run looks, and the view
 * as it renders (react-dom/server, the window mocked as in the other store tests). Decoding checks the engine's wire
 * golden (engine/test/fixtures/wire/wave6.statusline.json) the Mac's StatusLineTests read too.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineEvent, StatusLineEvent } from "@reviewgate/engine";
import type { AnsiRun } from "./ansi";

type Golden = { reply: StatusLineEvent; update: StatusLineEvent; failed: StatusLineEvent; off: StatusLineEvent };
const golden = JSON.parse(readFileSync(new URL("../../../../engine/test/fixtures/wire/wave6.statusline.json", import.meta.url), "utf8")) as Golden;

type Mod = typeof import("./statusLine");
let mod: Mod;
let View: FunctionComponent<{ lines: AnsiRun[][]; padding: number; columns: number; dark: boolean; failure?: string | null }>;
const opened: string[] = [];

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true, visibilityState: "visible" };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }),
      setSettings: async () => ({}),
      notify: async () => true,
      onEvent: () => () => undefined,
      openExternal: async (url: string) => void opened.push(url),
      platform: "win32",
    },
  };
  mod = await import("./statusLine");
  View = (await import("./components/chat/StatusLine")).StatusLineView;
});

type Bridge = Parameters<ReturnType<Mod["useStatusLine"]["getState"]>["tell"]>[2];
const bridge = (reply: () => StatusLineEvent | Error, sent: unknown[]): Bridge => ({
  request: async () => ({}) as never,
  requestDetailed: async (cmd: unknown) => {
    sent.push(cmd);
    const r = reply();
    return r instanceof Error ? { ok: false as const, error: r.message, code: "unknown_command" } : { ok: true as const, reply: r as never };
  },
});

describe("status line store (§44.2)", () => {
  it("applies replies and events alike, parses the lines once, shows them only while on and configured", () => {
    const s = mod.useStatusLine.getState();
    s.reset();
    expect(mod.applyStatusLineEvent(golden.update as EngineEvent)).toBe(true);
    expect(mod.applyStatusLineEvent({ type: "log", level: "info", message: "x" } as EngineEvent)).toBe(false);
    const first = mod.useStatusLine.getState().runs;
    expect(first).toHaveLength(2);
    expect(first[0]![0]).toEqual({ text: "Opus 5.5", bold: true });
    expect(first[1]![0]).toEqual({ text: "PR #1", link: "https://example.com/pr/1" });
    mod.applyStatusLineEvent({ ...golden.update, id: "dup" } as EngineEvent); // the same reply again, with its id
    expect(mod.useStatusLine.getState().runs).toBe(first);
    expect(mod.shownRuns(mod.useStatusLine.getState())).toHaveLength(2);
    mod.applyStatusLineEvent(golden.failed as EngineEvent);
    expect(mod.useStatusLine.getState().reply?.error).toEqual({ code: "exit", message: "statusline: jq not found", at: "2023-11-14T22:13:20.000Z", exitCode: 127 });
    expect(mod.shownRuns(mod.useStatusLine.getState())).toHaveLength(2); // the last good lines stay
    mod.applyStatusLineEvent(golden.off as EngineEvent);
    expect(mod.shownRuns(mod.useStatusLine.getState())).toEqual([]);
    mod.applyStatusLineEvent({ ...golden.update, configured: false } as EngineEvent);
    expect(mod.shownRuns(mod.useStatusLine.getState())).toEqual([]);
  });

  it("tells the engine a width and visibility once each; an older engine is asked once", async () => {
    const s = mod.useStatusLine.getState();
    s.reset();
    const sent: unknown[] = [];
    await s.tell(100, true, bridge(() => golden.reply, sent));
    await s.tell(100, true, bridge(() => golden.reply, sent));
    await s.tell(90, true, bridge(() => golden.reply, sent));
    await s.tell(90, false, bridge(() => golden.reply, sent));
    expect(sent).toEqual([
      { type: "status_line", columns: 100, visible: true },
      { type: "status_line", columns: 90, visible: true },
      { type: "status_line", columns: 90, visible: false },
    ]);
    expect(mod.useStatusLine.getState().reply?.command).toBe("~/.claude/statusline.sh");
    mod.useStatusLine.getState().reset();
    await mod.useStatusLine.getState().tell(80, true, bridge(() => new Error("unknown command: status_line"), sent));
    expect(mod.useStatusLine.getState().unsupported).toBe(true);
    await mod.useStatusLine.getState().tell(70, true, bridge(() => golden.reply, sent));
    expect(sent).toHaveLength(4);
    mod.useStatusLine.setState({ unsupported: false });
  });

  it("a remount for the same project keeps the lines; another project's go", () => {
    const s = mod.useStatusLine.getState();
    s.setRoot("/w/a");
    mod.applyStatusLineEvent(golden.update as EngineEvent);
    mod.useStatusLine.getState().setRoot("/w/a");
    expect(mod.useStatusLine.getState().runs).toHaveLength(2);
    mod.useStatusLine.getState().setRoot("/w/b");
    expect(mod.useStatusLine.getState()).toMatchObject({ root: "/w/b", reply: null, runs: [], told: null });
  });

  it("a project's own statusLine is allowed per project by its command; a changed command asks again", () => {
    const sha = "a".repeat(64);
    const project = { path: "/w/a/.claude/settings.json", command: "./sl.sh", sha256: sha, allowed: false };
    expect(mod.projectStatusLineChoice(undefined, "/w/a", project)).toEqual({ allowed: false, changed: false });
    const allowed = mod.withProjectStatusLine(undefined, "/w/a", sha);
    expect(mod.projectStatusLineChoice(allowed, "/w/a", project)).toEqual({ allowed: true, changed: false });
    expect(mod.projectStatusLineChoice(allowed, "/w/b", project)).toEqual({ allowed: false, changed: false }); // another project
    expect(mod.projectStatusLineChoice(allowed, "/w/a", { ...project, command: "./sl.sh --upload", sha256: "b".repeat(64) })).toEqual({ allowed: false, changed: true });
    expect(mod.projectStatusLineChoice(allowed, "/w/a", undefined)).toEqual({ allowed: false, changed: false });
    expect(mod.withProjectStatusLine(allowed, "/w/a", "")).toEqual({});
    expect(Object.keys(mod.withProjectStatusLine(allowed, "/w/b", sha))).toHaveLength(2);
  });

  it("columns from the box and the font's 0; never under 20", () => {
    expect(mod.columnsFor(700, 7)).toBe(100);
    expect(mod.columnsFor(705.5, 7)).toBe(100);
    expect(mod.columnsFor(50, 7)).toBe(20);
    expect(mod.columnsFor(0, 7)).toBe(0);
    expect(mod.columnsFor(700, 0)).toBe(0);
  });

  it("a run's look: palette colors per appearance, the dim gray for plain text, inverse, dim, hidden, styles", () => {
    expect(mod.runCss({ text: "x" }, true)).toEqual({});
    expect(mod.runCss({ text: "x", fg: 1, bold: true }, true)).toEqual({ color: "#cd3131", fontWeight: "700" });
    expect(mod.runCss({ text: "x", fg: 2 }, false)).toEqual({ color: "#00bc00" });
    expect(mod.runCss({ text: "x", fg: 214, bg: "#102030", italic: true, underline: true, strike: true }, true)).toEqual({
      color: "#ffaf00", backgroundColor: "#102030", fontStyle: "italic", textDecoration: "underline line-through",
    });
    expect(mod.runCss({ text: "x", inverse: true }, true)).toEqual({ color: "var(--bg)", backgroundColor: "var(--sl-fg)" });
    expect(mod.runCss({ text: "x", dim: true }, true)).toEqual({ color: "color-mix(in srgb, var(--sl-fg) 55%, transparent)" });
    expect(mod.runCss({ text: "x", fg: 1, hidden: true }, true)).toEqual({ color: "transparent" });
  });
});

describe("status line view (§44.2)", () => {
  it("draws each line's runs, http(s) links as anchors, cut with … at the columns, padded by statusLine.padding", () => {
    const lines = [[{ text: "Opus 5.5", bold: true as const }, { text: " ctx:7%", fg: 2 }], [{ text: "PR #1", link: "https://example.com/pr/1" }, { text: " here", link: "file:///tmp" }]];
    const html = renderToStaticMarkup(createElement(View, { lines, padding: 1, columns: 14, dark: true }));
    expect(html).toContain('class="status-line"');
    expect(html).toContain('<div class="sl-lines" style="padding-left:1ch;padding-right:1ch">');
    // 14 columns less 1 + 1 of padding: 12 — "Opus 5.5 ctx:7%" (15) keeps 11 and ends with an unstyled "…".
    expect(html).toContain('<span style="font-weight:700">Opus 5.5</span><span style="color:#0dbc79"> ct</span><span>…</span>');
    expect(html).toContain('<a href="https://example.com/pr/1" title="https://example.com/pr/1">PR #1</a><span> here</span>');
    expect(html).not.toContain("file:///tmp");
  });

  it("nothing to show: an empty, zero-height box that still measures; a failure's tooltip says why", () => {
    const empty = renderToStaticMarkup(createElement(View, { lines: [], padding: 0, columns: 0, dark: true }));
    expect(empty).toContain('class="status-line sl-empty"'); // never the app's global `.empty` (a full-height empty state)
    expect(empty).not.toContain("sl-line");
    const failed = renderToStaticMarkup(createElement(View, { lines: [[{ text: "x" }]], padding: 0, columns: 80, dark: false, failure: "statusline: jq not found" }));
    expect(failed).toContain('title="The status line command failed: statusline: jq not found. Showing its last output."');
  });
});
