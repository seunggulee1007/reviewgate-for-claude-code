/**
 * docs/M16-FRICTION.md helpers over `ReviewState`: `session.rememberedAllows` read through an accessor
 * that tolerates a snapshot from an engine build without it, plus the "Accept N & Send" and
 * diff-pane-collapse rules.
 */
import type { ReviewState } from "@reviewgate/engine";
import type { ProjectUI } from "../shared/ipc";

const EMPTY_ALLOWS: string[] = [];

/** `state.session.rememberedAllows` (tool + command-prefix keys auto-allowed for the rest of the session). */
export const rememberedAllowsOf = (s: ReviewState): string[] => s.session.rememberedAllows ?? EMPTY_ALLOWS;

/**
 * The explicit "Accept N & Send" action is offered: a message can be sent, files are pending and none
 * is changesRequested (those must go through Request changes). Plain Send never accepts anything —
 * it asks a question and leaves the review standing (docs/PROTOCOL.md §10).
 */
export const canAcceptAndSend = (s: ReviewState): boolean =>
  s.gate.canSend && s.gate.pendingCount > 0 && s.gate.changesRequestedCount === 0;

/**
 * Diff pane collapsed? `ui.diffCollapsed` is the user's ⌘⇧D choice; undefined = auto: collapsed while the
 * Changes tab has no changed files and nothing selected (the chat takes the width).
 */
export const isDiffCollapsed = (s: ReviewState, ui: ProjectUI, selectedPath: string | null): boolean =>
  ui.diffCollapsed ?? (s.changedFiles.length === 0 && selectedPath === null);
