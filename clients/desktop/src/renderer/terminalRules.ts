/**
 * §33.8 Settings › "터미널(Claude Code) 허용 규칙" (pure, unit-tested; docs/PROTOCOL.md §33.5–33.8): what each rule's
 * `why` means, which imports deserve a warning, the import itself (the ticked rules' `importAs` appended to the global
 * or this project's allow patterns — nothing is written to the Claude Code settings files) and the first-run
 * "start in the terminal's mode?" suggestion.
 */
import type { PermissionMode, PermissionRuleSource, PermissionRulesEvent } from "@reviewgate/engine";
import type { AppSettings } from "../shared/ipc";
import { addPatternLine, permissionRisks } from "./bashPattern";
import { t } from "./i18n";
import { projectRootHash } from "./sessions";

/** One rule's `why` in words (§2.8 table); a value this client does not know yet stays as the engine wrote it. */
export function ruleWhyText(why: string): string {
  switch (why) {
    case "non_mutating_tool":
      return t("Applied — a tool that does not change files");
    case "read_mcp_tool":
      return t("Applied — a read-only MCP tool");
    case "read_mcp_tools":
      return t("Applied to its read tools only");
    case "already_allowed":
      return t("Never asks anyway");
    case "bash_rule": // MARK: r2-skills-side (§33.5, M20) — the Mac's words
      return t("Applied — matching commands run without a card, like an app allow pattern; what they change is still reviewed");
    case "mutating_mcp_tool":
      return t("Not applied — an MCP tool that writes");
    case "bash":
      return t("Commands go through the review gate first — importing adds it as an app allow pattern");
    case "edit_tool":
      return t("Edits are always reviewed");
    case "send_message":
      return t("Messages to other sessions always ask");
    case "unsupported":
      return t("Unsupported form");
    case "invalid":
      return t("Invalid rule");
    case "rules_off":
      return t("Applying terminal rules is turned off");
    case "user_settings_off":
      return t("Loading user settings is turned off");
    case "local_settings_off": // §36.6 — the Mac's words
      return t("Loading local settings is off");
    default:
      return why;
  }
}

/** Where a rule / settings file comes from. */
export function ruleScopeText(scope: string): string {
  switch (scope) {
    case "user":
      return t("User");
    case "project":
      return t("Project");
    case "local":
      return t("Local");
    default:
      return scope;
  }
}

/** A settings file's state: missing, unreadable (with the parser's words), or read. */
export function ruleSourceStatus(src: Pick<PermissionRuleSource, "exists" | "error">): string {
  if (!src.exists) return t("Missing");
  if (src.error) return t("Read error: {0}", src.error);
  return t("Read");
}

/** Programs whose allow pattern would let Claude run nearly anything, or destroy / escalate. */
const RISKY_PROGRAMS = new Set(["sudo", "su", "doas", "sh", "bash", "zsh", "fish", "pwsh", "powershell", "cmd", "eval", "exec", "xargs", "env", "rm", "rmdir", "dd", "mkfs", "shred", "chmod", "chown", "kill", "killall", "pkill"]);

/**
 * The import deserves a warning icon: a Bash pattern that deletes, rewrites history, talks to the network, runs a
 * shell / privilege program or globs over any command (`Bash(git *)`), or an MCP tool that writes.
 */
export function isRiskyImport(rule: { importAs: string | null; why: string }): boolean {
  const pattern = rule.importAs?.trim();
  if (!pattern) return false;
  if (rule.why === "mutating_mcp_tool") return true;
  const m = /^Bash\((.*)\)$/s.exec(pattern);
  if (!m) return false;
  let body = m[1]!.trim();
  if (body.endsWith(":*")) body = body.slice(0, -2).trim();
  if (body.length === 0 || /[*?]/.test(body)) return true;
  const program = (body.split(/\s+/)[0] ?? "").split(/[\\/]/).pop() ?? "";
  if (RISKY_PROGRAMS.has(program)) return true;
  return permissionRisks({ toolName: "Bash", input: { command: body } }, null).some((r) => r !== "outside");
}

export type ImportTarget = "global" | "project";

/**
 * The settings patch that appends `patterns` (deduplicated, trimmed) to the global allow patterns or to this project's
 * (`projectBashAllowPatterns[projectRootHash(root)]`); `added` counts the new lines. Null when there is nothing to do.
 */
export function importPatch(
  settings: Pick<AppSettings, "bashAllowPatterns" | "projectBashAllowPatterns">,
  patterns: readonly string[],
  target: ImportTarget,
  root: string | null,
): { patch: Partial<AppSettings>; added: number } | null {
  const wanted = [...new Set(patterns.map((p) => p.trim()).filter((p) => p.length > 0))];
  if (wanted.length === 0) return null;
  const append = (text: string | undefined): { text: string; added: number } => {
    let out = text ?? "";
    let added = 0;
    for (const p of wanted) {
      const before = out.split(/\r?\n/).map((l) => l.trim());
      if (!before.includes(p)) added++;
      out = addPatternLine(out, p);
    }
    return { text: out, added };
  };
  if (target === "global") {
    const r = append(settings.bashAllowPatterns);
    return { patch: { bashAllowPatterns: r.text }, added: r.added };
  }
  if (!root) return null;
  const hash = projectRootHash(root);
  const map = { ...(settings.projectBashAllowPatterns ?? {}) };
  const r = append(map[hash]);
  map[hash] = r.text;
  return { patch: { projectBashAllowPatterns: map }, added: r.added };
}

const OFFERED_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];

/**
 * §2.8 "터미널처럼 {mode} 모드로 시작할까요?": the terminal's `permissions.defaultMode` when ReviewGate offers it, it
 * differs from both the mode new sessions start in and the live one, and the user has not said no to it before.
 */
export function modeSuggestion(
  rules: Pick<PermissionRulesEvent, "defaultMode" | "defaultModeSupported">,
  startMode: PermissionMode,
  liveMode: PermissionMode,
  declined: readonly string[],
): PermissionMode | null {
  const mode = rules.defaultMode;
  if (!mode || !rules.defaultModeSupported) return null;
  const offered = OFFERED_MODES.find((m) => m === mode);
  if (!offered || offered === startMode || offered === liveMode || declined.includes(offered)) return null;
  return offered;
}

// MARK: wave2 check-clients
/** What the rules screen shows: the last rules read, whether a read runs, and why the last one was refused. */
export type RulesLoad = { loading: boolean; rules: PermissionRulesEvent | null; error: string | null };

/** After a read (as on the Mac): a reply replaces the rules; a refusal says why above the rules read last time instead of hiding them. */
export function rulesAfterFetch(prev: RulesLoad, r: { ok: true; rules: PermissionRulesEvent } | { ok: false; message: string }): RulesLoad {
  return r.ok ? { loading: false, rules: r.rules, error: null } : { loading: false, rules: prev.rules, error: r.message };
}
