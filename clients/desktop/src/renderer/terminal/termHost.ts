/**
 * §57.17 (plan §4.1): the window's terminals — a registry by `ptyId`, independent of React. Each xterm.js `Terminal` is
 * opened ONCE into its own persistent `<div>`; whichever view shows it (the terminal chat column, a shell tab) re-parents
 * that div into its container, as VS Code does, so a chat switch, the PRs tab or a remount never disposes a terminal —
 * only `disposeTerminal` does (a closed shell tab, a chat PTY replaced by a restart).
 *
 * Bytes: `rg.pty.onData` → `term.write(chunk, ack)` — acked every 5,000 chars (main pauses the PTY above 100,000
 * unacked). Input: `term.onData` / `term.onBinary` → `rg.pty.input`, which also carries xterm's own replies to the DA1 /
 * DSR queries Claude Code sends. Keys go through `terminalKeys` (copy / paste / Shift+Enter / app keys / font size);
 * while a terminal has the keyboard main ignores the menu accelerators (`rg.pty.focus`).
 *
 * xterm and its addons are loaded on first use (a separate chunk; the tests never load them — `setTerminalLoader`).
 */
import type { ITerminalAddon, ITerminalOptions, Terminal } from "@xterm/xterm";
import type { PtyBridge, PtyExit, ShellKind } from "../../shared/ipc";
import { sanitizePaste } from "../terminalPaste";
import { ackStep, isOpenableLink, steppedFontSize, terminalOptions, terminalTheme, usesWebgl, type TermOptionsInput } from "./termHostOptions";
import { terminalKeyAction, xtermHandles } from "./terminalKeys";

/** What a view needs to know of a terminal. */
export type TerminalStatus = { running: boolean; exit: PtyExit | null };

/** The window-wide terminal configuration (Settings and the window's theme). */
export type TerminalConfig = { platform: string; osBuild: number | null; fontSize: number; gpu: "auto" | "off"; theme: "light" | "dark" };

/** xterm's pieces, loaded once. */
export type XtermModules = {
  createTerminal(options: ITerminalOptions): Terminal;
  fit(): ITerminalAddon & { fit(): void; proposeDimensions(): { cols: number; rows: number } | undefined };
  addons(term: Terminal, deps: { openLink(uri: string): void; copy(text: string): void }): void;
  webgl(): (ITerminalAddon & { onContextLoss(cb: () => void): { dispose(): void } }) | null;
  search(): ITerminalAddon & { findNext(q: string, o?: object): boolean; findPrevious(q: string, o?: object): boolean; clearDecorations(): void };
};

type Entry = {
  ptyId: string;
  kind: "chat" | "shell";
  sessionId?: string;
  /** A shell tab's shell. */
  shell?: ShellKind;
  /** The persistent element the terminal is opened in; views re-parent it. */
  host: HTMLDivElement;
  term: Terminal | null;
  fit: ReturnType<XtermModules["fit"]> | null;
  search: ReturnType<XtermModules["search"]> | null;
  webgl: ReturnType<XtermModules["webgl"]>;
  /** Output that arrived before xterm loaded (`acked`: main already got its ack — a replay, or bytes held before the PTY was adopted). */
  backlog: { data: string; acked: boolean }[];
  unacked: number;
  status: TerminalStatus;
  /** The view it shows in (null: parked). */
  container: HTMLElement | null;
  observer: ResizeObserver | null;
  fitTimer: ReturnType<typeof setTimeout> | null;
  /** After a reload: one resize nudge once the terminal is sized, so the TUI repaints. */
  nudge: boolean;
  lastSize: { cols: number; rows: number } | null;
  composing: boolean;
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
/** Output / exits for a ptyId the registry does not know yet (the open reply can come after its first bytes). */
const early = new Map<string, { data: string[]; size: number; exit: PtyExit | null }>();
const EARLY_LIMIT = 1 << 20;

let bridge: PtyBridge | null = null;
let deps: { openLink(uri: string): void; copy(text: string): void; onFontSize(size: number): void; log(line: string): void } = {
  openLink: () => undefined,
  copy: () => undefined,
  onFontSize: () => undefined,
  log: () => undefined,
};
let config: TerminalConfig = { platform: "win32", osBuild: null, fontSize: 13, gpu: "auto", theme: "dark" };
let webglFailed = false;
let loader: () => Promise<XtermModules> = loadXterm;
let modules: Promise<XtermModules> | null = null;
/** What main was last told (`rg.pty.focus`). */
let focusSent = false;

/** Tests: xterm replaced by fakes (and the registry emptied). */
export function setTerminalLoader(load: () => Promise<XtermModules>): void {
  loader = load;
  modules = null;
  for (const e of entries.values()) e.term?.dispose();
  entries.clear();
  early.clear();
  webglFailed = false;
  focusSent = false;
}

async function loadXterm(): Promise<XtermModules> {
  const [xterm, fit, unicode, links, clipboard, webgl, search] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-unicode11"),
    import("@xterm/addon-web-links"),
    import("@xterm/addon-clipboard"),
    import("@xterm/addon-webgl"),
    import("@xterm/addon-search"),
  ]);
  return {
    createTerminal: (options) => new xterm.Terminal(options),
    fit: () => new fit.FitAddon(),
    addons: (term, d) => {
      term.loadAddon(new unicode.Unicode11Addon());
      term.unicode.activeVersion = "11";
      // Plain URLs the program prints, and OSC 8 hyperlinks: http(s) only, in the browser.
      term.loadAddon(new links.WebLinksAddon((_e, uri) => d.openLink(uri)));
      term.options.linkHandler = { activate: (_e, uri) => d.openLink(uri), allowNonHttpProtocols: false };
      // OSC 52 (Claude Code copies a selection in fullscreen that way): write-only — a program never reads the clipboard.
      term.loadAddon(
        new clipboard.ClipboardAddon(undefined, {
          readText: () => "",
          writeText: (_sel, text) => d.copy(text),
        }),
      );
    },
    webgl: () => {
      try {
        return new webgl.WebglAddon();
      } catch {
        return null;
      }
    },
    search: () => new search.SearchAddon(),
  };
}

function notify(): void {
  for (const l of listeners) l();
}

/** Connects the registry to the bridge (once per window). */
export function initTermHost(b: PtyBridge, d: Partial<typeof deps> = {}): () => void {
  bridge = b;
  deps = { ...deps, ...d };
  const offData = b.onData((ptyId, data) => onOutput(ptyId, data));
  const offExit = b.onExit((e) => onExit(e));
  return () => {
    offData();
    offExit();
    bridge = null;
  };
}

function onOutput(ptyId: string, data: string): void {
  const e = entries.get(ptyId);
  if (!e) {
    const held = early.get(ptyId) ?? { data: [], size: 0, exit: null };
    if (held.size + data.length <= EARLY_LIMIT) {
      held.data.push(data);
      held.size += data.length;
    }
    early.set(ptyId, held);
    // Acked at once: nobody may ever claim these bytes, and a paused PTY would hang its program.
    bridge?.ack(ptyId, data.length);
    return;
  }
  write(e, data, false);
}

function write(e: Entry, data: string, acked: boolean): void {
  if (!e.term) {
    e.backlog.push({ data, acked });
    return;
  }
  e.term.write(data, () => {
    if (acked) return;
    const [ack, rest] = ackStep(e.unacked, data.length);
    e.unacked = rest;
    if (ack > 0) bridge?.ack(e.ptyId, ack);
  });
}

function onExit(ev: PtyExit): void {
  const e = entries.get(ev.ptyId);
  if (!e) {
    const held = early.get(ev.ptyId) ?? { data: [], size: 0, exit: null };
    held.exit = ev;
    early.set(ev.ptyId, held);
    return;
  }
  e.status = { running: false, exit: ev };
  notify();
}

/** Registers `ptyId` (a PTY main just opened or still runs) and starts its terminal. Idempotent. */
export function adoptTerminal(ptyId: string, kind: "chat" | "shell", opts: { sessionId?: string; shell?: ShellKind; replay?: string; status?: TerminalStatus } = {}): void {
  if (entries.has(ptyId)) return;
  const host = document.createElement("div");
  host.className = "term-host";
  const e: Entry = {
    ptyId,
    kind,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.shell ? { shell: opts.shell } : {}),
    host,
    term: null,
    fit: null,
    search: null,
    webgl: null,
    backlog: opts.replay ? [{ data: opts.replay, acked: true }] : [],
    unacked: 0,
    status: opts.status ?? { running: true, exit: null },
    container: null,
    observer: null,
    fitTimer: null,
    nudge: opts.replay !== undefined,
    lastSize: null,
    composing: false,
  };
  const held = early.get(ptyId);
  if (held) {
    early.delete(ptyId);
    e.backlog.push(...held.data.map((data) => ({ data, acked: true })));
    if (held.exit) e.status = { running: false, exit: held.exit };
  }
  entries.set(ptyId, e);
  notify();
  void start(e);
}

async function start(e: Entry): Promise<void> {
  modules ??= loader();
  let m: XtermModules;
  try {
    m = await modules;
  } catch (err) {
    deps.log(`[warn] xterm failed to load: ${String(err)}`);
    return;
  }
  if (entries.get(e.ptyId) !== e) return;
  const term = m.createTerminal(terminalOptions(optionsInput()));
  e.term = term;
  e.fit = m.fit();
  term.loadAddon(e.fit);
  m.addons(term, { openLink: (uri) => isOpenableLink(uri) && deps.openLink(uri), copy: (text) => deps.copy(text) });
  term.attachCustomKeyEventHandler((ev) => onKey(e, ev));
  term.onData((data) => bridge?.input(e.ptyId, data));
  term.onBinary((data) => bridge?.input(e.ptyId, data));
  term.open(e.host);
  watchFocus(e);
  loadWebgl(e, m);
  const backlog = e.backlog.splice(0);
  for (const chunk of backlog) write(e, chunk.data, chunk.acked);
  if (e.container) scheduleFit(e, 0);
  notify();
}

function optionsInput(): TermOptionsInput {
  return { platform: config.platform, osBuild: config.osBuild, fontSize: config.fontSize, theme: config.theme };
}

/** WebGL while the setting allows it; a failure (creation or a lost context) falls back to the DOM renderer for the window, logged once. */
function loadWebgl(e: Entry, m: XtermModules): void {
  if (!e.term || !usesWebgl(config.gpu, webglFailed)) return;
  const addon = m.webgl();
  if (!addon) return failWebgl("could not be created");
  try {
    e.term.loadAddon(addon);
  } catch (err) {
    addon.dispose();
    return failWebgl(String(err));
  }
  e.webgl = addon;
  addon.onContextLoss(() => {
    addon.dispose();
    if (e.webgl === addon) e.webgl = null;
    failWebgl("context lost");
  });
}

function failWebgl(why: string): void {
  if (!webglFailed) deps.log(`[info] terminal: WebGL off (${why}) — the DOM renderer draws the terminals`);
  webglFailed = true;
  for (const e of entries.values()) {
    e.webgl?.dispose();
    e.webgl = null;
  }
}

function onKey(e: Entry, ev: KeyboardEvent): boolean {
  const term = e.term;
  if (!term) return true;
  const action = terminalKeyAction(ev, { hasSelection: term.hasSelection(), mac: config.platform === "darwin" });
  if (xtermHandles(action)) return true;
  if (ev.type !== "keydown") return false;
  switch (action.kind) {
    case "copy":
      if (term.hasSelection()) deps.copy(term.getSelection());
      term.clearSelection();
      ev.preventDefault();
      ev.stopPropagation();
      break;
    case "send":
      bridge?.input(e.ptyId, action.data);
      ev.preventDefault();
      ev.stopPropagation();
      break;
    case "font":
      deps.onFontSize(steppedFontSize(config.fontSize, action.step));
      ev.preventDefault();
      ev.stopPropagation();
      break;
    case "paste":
      // The browser's paste event follows on xterm's textarea; xterm brackets it (no preventDefault here).
      break;
    case "app":
      // The window's own handlers (document listeners) take it.
      break;
  }
  return false;
}

/** While a terminal has the keyboard main ignores the menu accelerators; an IME composition commits on the way out. */
function watchFocus(e: Entry): void {
  const ta = e.term?.textarea;
  if (!ta) return;
  ta.addEventListener("compositionstart", () => (e.composing = true));
  ta.addEventListener("compositionend", () => (e.composing = false));
  ta.addEventListener("focus", syncFocus);
  ta.addEventListener("blur", () => {
    // Commit a composition the focus change interrupts: compositionend flushes it to the PTY.
    if (e.composing) e.term?.textarea?.blur();
    // Once the focus settled (it may move from one terminal to another).
    setTimeout(syncFocus, 0);
  });
}

/** Tells main whether a terminal has the keyboard, when that changed. */
function syncFocus(): void {
  const focused = terminalHasFocus();
  if (focused === focusSent) return;
  focusSent = focused;
  bridge?.focus(focused);
}

/** Shows the terminal in `container` (re-parenting its element) and keeps it fitted; returns the unmount. */
export function mountTerminal(ptyId: string, container: HTMLElement): () => void {
  const e = entries.get(ptyId);
  if (!e) return () => undefined;
  if (e.container !== container) {
    e.observer?.disconnect();
    container.appendChild(e.host);
    e.container = container;
    if (typeof ResizeObserver !== "undefined") {
      e.observer = new ResizeObserver(() => scheduleFit(e, 50));
      e.observer.observe(container);
    }
  }
  scheduleFit(e, 0);
  return () => {
    if (e.container !== container) return;
    e.observer?.disconnect();
    e.observer = null;
    e.container = null;
    if (e.fitTimer) clearTimeout(e.fitTimer);
    // Parked: detached, the terminal and its buffer stay as they are.
    e.host.remove();
    setTimeout(syncFocus, 0);
  };
}

/** One resize per settled size (debounced 50 ms): never a stream of SIGWINCHes while a pane is dragged. */
function scheduleFit(e: Entry, ms: number): void {
  if (e.fitTimer) clearTimeout(e.fitTimer);
  e.fitTimer = setTimeout(() => {
    e.fitTimer = null;
    fitNow(e);
  }, ms);
}

function fitNow(e: Entry): void {
  if (!e.term || !e.fit || !e.container || !e.host.isConnected) return;
  const size = e.fit.proposeDimensions();
  if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows) || size.cols < 2 || size.rows < 1) return;
  const cols = Math.min(1000, Math.floor(size.cols));
  const rows = Math.min(500, Math.floor(size.rows));
  if (e.nudge) {
    // After a reload: one size off, then (next fit) back — the TUI repaints the screen the replay left.
    e.nudge = false;
    e.lastSize = { cols: Math.max(2, cols - 1), rows };
    bridge?.resize(e.ptyId, e.lastSize.cols, rows);
    scheduleFit(e, 80);
    return;
  }
  if (e.lastSize && e.lastSize.cols === cols && e.lastSize.rows === rows) return;
  if (e.term.cols !== cols || e.term.rows !== rows) e.term.resize(cols, rows);
  e.lastSize = { cols, rows };
  bridge?.resize(e.ptyId, cols, rows);
}

/** The size a PTY opens with before its terminal is laid out: what `container` holds at the configured font. */
export function estimateSize(container: HTMLElement | null, cellWidth: number): { cols: number; rows: number } {
  const rect = container?.getBoundingClientRect();
  const lineHeight = Math.ceil(config.fontSize * 1.2);
  const cols = rect && rect.width > 0 ? Math.floor((rect.width - 22) / Math.max(cellWidth, 1)) : 80;
  const rows = rect && rect.height > 0 ? Math.floor((rect.height - 8) / lineHeight) : 24;
  return { cols: Math.min(1000, Math.max(20, cols)), rows: Math.min(500, Math.max(5, rows)) };
}

/** Ends the terminal for good (its view is gone and its PTY ended). */
export function disposeTerminal(ptyId: string): void {
  const e = entries.get(ptyId);
  if (!e) return;
  entries.delete(ptyId);
  e.observer?.disconnect();
  if (e.fitTimer) clearTimeout(e.fitTimer);
  e.webgl?.dispose();
  e.term?.dispose();
  e.host.remove();
  notify();
  setTimeout(syncFocus, 0);
}

/** Main restarted the PTY under the same id: it runs again (the old screen stays until the program repaints it). */
export function markRestarted(ptyId: string): void {
  const e = entries.get(ptyId);
  if (!e) return;
  e.status = { running: true, exit: null };
  e.unacked = 0;
  notify();
}

export function hasTerminal(ptyId: string | null | undefined): boolean {
  return ptyId != null && entries.has(ptyId);
}

/** The chat PTY of `sessionId` the registry holds (a reload re-adopts it from `rg.pty.list`). */
export function chatTerminalOf(sessionId: string): string | null {
  for (const e of entries.values()) if (e.kind === "chat" && e.sessionId === sessionId) return e.ptyId;
  return null;
}

/** A shell tab's shell (null: not a shell, or not known). */
export function terminalShellOf(ptyId: string): ShellKind | null {
  return entries.get(ptyId)?.shell ?? null;
}

/** The shell PTYs, in the order they were opened. */
export function shellTerminals(): string[] {
  return [...entries.values()].filter((e) => e.kind === "shell").map((e) => e.ptyId);
}

const NO_STATUS: TerminalStatus = { running: false, exit: null };

export function terminalStatus(ptyId: string | null | undefined): TerminalStatus {
  return (ptyId && entries.get(ptyId)?.status) || NO_STATUS;
}

/** For `useSyncExternalStore`: any terminal came, went, started or exited. */
export function subscribeTerminals(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** A version that changes with every `notify` (the store's snapshot). */
let version = 0;
listeners.add(() => version++);
export function terminalsVersion(): number {
  return version;
}

export function focusTerminal(ptyId: string | null | undefined): boolean {
  const e = ptyId ? entries.get(ptyId) : undefined;
  if (!e?.term || !e.host.isConnected) return false;
  e.term.focus();
  return true;
}

/** The terminal of `ptyId` (or any terminal) has the keyboard. */
export function terminalHasFocus(ptyId?: string): boolean {
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (!active) return false;
  if (ptyId === undefined) return active.closest?.(".xterm") != null;
  const e = entries.get(ptyId);
  return !!e && e.host.contains(active);
}

/** Bytes typed for the user (Stop's Esc). */
export function sendToTerminal(ptyId: string, data: string): void {
  bridge?.input(ptyId, data);
}

/** §57.7: one bracketed paste, never an Enter — false when the program has bracketed paste off (or no terminal). */
export function pasteIntoTerminal(ptyId: string | null | undefined, text: string): boolean {
  const e = ptyId ? entries.get(ptyId) : undefined;
  const term = e?.term;
  if (!term || !term.modes.bracketedPasteMode) return false;
  const clean = sanitizePaste(text);
  if (!clean) return false;
  term.paste(clean);
  return true;
}

/** Bracketed paste is on in `ptyId`'s program (its prompt shows). */
export function acceptsPaste(ptyId: string | null | undefined): boolean {
  const e = ptyId ? entries.get(ptyId) : undefined;
  return e?.term?.modes.bracketedPasteMode === true;
}

/** "Find in terminal": the next / previous match of `query` in the buffer (the search addon loads on first use). */
export async function findInTerminal(ptyId: string, query: string, backwards = false): Promise<boolean> {
  const e = entries.get(ptyId);
  if (!e?.term || !query) return false;
  if (!e.search) {
    const m = await (modules ??= loader());
    e.search = m.search();
    e.term.loadAddon(e.search);
  }
  const o = { caseSensitive: false, incremental: !backwards };
  return backwards ? e.search.findPrevious(query, o) : e.search.findNext(query, o);
}

export function clearTerminalFind(ptyId: string): void {
  entries.get(ptyId)?.search?.clearDecorations();
}

/** Settings and the window's theme changed: every terminal follows (font size, colours, WebGL on / off). */
export function configureTerminals(next: Partial<TerminalConfig>): void {
  const before = config;
  config = { ...config, ...next };
  for (const e of entries.values()) {
    const term = e.term;
    if (!term) continue;
    if (before.fontSize !== config.fontSize) {
      term.options.fontSize = config.fontSize;
      scheduleFit(e, 0);
    }
    if (before.theme !== config.theme) term.options.theme = terminalTheme(config.theme);
    if (before.gpu !== config.gpu && config.gpu === "off") {
      e.webgl?.dispose();
      e.webgl = null;
    }
  }
  if (before.gpu !== config.gpu && config.gpu === "auto") {
    webglFailed = false;
    void (modules ?? Promise.resolve(null)).then((m) => {
      if (!m) return;
      for (const e of entries.values()) if (!e.webgl) loadWebgl(e, m);
    });
  }
}

export function terminalConfig(): TerminalConfig {
  return config;
}
