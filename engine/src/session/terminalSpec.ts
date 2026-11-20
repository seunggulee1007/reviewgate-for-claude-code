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
/**
 * MARK: terminal-guard — §57.8: the git rule of a terminal chat (§46's GIT_INSTRUCTION in this chat's terms: the TUI's own
 * dialog asks, ReviewGate blocks what throws work away).
 */
export const TERMINAL_GIT_INSTRUCTION =
  "Git: run git commands that change the repository — commit, push, merge, pull, rebase, reset, checkout / switch, stash, " +
  "cherry-pick, revert, tag, branch changes — only when the user (or a skill they ran) asks you to, never on your own " +
  "initiative and never just to finish a task: the user reviews and accepts your changes in ReviewGate first. ReviewGate " +
  "asks the user to confirm each such command here, and blocks those that throw away uncommitted work or rewrite the remote " +
  "(reset --hard, clean -f, checkout / restore over uncommitted files, branch -D, stash drop / clear, force pushes). If the " +
  "user declines or ReviewGate blocks one, do not try another way: stop and ask the user.";

export const TERMINAL_SYSTEM_APPEND =
  "Changes you make are reviewed in ReviewGate after each turn. A '[Review gate] …' note in your context lists files the " +
  "user accepted or rejected; rejected files were reverted on disk — do not redo them unless asked.\n\n" +
  TERMINAL_GIT_INSTRUCTION;

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

/** What a spawn's `--settings` carries besides the review hooks (§57.13, §57.15). */
export type HookSettingsOptions = {
  /** §57.15: a PermissionRequest hook — only for a client that answers bridged dialogs (else nobody would). */
  permissionRequest?: boolean;
  /**
   * §57.13: a `statusLine` that posts the CLI's status input to `statusUrl` and then runs the user's own command (null:
   * none — the tee prints nothing); `padding` / `refreshInterval` (seconds) are the user's.
   */
  statusLine?: { statusUrl: string; userCommand: string | null; padding?: number; refreshInterval?: number } | null;
};

/** A word for `/bin/sh` that is exactly `s` (single quotes; a `'` inside as `'\''`). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * §57.13: the statusLine command of a terminal chat — POSIX sh (the CLI runs it with `/bin/sh -c` on macOS). It reads the
 * status JSON once, posts it in the background to the hook server (the token from the env through `-H @-`, never argv;
 * never through a proxy; at most 1 s) and pipes the same JSON into the user's own command, whose output and exit status
 * pass through.
 */
export function statusLineTeeCommand(o: { statusUrl: string; userCommand: string | null }): string {
  const post =
    `j=$(cat); printf '${HOOK_TOKEN_HEADER}: %s\\n' "$${HOOK_TOKEN_ENV}" | /usr/bin/curl -sS -m 1 --noproxy '*' -H @- ` +
    `-H 'Content-Type: application/json' --data-binary "$j" ${shQuote(o.statusUrl)} >/dev/null 2>&1 &`;
  return o.userCommand ? `${post}\nprintf '%s' "$j" | /bin/sh -c ${shQuote(o.userCommand)}` : post;
}

/**
 * The `--settings` object: every hook posts to `url` with the token header (interpolated by the CLI from the env).
 * `onFailure: "block"` only where blocking is fail-closed (UserPromptSubmit, PreToolUse) — never on Stop, where "block"
 * means "keep Claude going". PostToolUse / PostToolUseFailure match every tool (§57.16: any later hook clears `waiting`).
 */
export function hookSettings(url: string, opts: HookSettingsOptions = {}): {
  hooks: Record<string, { matcher?: string; hooks: HttpHook[] }[]>;
  statusLine?: { type: "command"; command: string; padding?: number; refreshInterval?: number };
} {
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
      // §57.15: no onFailure — a failure leaves the TUI's own dialog in charge.
      ...(opts.permissionRequest ? { PermissionRequest: [{ hooks: [h(600)] }] } : {}),
      PostToolUse: [{ hooks: [h(120)] }],
      PostToolUseFailure: [{ hooks: [h(120)] }],
      CwdChanged: [{ hooks: [h(10)] }],
      Stop: [{ hooks: [h(30)] }],
      StopFailure: [{ hooks: [h(30)] }],
      Notification: [{ hooks: [h(10)] }],
      SessionEnd: [{ hooks: [h(5)] }],
    },
    ...(opts.statusLine
      ? {
          statusLine: {
            type: "command" as const,
            command: statusLineTeeCommand(opts.statusLine),
            ...(opts.statusLine.padding !== undefined ? { padding: opts.statusLine.padding } : {}),
            ...(opts.statusLine.refreshInterval !== undefined ? { refreshInterval: opts.statusLine.refreshInterval } : {}),
          },
        }
      : {}),
  };
}

/**
 * A CLI conversation id a terminal chat may run: a UUID, as the CLI makes them. A hook's `session_id` (any process holding
 * the token can post one) or a stored `cliSessionId` that is anything else is ignored, so it never reaches the argv.
 */
export const CLI_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCliSessionId(v: unknown): v is string {
  return typeof v === "string" && CLI_SESSION_ID_RE.test(v);
}

/**
 * `claude --session-id=<id>|--resume=<id> [--mcp-config <file>] --settings <json> --append-system-prompt <…>` — the user's
 * own claude otherwise. The id is joined to its flag, so whatever it holds it is that flag's value, never an option of its
 * own. §57.11: `--mcp-config` takes several values (variadic), so a flag follows its file.
 */
export function terminalArgv(a: { claude: string; id: string; resume: boolean; settingsJson: string; mcpConfigFile?: string | null }): string[] {
  return [
    a.claude, `${a.resume ? "--resume" : "--session-id"}=${a.id}`,
    ...(a.mcpConfigFile ? ["--mcp-config", a.mcpConfigFile] : []),
    "--settings", a.settingsJson, "--append-system-prompt", TERMINAL_SYSTEM_APPEND,
  ];
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
