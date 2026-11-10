/**
 * Audit polish-03: ⌘⇧R / Ctrl+Shift+R (reject the selected file) is also the browser's "force reload". The window-wide
 * handler always takes the key — it rejects when the shown, pending file can be rejected, and otherwise says why not
 * (a toast) instead of letting the key fall through to a reload that would lose the draft and the queue.
 */
import { useEffect } from "react";
import type { ReviewState } from "@reviewgate/engine";
import type { ProjectUI } from "../shared/ipc";
import { isDiffCollapsed } from "./friction";
import { t } from "./i18n";
import { isReviewLocked } from "./planLock";

export function isRejectShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "r";
}

export type RejectShortcut = { kind: "reject"; path: string } | { kind: "blocked"; why: string };

/** What the reject shortcut does now: reject the file the diff pane shows, or the reason it cannot. */
export function rejectShortcutTarget(s: {
  state: ReviewState;
  selectedPath: string | null;
  tab: string;
  ui: ProjectUI;
  historyOpen: boolean;
  dialogOpen: boolean;
}): RejectShortcut {
  if (s.dialogOpen) return { kind: "blocked", why: t("close the dialog first") };
  if (!s.state.project) return { kind: "blocked", why: t("no project is open") };
  if (s.tab === "prs") return { kind: "blocked", why: t("files are rejected on the Changes tab") };
  if (s.historyOpen) return { kind: "blocked", why: t("a past review is shown (read-only)") };
  if (isReviewLocked(s.state)) return { kind: "blocked", why: s.state.gate.phase === "reverting" ? t("files are being reverted") : t("Claude is still working") };
  const file = s.selectedPath ? s.state.changedFiles.find((f) => f.path === s.selectedPath) : undefined;
  if (!file || file.state !== "pending") return { kind: "blocked", why: t("select a pending file first") };
  if (isDiffCollapsed(s.state, s.ui, s.selectedPath)) return { kind: "blocked", why: t("open the diff pane first") };
  return { kind: "reject", path: file.path };
}

/** The toast of a blocked reject shortcut. */
export function rejectBlockedText(why: string): string {
  return t("Can't reject right now — {0}", why);
}

type Deps = {
  get: () => Parameters<typeof rejectShortcutTarget>[0];
  reject: (path: string) => void;
  toast: (text: string) => void;
};

/** Installs the window-wide reject shortcut (once, in App). */
export function useRejectShortcut(deps: () => Deps): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isRejectShortcut(e)) return;
      // Always ours: never a reload, whatever the state.
      e.preventDefault();
      if (e.repeat) return;
      const d = deps();
      const target = rejectShortcutTarget(d.get());
      if (target.kind === "reject") d.reject(target.path);
      else d.toast(rejectBlockedText(target.why));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
