import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AutoAcceptRules } from "../protocol.js";
import { readJSON, writeAtomicJSON } from "./persist.js";
import { normalizeAutoAcceptRules } from "./trust.js";

/**
 * MARK: wave4c w4c-trust — §41.2: a repository's auto-accept rules, `<git common dir>/reviewgate/auto-accept.json` — every
 * worktree and workbench of the repository shares them (an issue worktree starts with the project's rules). Absent,
 * unreadable or of another version: every rule off.
 */
export type PersistedAutoAccept = { version: 1; rules: AutoAcceptRules; savedAt: string };

export function autoAcceptFilePath(commonDir: string): string {
  return join(commonDir, "reviewgate", "auto-accept.json");
}

export async function loadAutoAcceptRules(commonDir: string): Promise<AutoAcceptRules> {
  const f = await readJSON<PersistedAutoAccept>(autoAcceptFilePath(commonDir));
  if (!f || f.version !== 1) return {};
  return normalizeAutoAcceptRules(f.rules);
}

export async function saveAutoAcceptRules(commonDir: string, rules: AutoAcceptRules): Promise<void> {
  const path = autoAcceptFilePath(commonDir);
  await mkdir(dirname(path), { recursive: true });
  await writeAtomicJSON(path, { version: 1, rules: normalizeAutoAcceptRules(rules), savedAt: new Date().toISOString() } satisfies PersistedAutoAccept);
}
