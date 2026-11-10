/**
 * MARK: polish p-lifecycle — P1-chrome-03: switching or closing a window's project stops its session (the engine's
 * `open_project` / `close_project` stop the turn that runs), so the store asks first, like a window's close: main shows the
 * question (src/main/windows.ts `rg:confirmProjectChange`, src/shared/closeGuard.ts `projectChangePrompt`) with what only
 * this page knows (closeGuardExtras.ts). docs/PROTOCOL.md §55.7.
 */
import { closeGuardExtras } from "./closeGuardExtras";
import type { Store } from "./store";

type Facts = Parameters<typeof closeGuardExtras>[0];

/** `asked`: a question was shown (the pending-review question then stays away); `ok`: go ahead. No bridge: go ahead. */
export async function confirmProjectChange(s: Facts, change: "switch" | "close"): Promise<{ asked: boolean; ok: boolean }> {
  const bridge = typeof window !== "undefined" ? window.rg : undefined;
  if (!bridge?.confirmProjectChange) return { asked: false, ok: true };
  try {
    return await bridge.confirmProjectChange(change, closeGuardExtras(s));
  } catch {
    return { asked: false, ok: true };
  }
}

/** `path` is the project the window has open (its folder or its repository root; Windows compares without case). */
export function isOpenProject(project: Pick<NonNullable<Store["state"]["project"]>, "path" | "root"> | null, path: string, platform: string): boolean {
  if (!project) return false;
  const norm = (p: string) => {
    const trimmed = p.replace(/[\\/]+$/, "");
    return platform === "win32" ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
  };
  const target = norm(path);
  return [project.path, project.root].some((p) => typeof p === "string" && p !== "" && norm(p) === target);
}
