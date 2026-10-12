/**
 * M19 (docs/M19-MULTIPROJECT.md): which projects were open at the last quit (`openWindows`, restored
 * on launch) and the window frame remembered per project (`ui.<projectRootHash>.bounds`, clamped to a
 * visible display before it is used).
 */
import { screen } from "electron";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { projectRootHash } from "../shared/hash.js";
import type { OpenWindow, ProjectUI, WindowBounds } from "../shared/ipc.js";
import { logLine } from "./log.js";
import { loadSettings, saveSettings } from "./settings.js";

export const MAX_RESTORED_WINDOWS = 5;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 560;

/** A frame from a screen that no longer exists (or one larger than its display) must stay usable. */
export function clampToDisplay(b: WindowBounds): WindowBounds {
  const area = screen.getDisplayMatching(b).workArea;
  const width = Math.min(Math.max(Math.round(b.width), MIN_WIDTH), area.width);
  const height = Math.min(Math.max(Math.round(b.height), MIN_HEIGHT), area.height);
  const x = Math.min(Math.max(Math.round(b.x), area.x), area.x + area.width - width);
  const y = Math.min(Math.max(Math.round(b.y), area.y), area.y + area.height - height);
  return { x, y, width, height };
}

function isBounds(b: unknown): b is WindowBounds {
  const o = b as Partial<WindowBounds> | undefined;
  return !!o && [o.x, o.y, o.width, o.height].every((n) => typeof n === "number" && Number.isFinite(n)) && (o.width ?? 0) > 0 && (o.height ?? 0) > 0;
}

/** The frame this project (or any project rooted at `path`) was last seen with. */
export function savedBoundsFor(path: string): WindowBounds | undefined {
  const b = loadSettings().ui?.[projectRootHash(path)]?.bounds;
  return isBounds(b) ? b : undefined;
}

/** Written whenever a window opens / closes / changes project and on `before-quit` (before the engines are disposed). */
export function persistOpenWindows(open: OpenWindow[], boundsKeys: Record<string, WindowBounds> = {}): void {
  const ui: Record<string, ProjectUI> = { ...(loadSettings().ui ?? {}) };
  for (const [root, bounds] of Object.entries(boundsKeys)) {
    const hash = projectRootHash(root);
    ui[hash] = { ...ui[hash], bounds };
  }
  saveSettings({ openWindows: open, ui });
}

/** Launch: at most 5 windows, in the saved order, existing folders only — missing ones are pruned. */
export function restorableWindows(): OpenWindow[] {
  const s = loadSettings();
  if (s.reopenLastProjects === false) return [];
  const saved = (s.openWindows ?? []).filter((w): w is OpenWindow => typeof w?.path === "string" && w.path.length > 0);
  const alive = saved.filter((w) => existsSync(resolve(w.path)));
  if (alive.length !== saved.length) {
    saveSettings({ openWindows: alive });
    logLine("main", "main", `restore: dropped ${saved.length - alive.length} window(s) whose folder is gone`);
  }
  return alive.slice(0, MAX_RESTORED_WINDOWS).map((w) => ({ path: w.path, bounds: isBounds(w.bounds) ? w.bounds : undefined }));
}
