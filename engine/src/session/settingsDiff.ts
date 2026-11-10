import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * M22 — docs/PROTOCOL.md §33.9: what an edit tool's change to Claude Code's `settings.json` / `settings.local.json` changes,
 * key by key. Keys that run code (`hooks`, `statusLine`, `apiKeyHelper`, …), widen what Claude may do (`permissions`,
 * `sandbox`, …) or start servers (`mcpServers`, `enabledMcpjsonServers`, …) take effect before the review could reject them,
 * so their change keeps the card; a change limited to the keys below is reviewed afterwards like any edit (the mods group,
 * §32; `local_settings_changed` for settings.local.json). An allow list: a key not named here keeps the card — so does
 * `cleanupPeriodDays`, with which the CLI deletes older chat transcripts (every one at 0) when it next starts, a start that
 * may come before the review (a new chat, a restart).
 */
const HARMLESS_KEYS: ReadonlySet<string> = new Set([
  "$schema", "model", "effortLevel", "alwaysThinkingEnabled", "outputStyle", "language", "theme", "attribution",
  "includeCoAuthoredBy", "includeGitInstructions", "respectGitignore", "verbose", "viewMode", "editorMode",
  "keybindingFlavor", "spinnerTipsEnabled", "spinnerVerbs", "spinnerTipsOverride", "preferredNotifChannel",
  "autoCompactEnabled", "showTurnDuration", "showMessageTimestamps", "showThinkingSummaries", "terminalProgressBarEnabled",
  "todoFeatureEnabled", "prefersReducedMotion", "timeFormat", "timeZone", "syntaxHighlightingDisabled", "spellcheck",
  "feedbackSurveyRate", "companyAnnouncements", "autoUpdatesChannel", "fileCheckpointingEnabled", "autoScrollEnabled",
  "emojiCompletionEnabled", "promptSuggestionEnabled", "terminalTitleFromRename", "bashOutputMaxChars", "taskOutputMaxChars",
  // `env` is compared variable by variable (`RISKY_ENV_RE`).
  "env",
]);

/**
 * Environment variables whose value runs code in what the CLI starts (`NODE_OPTIONS`, `LD_*` / `DYLD_*` preloads, `PATH`,
 * shell / interpreter start files and options, git's helpers), sends Claude's traffic elsewhere (`ANTHROPIC_*`, `*_BASE_URL`,
 * proxies, certificates) or moves Claude Code's own configuration (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_SHELL*`,
 * `CLAUDE_CODE_USE_*`). Release-2 review, also: Claude Code's own variables (`CLAUDE_*`, but `HARMLESS_CLAUDE_ENV`:
 * `CLAUDE_ENV_FILE` is sourced before every Bash command, `CLAUDE_CODE_GIT_BASH_PATH` is Windows' shell,
 * `CLAUDE_CODE_ENABLE_TELEMETRY`), where the CLI looks for its files and credentials (`HOME`, `XDG_*`, `TMPDIR`, `AWS_*`,
 * `GOOGLE_*`, `CLOUDSDK_*`, `AZURE_*`: a `credential_process` or an executable-sourced credential runs when the CLI starts
 * on Bedrock / Vertex), telemetry exporters (`OTEL_*`: `OTEL_LOG_USER_PROMPTS` sends the prompts to another host), the
 * programs other tools start (`EDITOR`, `VISUAL`, `PAGER`, `MANPAGER`, `BROWSER`), package managers' configuration
 * (`NPM_CONFIG_*`, `YARN_*`, `PIP_*`, `UV_*`, `GEM_*`), `SSH_*`, every `PYTHON*` / `PERL*` / `RUBY*`, `IFS`, `CDPATH`,
 * `SHELLOPTS`, `BASHOPTS`, `GCONV_PATH`, `LUA_INIT*` and the CA bundles. Any other variable (`MAVEN_OPTS`,
 * `SPRING_PROFILES_ACTIVE`, `BASH_DEFAULT_TIMEOUT_MS`) is harmless here — it reaches only the commands Claude runs, each
 * judged on its own.
 */
const RISKY_ENV_RE =
  /^(?:PATH|NODE_OPTIONS|NODE_PATH|LD_\w*|DYLD_\w*|BASH_ENV|ENV|ZDOTDIR|SHELL|PROMPT_COMMAND|PYTHON\w*|PERL\w*|RUBY\w*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GIT_\w*|\w*ASKPASS|\w*_PROXY|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_(?:FILE|DIR)|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|ANTHROPIC_\w*|\w*_BASE_URL|CLAUDE_\w*|HOME|XDG_\w*|TMPDIR|TMP|TEMP|AWS_\w*|GOOGLE_\w*|CLOUDSDK_\w*|AZURE_\w*|OTEL_\w*|EDITOR|VISUAL|PAGER|MANPAGER|BROWSER|NPM_CONFIG_\w*|YARN_\w*|PIP_\w*|UV_\w*|GEM_\w*|SSH_\w*|IFS|CDPATH|SHELLOPTS|BASHOPTS|GCONV_PATH|LUA_INIT\w*)$/i;
/** Claude Code's own variables that only limit or quiet it (release-2 review: every other `CLAUDE_*` keeps the card). */
const HARMLESS_CLAUDE_ENV: ReadonlySet<string> = new Set([
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
  "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY",
  "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR",
]);

/** An `env` variable whose change takes effect before the review could reject it (`RISKY_ENV_RE`, `HARMLESS_CLAUDE_ENV`). */
function riskyEnv(name: string): boolean {
  return RISKY_ENV_RE.test(name) && !HARMLESS_CLAUDE_ENV.has(name.toUpperCase());
}

/** Files whose keys are compared: `settings.json` / `settings.local.json` in a `.claude` folder (`.mcp.json`, `~/.claude.json` and a plugin's files are all servers / hooks). */
export function isKeyedSettingsFile(file: string): boolean {
  const name = basename(file).toLowerCase();
  return (name === "settings.json" || name === "settings.local.json") && basename(dirname(file)).toLowerCase() === ".claude";
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "" : null;
  }
}

/** One `old_string` → `new_string` replacement as the Edit tool makes it (the only occurrence, or every one); null when it does not apply. */
function replaced(text: string, edit: unknown): string | null {
  if (!edit || typeof edit !== "object") return null;
  const e = edit as { old_string?: unknown; new_string?: unknown; replace_all?: unknown };
  if (typeof e.old_string !== "string" || typeof e.new_string !== "string") return null;
  if (e.old_string === "") return text === "" ? e.new_string : null;
  const at = text.indexOf(e.old_string);
  if (at === -1) return null;
  if (e.replace_all === true) return text.split(e.old_string).join(e.new_string);
  if (text.indexOf(e.old_string, at + 1) !== -1) return null; // not unique: the tool refuses
  return text.slice(0, at) + e.new_string + text.slice(at + e.old_string.length);
}

/** The file's text after the call (Write's content; Edit / MultiEdit applied to `before`), null when the call does not apply. */
export function textAfter(toolName: string, input: Record<string, unknown>, before: string): string | null {
  if (toolName === "Write") return typeof input.content === "string" ? input.content : null;
  if (toolName === "Edit") return replaced(before, input);
  if (toolName === "MultiEdit") {
    if (!Array.isArray(input.edits) || input.edits.length === 0) return null;
    let text: string | null = before;
    for (const e of input.edits) {
      text = replaced(text, e);
      if (text === null) return null;
    }
    return text;
  }
  return null;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function parseObject(text: string): Record<string, Json> | null {
  if (text.trim() === "") return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : null;
  } catch {
    return null;
  }
}

function same(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as Json[]).length && a.every((x, k) => same(x, (b as Json[])[k]));
  const ka = Object.keys(a);
  const kb = Object.keys(b as Record<string, Json>);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same((a as Record<string, Json>)[k], (b as Record<string, Json>)[k]));
}

/**
 * The keys an edit tool's call to the settings file `file` changes that take effect before the review could reject them —
 * top-level names (`hooks`, `permissions`) and `env.<NAME>` for a risky variable — in the file's order: `[]` when it changes
 * only harmless keys (or nothing), null when that cannot be told (not a `.claude/settings*.json`, not a JSON object before or
 * after, an edit whose text is not there). `read`: the file's text now ("" when it does not exist; test seam).
 */
export function settingsEditRisk(toolName: string, input: Record<string, unknown>, file: string, read: (file: string) => string | null = readText): string[] | null {
  if (!isKeyedSettingsFile(file)) return null;
  const before = read(file);
  if (before === null) return null;
  const after = textAfter(toolName, input, before);
  if (after === null) return null;
  const a = parseObject(before);
  const b = parseObject(after);
  if (!a || !b) return null;
  const risky: string[] = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
    if (same(a[key], b[key])) continue;
    if (key !== "env") {
      if (!HARMLESS_KEYS.has(key)) risky.push(key);
      continue;
    }
    const ea = a.env ?? {};
    const eb = b.env ?? {};
    if (typeof ea !== "object" || typeof eb !== "object" || Array.isArray(ea) || Array.isArray(eb) || ea === null || eb === null) {
      risky.push("env");
      continue;
    }
    for (const name of [...new Set([...Object.keys(ea), ...Object.keys(eb)])]) {
      if (!same(ea[name], eb[name]) && riskyEnv(name)) risky.push(`env.${name}`);
    }
  }
  return risky;
}
