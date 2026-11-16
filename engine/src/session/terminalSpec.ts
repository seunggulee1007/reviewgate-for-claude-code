/**
 * docs/PROTOCOL.md §57.3: how a terminal chat's `claude` starts — the http hooks passed inline with `--settings` (an argv
 * string: no file, no token inside), the argv, and the preflight that refuses a terminal whose hooks would never run.
 * Pure but for `hooksDisabled`, which only reads settings files.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `onFailure` on http hooks (fail closed when the engine is gone) needs this CLI or later. */
export const MIN_TERMINAL_CLI = "2.1.295";

/** The PTY env key holding the hook token; the hooks' header names it, so the token never sits in argv. */
export const HOOK_TOKEN_ENV = "RG_HOOK_TOKEN";

/** The header the hook server checks. */
export const HOOK_TOKEN_HEADER = "X-ReviewGate-Token";

/** Appended to Claude's system prompt in a terminal chat. */
export const TERMINAL_SYSTEM_APPEND =
  "Changes you make are reviewed in ReviewGate after each turn. A '[Review gate] …' note in your context lists files the " +
  "user accepted or rejected; rejected files were reverted on disk — do not redo them unless asked.";

/** The write tools whose calls start / attribute a review turn. */
export const TERMINAL_WRITE_TOOLS_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash";

type HttpHook = {
  type: "http";
  url: string;
  headers: Record<string, string>;
  allowedEnvVars: string[];
  timeout: number;
  onFailure?: "block";
};

/**
 * The `--settings` object: every hook posts to `url` with the token header (interpolated by the CLI from the env).
 * `onFailure: "block"` only where blocking is fail-closed (UserPromptSubmit, PreToolUse) — never on Stop, where "block"
 * means "keep Claude going".
 */
export function hookSettings(url: string): { hooks: Record<string, { matcher?: string; hooks: HttpHook[] }[]> } {
  const h = (timeout: number, block = false): HttpHook => ({
    type: "http",
    url,
    headers: { [HOOK_TOKEN_HEADER]: `\${${HOOK_TOKEN_ENV}}` },
    allowedEnvVars: [HOOK_TOKEN_ENV],
    timeout,
    ...(block ? { onFailure: "block" as const } : {}),
  });
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [h(120, true)] }],
      PreToolUse: [{ matcher: TERMINAL_WRITE_TOOLS_MATCHER, hooks: [h(60, true)] }],
      PostToolUse: [{ matcher: TERMINAL_WRITE_TOOLS_MATCHER, hooks: [h(120)] }],
      PostToolUseFailure: [{ matcher: "Bash", hooks: [h(120)] }],
      Stop: [{ hooks: [h(30)] }],
      StopFailure: [{ hooks: [h(30)] }],
      Notification: [{ hooks: [h(10)] }],
      SessionEnd: [{ hooks: [h(5)] }],
    },
  };
}

/** `claude --session-id|--resume <id> --settings <json> --append-system-prompt <…>` — the user's own claude otherwise. */
export function terminalArgv(a: { claude: string; id: string; resume: boolean; settingsJson: string }): string[] {
  return [a.claude, a.resume ? "--resume" : "--session-id", a.id, "--settings", a.settingsJson, "--append-system-prompt", TERMINAL_SYSTEM_APPEND];
}

/** The env the PTY adds: only `RG_*` / `CLAUDE_CODE_*` keys pass. */
export function terminalEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("RG_") || k.startsWith("CLAUDE_CODE_")));
}

function readSettings(path: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null; // absent or unreadable: the CLI ignores it too
  }
}

/**
 * Why the terminal's hooks would never run, or null: `disableAllHooks: true` in the user's (`<configDir>/settings.json`),
 * the project's (`.claude/settings.json`, `.claude/settings.local.json`) or the managed settings; `allowManagedHooksOnly`
 * in the managed settings (`managed`: the managed tier as `readManagedPolicy` merges it, null when none). Read-only.
 */
export function hooksDisabled(o: { configDir: string; projectDir: string; managed: Record<string, unknown> | null }): "disableAllHooks" | "allowManagedHooksOnly" | null {
  if (o.managed?.disableAllHooks === true) return "disableAllHooks";
  if (o.managed?.allowManagedHooksOnly === true) return "allowManagedHooksOnly";
  const files = [join(o.configDir, "settings.json"), join(o.projectDir, ".claude", "settings.json"), join(o.projectDir, ".claude", "settings.local.json")];
  for (const f of files) if (readSettings(f)?.disableAllHooks === true) return "disableAllHooks";
  return null;
}
