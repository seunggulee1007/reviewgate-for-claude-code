/**
 * The context window each model ran with last (`<data dir>/context-windows.json`, app-wide): the CLI reports a window only
 * with a turn's result, so a status line run right after a restart would otherwise guess (200k for a 1M model, which made
 * a 92 % "context" out of 18 %).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONTEXT_WINDOWS_FILE = "context-windows.json";

export class ContextWindows {
  private windows: Record<string, number> | null = null;

  constructor(private readonly dataDir: string) {}

  /** The last window `model` ran with (its `[1m]` suffix ignored); undefined when never seen. */
  get(model: string | null | undefined): number | undefined {
    if (!model) return undefined;
    const w = this.load()[key(model)];
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : undefined;
  }

  /** Remembers `window` for `model` (written only when it changed; best effort). */
  set(model: string | null | undefined, window: number | undefined): void {
    if (!model || window === undefined || !Number.isFinite(window) || window <= 0) return;
    const all = this.load();
    if (all[key(model)] === window) return;
    all[key(model)] = window;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const file = join(this.dataDir, CONTEXT_WINDOWS_FILE);
      writeFileSync(file + ".tmp", JSON.stringify(all));
      renameSync(file + ".tmp", file);
    } catch {
      // the next turn tries again
    }
  }

  private load(): Record<string, number> {
    if (this.windows) return this.windows;
    try {
      const o = JSON.parse(readFileSync(join(this.dataDir, CONTEXT_WINDOWS_FILE), "utf8")) as unknown;
      this.windows = o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, number>) : {};
    } catch {
      this.windows = {};
    }
    return this.windows;
  }
}

function key(model: string): string {
  return model.replace(/\[1m\]$/i, "");
}
