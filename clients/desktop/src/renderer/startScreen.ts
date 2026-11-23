/**
 * MARK: task-start — docs/PROTOCOL.md §63.4 on Windows (the Mac's `StartScreenOverlay`): whether the start screen covers a
 * project window's diff and chat area, decided once per project the window opens (a reconnect or a new snapshot of the same
 * project never brings it back). A window the app opened with work of its own (`window.rgNoStartScreen`: the launch
 * restore, a workbench it just created, a moved chat, the e2e runs) skips it for its first project; a turn that starts
 * meanwhile, or text handed to the composer, puts it away. The rules themselves are `shouldShowStartScreen` (taskStart.ts).
 */
import { create } from "zustand";
import type { ReviewState } from "@reviewgate/engine";
import type { AppSettings } from "../shared/ipc";
import { START_MARK, shouldShowStartScreen, type StartMark } from "./taskStart";

declare global {
  interface Window {
    /** `--rg-no-start-screen` (src/preload.ts): this window's first project opens without the start screen. */
    rgNoStartScreen?: boolean;
  }
}

export const useStartScreen = create<{ shown: boolean; mark: StartMark }>(() => ({ shown: false, mark: START_MARK }));

export function hideStartScreen(): void {
  if (useStartScreen.getState().shown) useStartScreen.setState({ shown: false, mark: START_MARK });
}

/** What the watcher keeps between snapshots: the project it decided for, and whether the next decision is skipped. */
export type StartScreenWatch = { checkedPath: string | null; suppressNext: boolean };

/** What one decision reads of the window. */
export type StartScreenScene = {
  state: Pick<ReviewState, "project" | "gitInit" | "gate">;
  settings: Pick<AppSettings, "skipStartScreen"> | null;
  /** Text waits for the composer (a draft handed over before it mounted). */
  composerWaiting: boolean;
};

/**
 * The next screen state after a snapshot: `show` true / false decides (a new project, or work that started), null leaves
 * it as it is. A project that is not open yet, or a git-init prompt, decides nothing.
 */
export function stepStartScreen(watch: StartScreenWatch, scene: StartScreenScene, shown: boolean): { watch: StartScreenWatch; show: boolean | null } {
  const path = scene.state.project?.path ?? null;
  if (path !== watch.checkedPath) {
    if (!path) return { watch: { ...watch, checkedPath: null }, show: false };
    // The git-init prompt comes first (§59); the decision waits for the project behind it.
    if (scene.state.gitInit) return { watch, show: false };
    const show = shouldShowStartScreen({
      skip: scene.settings?.skipStartScreen === true,
      suppressed: watch.suppressNext,
      phase: scene.state.gate.phase,
      reviewPending: scene.state.gate.pendingCount > 0 || scene.state.gate.changesRequestedCount > 0,
      composerTask: scene.composerWaiting,
    });
    return { watch: { checkedPath: path, suppressNext: false }, show };
  }
  // A turn that starts meanwhile (a peer message, §29) or files that arrive put it away.
  if (shown && (scene.state.gate.phase !== "idle" || scene.state.gate.pendingCount > 0)) return { watch, show: false };
  return { watch, show: null };
}
