/**
 * §57.10: what this window's main process can run (`rg.pty.info`, read once by useTermHost): node-pty loaded (on Windows
 * build ≥ 18309) and the shells of the bottom panel. Its own module (no store import) so the store's slices can read it.
 */
import { create } from "zustand";
import type { PtyInfo } from "../../shared/ipc";

export const usePtyInfo = create<{ info: PtyInfo | null }>(() => ({ info: null }));

/** A terminal chat's PTY can run in this window. */
export function ptyAvailable(): boolean {
  return usePtyInfo.getState().info?.available === true;
}

/** The bottom shell panel can open (Windows with node-pty). */
export function shellsAvailable(): boolean {
  return (usePtyInfo.getState().info?.shells.length ?? 0) > 0;
}
