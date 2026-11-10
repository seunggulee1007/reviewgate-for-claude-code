/**
 * MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the user's Claude Code status line on Electron — the last
 * `status_line` the engine sent (a reply or an event; replies reach the window twice, so applying is idempotent), its
 * lines as runs, the width / visibility the chat told the engine, and how a run is drawn. The Mac's Core
 * `StatusLineStore` / `AnsiText.attributed` follow the same rules.
 */
import { create } from "zustand";
import type { EngineEvent, StatusLineEvent } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { ansiColorCss, parseAnsiLines, type AnsiRun } from "./ansi";
import { projectRootHash } from "../shared/hash";

type Bridge = Parameters<typeof engineRequest>[1];

export type StatusLineState = {
  reply: StatusLineEvent | null;
  /** `reply.lines` parsed (styles carried from line to line). */
  runs: AnsiRun[][];
  /** The engine does not know `status_line` (an older engine): nothing is asked again. */
  unsupported: boolean;
  /** `columns|visible` last told (the same is not sent twice in a row). */
  told: string | null;
  /** The project the lines are of (a remount of the chat for the same project keeps them). */
  root: string | null;
};

const sameLines = (a: readonly string[] | undefined, b: readonly string[]) => !!a && a.length === b.length && a.every((l, i) => l === b[i]);

export const useStatusLine = create<StatusLineState & {
  apply(reply: StatusLineEvent): void;
  reset(): void;
  /** The chat shows this project: another one's lines go (the same project's stay — a remount does not blink). */
  setRoot(root: string | null): void;
  tell(columns: number, visible: boolean, bridge?: Bridge): Promise<void>;
}>((set, get) => ({
  reply: null,
  runs: [],
  unsupported: false,
  told: null,
  root: null,
  apply(reply) {
    set((s) => ({ reply, runs: sameLines(s.reply?.lines, reply.lines) ? s.runs : parseAnsiLines(reply.lines) }));
  },
  reset() {
    set({ reply: null, runs: [], told: null });
  },
  setRoot(root) {
    if (get().root === root) return;
    set({ root, reply: null, runs: [], told: null });
  },
  async tell(columns, visible, bridge) {
    if (get().unsupported) return;
    const key = `${columns}|${visible}`;
    if (get().told === key) return;
    set({ told: key });
    try {
      get().apply(await engineRequest({ type: "status_line", columns, visible }, bridge));
    } catch (e) {
      const r = refusalOf(e);
      set({ told: null, ...(r.code === "unknown_command" ? { unsupported: true } : {}) });
    }
  },
}));

/** The main store's event hook: every `status_line` (replies and the engine's own) goes to the status line's store. */
export function applyStatusLineEvent(ev: EngineEvent): boolean {
  if (ev.type !== "status_line") return false;
  useStatusLine.getState().apply(ev);
  return true;
}

/**
 * The project's own statusLine (as the engine last told it) against what the user allowed for this project
 * (`settings.projectStatusLineAllowed`): `allowed` — that very command; `changed` — another one was allowed (a pull changed
 * it), so it is asked about again. The Mac's `AppState.projectStatusLineAllowed` / `projectStatusLineChanged`.
 */
export function projectStatusLineChoice(
  allowed: Record<string, string> | undefined,
  root: string | null | undefined,
  project: StatusLineEvent["project"],
): { allowed: boolean; changed: boolean } {
  const stored = root && allowed ? (allowed[projectRootHash(root)] ?? "") : "";
  if (!project) return { allowed: false, changed: false };
  return { allowed: !!project.sha256 && stored === project.sha256, changed: stored !== "" && stored !== project.sha256 };
}

/** The allowance map with this project's set to `sha256` ("" removes it). */
export function withProjectStatusLine(allowed: Record<string, string> | undefined, root: string, sha256: string): Record<string, string> {
  const next = { ...(allowed ?? {}) };
  const key = projectRootHash(root);
  if (sha256) next[key] = sha256;
  else delete next[key];
  return next;
}

/** The lines to draw: none while the setting is off or nothing is configured. */
export function shownRuns(s: Pick<StatusLineState, "reply" | "runs">): AnsiRun[][] {
  return s.reply && s.reply.enabled && s.reply.configured ? s.runs : [];
}

/** The width in terminal columns of a box `width` px wide whose font's "0" is `charWidth` px (0 until measured; ≥ 20). */
export function columnsFor(width: number, charWidth: number): number {
  if (!(width > 0) || !(charWidth > 0)) return 0;
  return Math.max(20, Math.floor(width / charWidth));
}

/**
 * How one run looks: its colors in this appearance (plain text keeps the status line's dim gray, `--sl-fg`; inverse
 * swaps it with the page), bold, italic, underline / strike, dim at 55 %, hidden.
 */
export function runCss(run: AnsiRun, dark: boolean): Record<string, string> {
  const css: Record<string, string> = {};
  let fg = run.fg !== undefined ? ansiColorCss(run.fg, dark) : undefined;
  let bg = run.bg !== undefined ? ansiColorCss(run.bg, dark) : undefined;
  if (run.inverse) {
    const swapped = bg ?? "var(--bg)";
    bg = fg ?? "var(--sl-fg)";
    fg = swapped;
  }
  let color = fg ?? "var(--sl-fg)";
  if (run.dim) color = `color-mix(in srgb, ${color} 55%, transparent)`;
  if (run.hidden) color = "transparent";
  if (color !== "var(--sl-fg)") css.color = color;
  if (bg !== undefined) css.backgroundColor = bg;
  if (run.bold) css.fontWeight = "700";
  if (run.italic) css.fontStyle = "italic";
  const deco = [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) css.textDecoration = deco;
  return css;
}
