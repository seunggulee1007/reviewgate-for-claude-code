/**
 * MARK: c-panel — §57.18: a project folder's files for the Run tab's detection (src/shared/runConfigs.ts) — read only, a
 * file over 1 MB is not read. No `electron`, so it is unit-tested (runConfigs.test.ts).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunFiles } from "../shared/runConfigs.js";

export function folderFiles(cwd: string): RunFiles {
  return {
    exists: (p) => existsSync(join(cwd, p)),
    read: (p) => {
      try {
        const full = join(cwd, p);
        return statSync(full).size <= 1_000_000 ? readFileSync(full, "utf8") : null;
      } catch {
        return null;
      }
    },
  };
}
