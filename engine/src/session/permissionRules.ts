import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionRuleSource, UserPermissionRule } from "../protocol.js";
import { isBroadBashPattern, matchesAllowPattern, matchesAllowPatterns, scanCommand, type ReadOnlyContext } from "./bashClass.js"; // MARK: r2-skills-side (§33.5, M20)

/**
 * The user's Claude Code permission rules and the app's "always allow" patterns beyond Bash (docs/PROTOCOL.md
 * §33.5–33.8). ReviewGate's hooks answer `ask` before the CLI evaluates `permissions.allow`, so those rules never ran in
 * app sessions; here they are read from the settings files and applied — only to tools that cannot change files. Edit
 * tools, Bash and SendMessage keep their review / card (Bash rules can be imported as app patterns instead). Pure.
 */

export type RuleScope = "user" | "project" | "local";
/** One `permissions.allow|deny|ask` entry: `Tool` or `Tool(content)`. */
export type ParsedRule = { tool: string; content: string | null; raw: string };
export type ScopedRule = { rule: string; source: RuleScope };
/**
 * What a session needs: `allow` rules, and `block` = the deny + ask rules (a call they match is never auto-allowed). `bash`
 * (MARK: r2-skills-side — §33.5, M20): the `Bash(…)` allow rules apply too (`settings.applyUserBashRules`).
 */
export type UserRules = { allow: readonly string[]; block: readonly string[]; bash?: boolean };
/** MCP tool annotations from `mcpServerStatus()`, by CLI tool name (`mcp__server__tool`). */
export type McpToolHints = ReadonlyMap<string, { readOnly?: boolean; destructive?: boolean }>;

export function parseRule(raw: unknown): ParsedRule | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const m = /^([^()\s]+)(?:\((.*)\))?$/s.exec(s);
  if (!m) return null;
  return { tool: m[1]!, content: m[2] !== undefined ? m[2] : null, raw: s };
}

/** The CLI's MCP tool name: `mcp__<server>__<tool>`, every character outside `[A-Za-z0-9_-]` replaced by `_` (claude.ai servers: runs collapsed). */
export function mcpToolName(server: string, tool: string): string {
  const norm = (s: string): string => {
    let r = s.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (s.startsWith("claude.ai ")) r = r.replace(/_+/g, "_").replace(/^_|_$/g, "");
    return r;
  };
  return `mcp__${norm(server)}__${norm(tool)}`;
}

/** Words of an MCP tool name that make it a read (any of them, and none of the writes below). */
const READ_WORDS = new Set([
  "get", "list", "search", "read", "query", "find", "fetch", "describe", "show", "view", "lookup", "count", "retrieve", "resolve",
  "explain", "inspect", "browse", "stat", "stats", "status", "info", "diff", "compare", "preview", "summarize", "analyze", "validate",
  "check", "ls", "cat", "head", "tail", "grep", "glob", "whoami", "me",
]);
/** Words that make it a write, whatever else it says. */
const WRITE_WORDS = new Set([
  "create", "update", "delete", "remove", "write", "edit", "set", "add", "insert", "send", "execute", "exec", "run", "drop", "upload",
  "commit", "push", "merge", "apply", "move", "rename", "copy", "publish", "deploy", "start", "stop", "kill", "restart", "cancel",
  "approve", "reject", "close", "assign", "archive", "import", "install", "uninstall", "modify", "change", "save", "store", "register",
  "enable", "disable", "toggle", "grant", "revoke", "invite", "trigger", "schedule", "reply", "comment", "mark", "lock", "unlock",
  "sync", "reset", "clear", "purge", "truncate", "alter", "patch", "replace", "append", "upsert", "submit", "transfer", "pay",
]);

/**
 * Whether an MCP tool only reads: the server's annotations decide when it sent them (`destructive` → no, `readOnly` →
 * yes / no), else its name — a read verb (`get`, `list`, `search`, `query`, …) and no write verb (`create`, `update`,
 * `delete`, `execute`, …). Anything else counts as a write and keeps its card.
 */
export function isReadMcpTool(name: string, hints?: McpToolHints): boolean {
  if (!name.startsWith("mcp__")) return false;
  const h = hints?.get(name);
  if (h?.destructive === true) return false;
  if (h?.readOnly !== undefined) return h.readOnly;
  const tool = name.split("__").slice(2).join("__") || name;
  const words = tool
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
  if (words.some((w) => WRITE_WORDS.has(w))) return false;
  return words.some((w) => READ_WORDS.has(w));
}

/** Tools whose calls cannot change files by themselves (subagents' own calls are gated one by one). */
const NON_MUTATING_TOOLS = new Set([
  "WebSearch", "WebFetch", "Agent", "Task", "ListAgents", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool", "CronList",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", // MARK: wave5 w5-fixes — §43.5: the to-do list tools (TaskStop still asks)
]);
/** Tools the CLI never prompts for in ReviewGate anyway (hooks.ts READ_ONLY_TOOLS — §36.13 ReportFindings too). */
const ALREADY_ALLOWED = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "TodoRead", "NotebookRead", "BashOutput", "KillShell", "ToolSearch", "Skill", "ListAgents", "ReportFindings", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Never auto-allowed by a pattern or a user rule: edits are reviewed, a message can make another session act, worktree / plan tools are the engine's. */
const NEVER_BY_PATTERN = new Set([...EDIT_TOOLS, "SendMessage", "EnterWorktree", "ExitWorktree", "Workflow", "ExitPlanMode", "EnterPlanMode"]);

const isSubagentTool = (t: string): boolean => t === "Agent" || t === "Task";

/**
 * Whether "세션 동안 허용" (`permission_response { remember: true }`) may store a key for `toolName`, and a stored key
 * may answer its calls later. Never for the tools no pattern covers either (edits are reviewed, a message can make
 * another session act — §33.2 keeps SendMessage's card —, worktree / plan tools are the engine's) nor for a question,
 * which needs its answer. A key an older client stored for one of them (state, allows.json) answers nothing.
 */
export function rememberable(toolName: string): boolean {
  return toolName === "Bash" || (!NEVER_BY_PATTERN.has(toolName) && toolName !== "AskUserQuestion");
}

function globMatch(pattern: string, s: string): boolean {
  const re = "^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
  return new RegExp(re, "s").test(s);
}

/** `mcp__server` (every tool of it), `mcp__server__tool`, or a `*` glob over the name. */
function mcpRuleMatches(ruleTool: string, toolName: string): boolean {
  if (!toolName.startsWith("mcp__")) return false;
  if (ruleTool.includes("*")) return globMatch(ruleTool, toolName);
  if (ruleTool.slice(5).includes("__")) return ruleTool === toolName;
  return toolName.startsWith(`${ruleTool}__`);
}

/** `domain:host`, `domain:*.example.com` (subdomains), `domain:*` against a URL's host (case-insensitive, like the CLI). */
export function domainMatches(content: string, url: unknown): boolean {
  if (!content.startsWith("domain:") || typeof url !== "string") return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const want = content.slice(7).trim().toLowerCase().replace(/\.+$/, "");
  if (want === "*") return true;
  if (want.startsWith("*.")) return host.endsWith(want.slice(1)) && host.length > want.length - 1;
  return host === want;
}

/**
 * An app allow pattern (`settings.bashAllowPatterns`, §33.6) or a user rule against a non-Bash call: `mcp__server__tool`,
 * `mcp__server__*` / `mcp__server`, `WebFetch` / `WebFetch(domain:x)`, `WebSearch`, `Agent` / `Task` (+ `(subagent_type)`),
 * or another tool's bare name. Never Bash (bashClass `matchesAllowPattern`), edit tools, SendMessage or the worktree /
 * plan tools.
 */
export function matchesToolPattern(pattern: string, toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "Bash" || NEVER_BY_PATTERN.has(toolName)) return false;
  const r = parseRule(pattern);
  if (!r) return false;
  if (r.tool.startsWith("mcp__")) return r.content === null && mcpRuleMatches(r.tool, toolName);
  const sameTool = r.tool === toolName || (isSubagentTool(r.tool) && isSubagentTool(toolName));
  if (!sameTool) return false;
  if (r.content === null || r.content.trim() === "" || r.content.trim() === "*") return true;
  if (toolName === "WebFetch") return domainMatches(r.content.trim(), input.url);
  if (isSubagentTool(toolName)) return input.subagent_type === r.content.trim();
  return false;
}

/** The tools a user rule may allow (§33.5): the non-mutating set and MCP tools that only read. */
export function userRuleApplies(toolName: string, hints?: McpToolHints): boolean {
  if (toolName.startsWith("mcp__")) return isReadMcpTool(toolName, hints);
  return NON_MUTATING_TOOLS.has(toolName);
}

/** `Bash` / `Bash(…)`: a rule about shell commands. */
function isBashRule(rule: string): boolean {
  return parseRule(rule)?.tool === "Bash";
}

/**
 * MARK: r2-skills-side — §33.5 (M20): the user's / project's `Bash(…)` allow rules count like the app's allow patterns
 * (`matchesAllowPattern`, §19.3: every simple command must match; `ctx` lets a leading `cd` into the repository go) while
 * `rules.bash` is on. A deny / ask `Bash` rule matching any simple command of the line (a bare `Bash`: every line) blocks it.
 * A bare `Bash` allow rule (every command) never applies — no app pattern does that either —, nor (release-2 review) one
 * that covers every command written another way (`isBroadBashPattern`: `Bash(*)`, `Bash(:*)`, `Bash(sh:*)`).
 */
export function userBashRuleAllows(command: string, rules: UserRules | undefined, ctx?: ReadOnlyContext): boolean {
  if (!rules?.bash) return false;
  const allow = rules.allow.filter((r) => isBashRule(r) && parseRule(r)!.content !== null && !isBroadBashPattern(r));
  if (allow.length === 0) return false;
  if (rules.block.filter(isBashRule).some((r) => bashRuleTouches(r, command))) return false;
  return matchesAllowPatterns(allow, command, ctx);
}

/** A deny / ask Bash rule against any simple command of the line (a line that does not tokenize: blocked to be safe). */
function bashRuleTouches(rule: string, command: string): boolean {
  if (parseRule(rule)!.content === null || !parseRule(rule)!.content!.trim()) return true;
  const segments = scanCommand(command, true)?.segments; // a harmless redirection (`2>&1`) is no command
  if (!segments) return true;
  return segments.some((words) => matchesAllowPattern(rule, words.join(" ")));
}

/** True when the user's `permissions.allow` allows this call and no deny / ask rule of theirs matches it. */
export function userRuleAllows(toolName: string, input: Record<string, unknown>, rules: UserRules | undefined, hints?: McpToolHints): boolean {
  if (!rules || rules.allow.length === 0 || !userRuleApplies(toolName, hints)) return false;
  if (rules.block.some((p) => matchesToolPattern(p, toolName, input))) return false;
  return rules.allow.some((p) => matchesToolPattern(p, toolName, input));
}

/**
 * What a card offers to "always allow in this project" (§33.6), most specific first: the MCP tool and its whole server,
 * the WebFetch domain, or the tool for the other non-mutating tools. Empty for Bash (clients derive `Bash(prog sub:*)`),
 * edit tools, SendMessage and anything else.
 */
export function allowPatternSuggestions(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName.startsWith("mcp__")) {
    const server = toolName.split("__")[1];
    return server ? [toolName, `mcp__${server}__*`] : [toolName];
  }
  if (toolName === "WebFetch") {
    try {
      const host = new URL(String(input.url ?? "")).hostname.toLowerCase();
      return host ? [`WebFetch(domain:${host})`] : [];
    } catch {
      return [];
    }
  }
  return NON_MUTATING_TOOLS.has(toolName) ? [toolName] : [];
}

/** One rule of the CLI's `canUseTool` suggestions (SDK `PermissionUpdate` `addRules`). */
type CliRuleSuggestion = { type?: unknown; behavior?: unknown; rules?: unknown };

/**
 * MARK: r2-skills-side — §33.6 (M21): the CLI's own "don't ask again" rules for this call (`canUseTool`'s
 * `options.suggestions`, SDK `PermissionUpdate[]`) as app patterns, in its order: `addRules` with `behavior: "allow"`, each
 * rule of this very tool (`Bash(npm test:*)`, `mcp__github__get_issue`, `WebFetch(domain:docs.spring.io)`). Dropped: other
 * tools' rules, the tools no app pattern may name (edits, SendMessage, worktree / plan tools), a bare `Bash` and a Bash rule
 * holding a shell operator (no pattern matches through one).
 */
export function cliSuggestionPatterns(toolName: string, suggestions: unknown): string[] {
  if (!Array.isArray(suggestions) || NEVER_BY_PATTERN.has(toolName)) return [];
  const out: string[] = [];
  for (const raw of suggestions as CliRuleSuggestion[]) {
    if (!raw || typeof raw !== "object" || raw.type !== "addRules" || raw.behavior !== "allow" || !Array.isArray(raw.rules)) continue;
    for (const r of raw.rules as { toolName?: unknown; ruleContent?: unknown }[]) {
      if (!r || r.toolName !== toolName) continue;
      const content = typeof r.ruleContent === "string" ? r.ruleContent.trim() : "";
      if (toolName === "Bash" && (!content || /[;&|<>`$()\n]/.test(content))) continue;
      const pattern = content ? `${toolName}(${content})` : toolName;
      if (pattern.length <= 500 && !out.includes(pattern)) out.push(pattern);
    }
  }
  return out;
}

// ------------------------------------------------------------------ settings files (§33.5, §33.8)

export type RuleSource = PermissionRuleSource;
export type LoadedRules = {
  sources: RuleSource[];
  /** Allow rules that apply (user ones only when user settings load), user → project → local. */
  allow: ScopedRule[];
  /** Deny + ask rules of the same files. */
  block: ScopedRule[];
  /** User allow rules left out because user settings are off. */
  userSkipped: ScopedRule[];
  /** MARK: wave3 engine-session — §36.6: local allow rules left out because local settings are off. */
  localSkipped?: ScopedRule[];
  /** `permissions.defaultMode` of the most specific file that sets it (local > project > user). */
  defaultMode: string | null;
};

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
}

/**
 * Reads `<configDir>/settings.json`, `<root>/.claude/settings.json` and `<root>/.claude/settings.local.json`; a broken file
 * is reported, not fatal. §36.6 `loadLocal: false` (local settings off): the local file's rules apply as little as the user
 * file's do without user settings.
 */
export function loadPermissionRules(opts: { configDir: string; root: string; loadUser: boolean; loadLocal?: boolean }): LoadedRules {
  const out: LoadedRules = { sources: [], allow: [], block: [], userSkipped: [], defaultMode: null };
  const loadLocal = opts.loadLocal !== false; // MARK: wave3 engine-session (§36.6)
  const files: [RuleScope, string][] = [
    ["user", join(opts.configDir, "settings.json")],
    ["project", join(opts.root, ".claude", "settings.json")],
    ["local", join(opts.root, ".claude", "settings.local.json")],
  ];
  const modes: Partial<Record<RuleScope, string>> = {};
  for (const [scope, path] of files) {
    const exists = existsSync(path);
    const source: RuleSource = { scope, path, exists };
    out.sources.push(source);
    if (!exists) continue;
    let perms: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { permissions?: unknown } | null;
      const p = parsed && typeof parsed === "object" ? parsed.permissions : undefined;
      perms = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    } catch (e) {
      source.error = e instanceof Error ? e.message : String(e);
      continue;
    }
    const allow = strings(perms.allow).map((rule) => ({ rule, source: scope }));
    // MARK: wave3 engine-session — §36.6: local rules only while local settings load (`defaultMode` is the terminal's anyway).
    if (scope === "local" && !loadLocal) {
      (out.localSkipped ??= []).push(...allow);
      if (typeof perms.defaultMode === "string" && perms.defaultMode.trim()) modes[scope] = perms.defaultMode.trim();
      continue;
    }
    if (scope === "user" && !opts.loadUser) out.userSkipped.push(...allow);
    else out.allow.push(...allow);
    if (scope !== "user" || opts.loadUser) out.block.push(...[...strings(perms.deny), ...strings(perms.ask)].map((rule) => ({ rule, source: scope })));
    if (typeof perms.defaultMode === "string" && perms.defaultMode.trim()) modes[scope] = perms.defaultMode.trim();
  }
  out.defaultMode = modes.local ?? modes.project ?? modes.user ?? null;
  return out;
}

/**
 * Release-2 review (§33.5): a Bash allow rule of the project's shared `.claude/settings.json` — committed with the repository,
 * so a cloned one brings its own (`Bash(curl:*)`) — is not applied: the terminal trusts it only after its workspace-trust
 * question. It can be imported as an app pattern (`permission_rules`: `why: "bash"`). The user's and the local file's apply.
 */
function appliesAsBashRule(r: ScopedRule): boolean {
  return r.source !== "project";
}

/** The rules a session applies: none when the user turned them off; `applyBash` (§33.5 M20): the Bash ones too (not the project's). */
export function sessionUserRules(loaded: LoadedRules, apply: boolean, applyBash = false): UserRules {
  if (!apply) return { allow: [], block: [] };
  const allow = loaded.allow.filter((r) => !isBashRule(r.rule) || appliesAsBashRule(r)).map((r) => r.rule);
  return { allow, block: loaded.block.map((r) => r.rule), ...(applyBash ? { bash: true } : {}) };
}

export type RuleWhy = UserPermissionRule["why"];
/** One row of the `permission_rules` reply (§33.8). */
export type RuleRow = UserPermissionRule;

/** How a rule fares on its own: applied by the engine or not, why, and the app pattern importing it adds. */
function classifyOne(r: ScopedRule, applyBash: boolean): { applied: boolean; why: RuleWhy; importAs: string | null; importWhenOff: string | null } {
  const raw = r.rule;
  const p = parseRule(raw);
  if (!p) return { applied: false, why: "invalid", importAs: null, importWhenOff: null };
  if (p.tool === "Bash") {
    // `Bash(npm test:*)` imports as is (bashClass matchesAllowPattern reads it); a bare `Bash` (every command) does not, nor
    // (release-2 review) one covering every command written another way (`Bash(*)`, `Bash(sh:*)`).
    const pattern = p.content !== null && p.content.trim() && !isBroadBashPattern(raw) ? p.raw : null;
    // MARK: r2-skills-side — §33.5 (M20): with `applyUserBashRules` it applies as it is (nothing to import) — release-2
    // review: not the project's shared file's (`appliesAsBashRule`), which imports instead.
    if (pattern && applyBash && appliesAsBashRule(r)) return { applied: true, why: "bash_rule", importAs: null, importWhenOff: pattern };
    return { applied: false, why: "bash", importAs: pattern, importWhenOff: pattern };
  }
  if (EDIT_TOOLS.has(p.tool)) return { applied: false, why: "edit_tool", importAs: null, importWhenOff: null };
  if (p.tool === "SendMessage") return { applied: false, why: "send_message", importAs: null, importWhenOff: null };
  if (p.tool.startsWith("mcp__")) {
    if (p.content !== null) return { applied: false, why: "unsupported", importAs: null, importWhenOff: null };
    const wide = p.tool.includes("*") || !p.tool.slice(5).includes("__");
    if (wide) {
      const all = p.tool.includes("*") ? p.tool : `${p.tool}__*`;
      return { applied: true, why: "read_mcp_tools", importAs: all, importWhenOff: all };
    }
    return isReadMcpTool(p.tool)
      ? { applied: true, why: "read_mcp_tool", importAs: null, importWhenOff: p.raw }
      : { applied: false, why: "mutating_mcp_tool", importAs: p.raw, importWhenOff: p.raw };
  }
  if (ALREADY_ALLOWED.has(p.tool) && !NON_MUTATING_TOOLS.has(p.tool)) return { applied: true, why: "already_allowed", importAs: null, importWhenOff: null };
  if (NON_MUTATING_TOOLS.has(p.tool)) {
    const supported = p.content === null || p.content.trim() === "" || (p.tool === "WebFetch" && p.content.trim().startsWith("domain:")) || isSubagentTool(p.tool);
    return supported ? { applied: true, why: "non_mutating_tool", importAs: null, importWhenOff: p.raw } : { applied: false, why: "unsupported", importAs: null, importWhenOff: null };
  }
  if (ALREADY_ALLOWED.has(p.tool)) return { applied: true, why: "already_allowed", importAs: null, importWhenOff: null };
  return { applied: false, why: "unsupported", importAs: null, importWhenOff: null };
}

/**
 * The `permission_rules` rows (§33.8): every allow rule, user → project → local, then the user rules skipped because user
 * settings are off (§36.6: then the local ones skipped because local settings are off, `local_settings_off`).
 */
export function classifyRules(loaded: LoadedRules, opts: { applyUserRules: boolean; applyUserBashRules?: boolean }): RuleRow[] {
  const row = (r: ScopedRule, skipped: boolean): RuleRow => {
    const c = classifyOne(r, opts.applyUserBashRules === true);
    if (skipped || (!opts.applyUserRules && c.applied && c.why !== "already_allowed")) {
      return { rule: r.rule, source: r.source, status: "ignored", why: skipped ? (r.source === "local" ? "local_settings_off" : "user_settings_off") : "rules_off", importAs: c.importWhenOff };
    }
    return { rule: r.rule, source: r.source, status: c.applied ? "applied" : "ignored", why: c.why, importAs: c.importAs };
  };
  return [...loaded.allow.map((r) => row(r, false)), ...loaded.userSkipped.map((r) => row(r, true)), ...(loaded.localSkipped ?? []).map((r) => row(r, true))];
}
