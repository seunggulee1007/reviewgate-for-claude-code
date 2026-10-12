/**
 * MARK: wave3 desktop-session
 * docs/PROTOCOL.md §36.6 in main, pure (no `electron`) and unit-tested: "Load local settings (settings.local.json)" is
 * kept per project (`settings.projectLoadLocalSettings[projectRootHash(root)]`, absent = on, as the terminal's claude
 * does) and reaches the engine as `settings.loadLocalSettings` — in every `set_settings` for the window's project and right
 * before each `open_project` / `switch_project`, so the session that starts gets that project's own choice.
 */
import { projectRootHash } from "../shared/hash.js";

/** This project's "Load local settings": stored false turns it off; anything else (unset, no project) is on. */
export function loadLocalSettingsFor(flags: Record<string, boolean> | undefined, root: string | null | undefined): boolean {
  if (!root || !flags) return true;
  return flags[projectRootHash(root)] !== false;
}

/**
 * MARK: wave6 w6-statusline — §44.2: the sha256 of this project's own statusLine command the user allowed
 * (`settings.projectStatusLineAllowed[projectRootHash(root)]`), "" for none — sent with the project's settings, so the
 * engine never keeps the last project's.
 */
export function allowedProjectStatusLineFor(allowed: Record<string, string> | undefined, root: string | null | undefined): string {
  if (!root || !allowed) return "";
  const sha = allowed[projectRootHash(root)];
  return typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha) ? sha : "";
}

/** The folder of an `open_project` / `switch_project` (its settings go to the engine first); null for any other command. */
export function projectOpenPath(cmd: { type: string; path?: unknown }): string | null {
  if (cmd.type !== "open_project" && cmd.type !== "switch_project") return null;
  return typeof cmd.path === "string" && cmd.path.length > 0 ? cmd.path : null;
}
