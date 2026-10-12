import { spawn, type ChildProcess } from "node:child_process";
import {
  query,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { Platform } from "../platform/index.js";
import { isReadOnlyCommand } from "../session/bashClass.js";
import { resolveClaudeExecutable } from "../session/claude.js";
import type { SessionLog } from "../session/events.js";
import { AsyncQueue } from "../session/queue.js";
import { PREVIEW_CHARS } from "../session/toolOutput.js";
import { matchesToolPattern, type UserRules } from "../session/permissionRules.js";
import { SIDE_WEB_MODES, type SideWebMode } from "../protocol.js";

/**
 * One question of a side thread (docs/PROTOCOL.md §21): a separate, short-lived Claude CLI process that
 * forks the main conversation (or resumes the side session for a follow-up), answers once and exits.
 * It never touches the main session: own process, own session id, own hooks — and it is read-only.
 */

/** Tools a side session may use without asking: reading the repository, and (unless off) the web. */
export const SIDE_READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoRead", "TodoWrite", "ToolSearch", "Skill"]);
export const SIDE_WEB_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"]);
/** §36.13: tools a read-only fork may be given on top (`SideQueryOptions.extraTools`): they report, they change nothing. */
export const SIDE_REPORT_TOOLS: ReadonlySet<string> = new Set(["ReportFindings"]);

export const SIDE_READ_ONLY_REASON =
  "ReviewGate: this is a side question (곁질문) — a read-only Q&A next to the main conversation. Files may not be changed and " +
  "no agents, MCP tools or mutating commands may run here. Answer with read-only tools, and propose any change in text " +
  "(file, line, what to change); the user can send it to the main conversation.";

/**
 * §40.3 (wave4b w4b-side): why a web call is refused — the web is off for side questions, or the site is not in the user's
 * allow rules. Starts like `SIDE_READ_ONLY_REASON` (the thread marks the call `denied` by that prefix).
 */
export const SIDE_WEB_OFF_REASON =
  "ReviewGate: this is a side question (곁질문) — the web is off here (ReviewGate Settings › Side questions), or this site is not " +
  "in the user's Claude Code allow rules. Answer from the code and the conversation; name the page instead of opening it.";

/** §40.3: a web call the side session may make without "any site" (`SideQueryOptions.webAllowed`). */
export type SideWebAllowed = (toolName: string, input: Record<string, unknown>) => boolean;

/**
 * §40.3: `settings.sideWeb`, `off` when absent or unknown. `sideAllowWeb` no longer turns the web on: both clients sent
 * `true` as their default, so it never meant the user chose it.
 */
export function sideWebMode(s: { sideWeb?: unknown; sideAllowWeb?: unknown }): SideWebMode {
  return typeof s.sideWeb === "string" && (SIDE_WEB_MODES as readonly string[]).includes(s.sideWeb) ? (s.sideWeb as SideWebMode) : "off";
}

/**
 * §40.3 `sideWeb: "rules"`: a web call the user already allows without a card — their `WebFetch(domain:…)` / `WebSearch`
 * allow rules (§33.5, deny / ask rules win) or the app's "always allow" patterns (§33.6). Never another tool.
 */
export function sideWebRuleAllows(toolName: string, input: Record<string, unknown>, rules: UserRules, appPatterns: readonly string[]): boolean {
  if (!SIDE_WEB_TOOLS.has(toolName)) return false;
  if (rules.block.some((p) => matchesToolPattern(p, toolName, input))) return false;
  return rules.allow.some((p) => matchesToolPattern(p, toolName, input)) || appPatterns.some((p) => matchesToolPattern(p, toolName, input));
}

export const SIDE_SYSTEM_PROMPT =
  "You are answering a side question (곁질문) about the coding session above, in a separate read-only thread. " +
  "The main conversation continues independently and does not see this thread. Do not modify files, run mutating " +
  "commands or start agents — those calls are refused. Read code with read-only tools if needed and answer concisely. " +
  "If a change would help, describe it precisely in text (file, line, what to change) instead of making it.";

/**
 * Why the side policy refuses `toolName`, or `undefined` when it may run (no permission card ever). §36.13 (wave3
 * engine-flow): `extraTools` names tools that only report (the pre-review fork's `ReportFindings`); nothing else widens.
 */
export function sideToolDenyReason(toolName: string, input: Record<string, unknown>, opts: { allowWeb: boolean; extraTools?: readonly string[]; webAllowed?: SideWebAllowed }): string | undefined {
  if (SIDE_READ_TOOLS.has(toolName)) return undefined;
  if (opts.extraTools?.includes(toolName) && SIDE_REPORT_TOOLS.has(toolName)) return undefined;
  // §40.3: any site with the web on; with `rules` only what the user's allow rules allow; else none.
  if (SIDE_WEB_TOOLS.has(toolName)) return opts.allowWeb || opts.webAllowed?.(toolName, input) === true ? undefined : SIDE_WEB_OFF_REASON;
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (input.run_in_background === true) return SIDE_READ_ONLY_REASON;
    return isReadOnlyCommand(command) ? undefined : SIDE_READ_ONLY_REASON;
  }
  return SIDE_READ_ONLY_REASON;
}

export type SideQueryEvent =
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; isError: boolean; preview: string }
  | { type: "denied"; toolName: string };

export type SideQueryOptions = {
  cwd: string;
  claudePath: string;
  env: Record<string, string | undefined>;
  platform: Pick<Platform, "killTree" | "isWindows">;
  model?: string;
  settingSources: ("user" | "project")[];
  skills?: "all";
  /** Flag-settings layer (`disableAllHooks`, `enabledPlugins`). */
  flagSettings?: Record<string, unknown>;
  /** Main session to fork (first question). */
  forkFrom?: string;
  /** Chain uuid to fork at (with `forkFrom`). */
  forkAt?: string;
  /** Side session to continue (follow-up). */
  resume?: string;
  /** Pre-chosen id of a NEW side session (fork or fresh). */
  sessionId?: string;
  prompt: string;
  allowWeb: boolean;
  /** §40.3 (wave4b w4b-side): with `allowWeb` false, the web calls that may still run (the user's allow rules). */
  webAllowed?: SideWebAllowed;
  emit: (ev: SideQueryEvent) => void;
  log: SessionLog;
  queryFn?: typeof query;
  // MARK: wave3 engine-flow — §36.11 / §36.13 one-shot forks (commit draft, pre-review)
  /** Report-only tools allowed on top of the read-only set (`SIDE_REPORT_TOOLS` members only). */
  extraTools?: string[];
  /** false: the CLI keeps no session file (a one-shot fork nobody resumes). */
  persistSession?: false;
  /** Default 30. */
  maxTurns?: number;
  /** Replaces `SIDE_SYSTEM_PROMPT` as the system-prompt append. */
  system?: string;
};

export type SideQueryResult = {
  sessionId: string | null;
  text: string;
  costUSD: number;
  durationMs: number;
  stopReason: string;
  /** Set when the CLI failed (no result, an error result, a crash). */
  error: string | null;
  /** Something came back from the CLI (init / text / tool) before it ended. */
  sawOutput: boolean;
};

const DISPOSE_CAP_MS = 2500;
const KILL_AFTER_ABORT_MS = 1000;

export class SideQuery {
  private readonly opts: SideQueryOptions;
  private readonly inbox = new AsyncQueue<SDKUserMessage>();
  private readonly abort = new AbortController();
  private q: Query | undefined;
  private child: ChildProcess | undefined;
  private interrupted = false;
  private disposed: Promise<void> | undefined;
  private sessionId: string | null = null;
  private text = "";
  private sawOutput = false;
  /** Text streamed per API message id (the `assistant` message re-delivers it; only the unstreamed rest is emitted). */
  private streamed = new Map<string, string>();
  private streamingMessageId = "";

  constructor(opts: SideQueryOptions) {
    this.opts = opts;
  }

  /** The exact SDK options (exposed for tests). */
  queryOptions(): Options {
    const o = this.opts;
    const env: Record<string, string | undefined> = { ...process.env, ...o.env };
    // Same as the main session (§13): nothing may outlive the question in the background.
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ??= "1";
    const exe = resolveClaudeExecutable(o.claudePath, o.platform.isWindows);
    const deny = (reason: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
    const pre: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const ti = (input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {}) as Record<string, unknown>;
      const reason = sideToolDenyReason(input.tool_name, ti, { allowWeb: o.allowWeb, ...(o.extraTools ? { extraTools: o.extraTools } : {}), ...(o.webAllowed ? { webAllowed: o.webAllowed } : {}) });
      if (reason) {
        o.emit({ type: "denied", toolName: input.tool_name });
        return deny(reason);
      }
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "ReviewGate: read-only (side question)" } };
    };
    const fork = o.resume === undefined && o.forkFrom !== undefined;
    return {
      cwd: o.cwd,
      abortController: this.abort,
      pathToClaudeCodeExecutable: exe.path,
      ...(exe.executable ? { executable: exe.executable as "node", executableArgs: [] } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: o.system ?? SIDE_SYSTEM_PROMPT },
      permissionMode: "default",
      settingSources: o.settingSources,
      ...(o.skills ? { skills: o.skills } : {}),
      // §29 (audit peer-06): a one-question CLI never takes a message from the user's other sessions (it would end the thread).
      settings: { ...(o.flagSettings ?? {}), crossSessionInbound: "refuse" },
      // No MCP servers in side sessions (their tools are refused anyway; starting them is slow and may have side effects).
      mcpServers: {},
      strictMcpConfig: true,
      includePartialMessages: true,
      maxTurns: o.maxTurns ?? 30,
      ...(o.persistSession === false ? { persistSession: false } : {}),
      hooks: { PreToolUse: [{ hooks: [pre] }] },
      canUseTool: this.canUseTool,
      ...(o.resume !== undefined ? { resume: o.resume } : {}),
      ...(fork ? { resume: o.forkFrom, forkSession: true, ...(o.forkAt ? { resumeSessionAt: o.forkAt } : {}) } : {}),
      ...(o.resume === undefined && o.sessionId ? { sessionId: o.sessionId } : {}),
      ...(o.model ? { model: o.model } : {}),
      env: exe.env ? { ...env, ...exe.env } : env,
      spawnClaudeCodeProcess: (so) => this.spawn(so),
    };
  }

  private readonly canUseTool: CanUseTool = async (toolName, input) => {
    const reason = sideToolDenyReason(toolName, input, { allowWeb: this.opts.allowWeb, ...(this.opts.extraTools ? { extraTools: this.opts.extraTools } : {}), ...(this.opts.webAllowed ? { webAllowed: this.opts.webAllowed } : {}) });
    if (reason) {
      this.opts.emit({ type: "denied", toolName });
      return { behavior: "deny", message: reason };
    }
    return { behavior: "allow", updatedInput: input };
  };

  /** Runs the question to its end (never throws). */
  async run(): Promise<SideQueryResult> {
    const startedAt = Date.now();
    let costUSD = 0;
    let durationMs = 0;
    let stopReason = "ended";
    let error: string | null = null;
    let gotResult = false;
    try {
      this.q = (this.opts.queryFn ?? query)({ prompt: this.inbox, options: this.queryOptions() });
      this.inbox.push({ type: "user", message: { role: "user", content: this.opts.prompt }, parent_tool_use_id: null, session_id: "" });
      for await (const m of this.q) {
        if (m.type === "result") {
          gotResult = true;
          this.sessionId = m.session_id || this.sessionId;
          costUSD = m.total_cost_usd ?? 0;
          durationMs = m.duration_ms ?? Date.now() - startedAt;
          stopReason = this.interrupted ? "interrupted" : m.subtype;
          if (m.subtype !== "success") error = this.interrupted ? null : ((m as { errors?: string[] }).errors ?? []).join("\n") || m.subtype;
          else if (m.is_error) error = typeof m.result === "string" && m.result ? m.result : "error";
          this.inbox.end(); // one question per process: the CLI exits after its answer
          continue;
        }
        this.handle(m);
      }
    } catch (e) {
      if (!this.interrupted) error = e instanceof Error ? e.message : String(e);
      stopReason = this.interrupted ? "interrupted" : "error";
    } finally {
      await this.dispose();
    }
    if (!gotResult && error === null && !this.interrupted) error = "the side session ended without an answer";
    if (this.interrupted) stopReason = "interrupted";
    return { sessionId: this.sessionId, text: this.text.trim(), costUSD, durationMs: durationMs || Date.now() - startedAt, stopReason, error, sawOutput: this.sawOutput };
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    try {
      await this.q?.interrupt();
    } catch (e) {
      this.opts.log("debug", `side interrupt: ${String(e)}`);
    }
    this.inbox.end();
  }

  dispose(): Promise<void> {
    if (!this.disposed) this.disposed = this.doDispose();
    return this.disposed;
  }

  private async doDispose(): Promise<void> {
    this.inbox.end();
    this.abort.abort();
    const child = this.child;
    const alive = () => !!child && child.exitCode === null && child.signalCode === null;
    const killTimer = setTimeout(() => {
      if (alive() && child?.pid) {
        void this.opts.platform.killTree(child.pid);
        child.kill("SIGKILL");
      }
    }, KILL_AFTER_ABORT_MS);
    killTimer.unref?.();
    const exited = new Promise<void>((r) => (alive() ? child!.once("exit", () => r()) : r()));
    const closed = (this.q?.return?.(undefined) ?? Promise.resolve()).then(() => {}, () => {});
    await Promise.race([Promise.all([exited, closed]).then(() => {}), new Promise<void>((r) => setTimeout(r, DISPOSE_CAP_MS).unref?.())]);
    clearTimeout(killTimer);
    if (alive() && child?.pid) {
      void this.opts.platform.killTree(child.pid);
      child.kill("SIGKILL");
    }
  }

  private handle(m: SDKMessage): void {
    const emit = this.opts.emit;
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          this.sawOutput = true;
          this.sessionId = m.session_id;
          emit({ type: "session", sessionId: m.session_id });
        }
        return;
      case "stream_event": {
        if (m.parent_tool_use_id !== null) return;
        const ev = m.event;
        if (ev.type === "message_start") this.streamingMessageId = ev.message.id;
        else if (ev.type === "content_block_start" && ev.content_block.type === "text" && this.text && !this.text.endsWith("\n")) {
          // A new text block (after a tool call): keep the answer's paragraphs apart.
          this.text += "\n\n";
          emit({ type: "text_delta", text: "\n\n" });
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          this.sawOutput = true;
          this.streamed.set(this.streamingMessageId, (this.streamed.get(this.streamingMessageId) ?? "") + ev.delta.text);
          this.text += ev.delta.text;
          emit({ type: "text_delta", text: ev.delta.text });
        }
        return;
      }
      case "assistant": {
        if (m.parent_tool_use_id !== null) return;
        const content = Array.isArray(m.message.content) ? m.message.content : [];
        let seen = this.streamed.get(m.message.id) ?? "";
        for (const block of content) {
          if (block.type === "text") {
            // Emit what the stream did not deliver (a non-streamed message, a cut stream).
            if (seen.length >= block.text.length && seen.startsWith(block.text)) {
              seen = seen.slice(block.text.length);
              continue;
            }
            const tail = block.text.startsWith(seen) ? block.text.slice(seen.length) : block.text;
            seen = "";
            if (tail) {
              this.sawOutput = true;
              const sep = this.text && !this.text.endsWith("\n") && tail === block.text ? "\n\n" : "";
              this.text += sep + tail;
              emit({ type: "text_delta", text: sep + tail });
            }
          } else if (block.type === "tool_use") {
            this.sawOutput = true;
            const input = (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>;
            emit({ type: "tool_use", id: block.id, name: block.name, input });
          }
        }
        this.streamed.delete(m.message.id);
        return;
      }
      case "user": {
        if (m.parent_tool_use_id !== null) return;
        const content = m.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const text = resultText(block.content);
          emit({ type: "tool_result", toolUseId: block.tool_use_id, isError: block.is_error === true, preview: text.slice(0, PREVIEW_CHARS) });
        }
        return;
      }
      default:
        return;
    }
  }

  private spawn(so: SpawnOptions): SpawnedProcess {
    const child = spawn(so.command, so.args, { cwd: so.cwd, env: so.env, stdio: ["pipe", "pipe", "pipe"], signal: so.signal, windowsHide: true });
    this.child = child;
    let tail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (tail = (tail + c).slice(-2048)));
    child.stderr.on("error", () => {});
    child.once("close", (code, signal) => {
      if ((code !== 0 || signal) && tail.trim() && !this.interrupted) this.opts.log("warn", `side claude exited (code=${code} signal=${signal}): ${tail.trim()}`);
    });
    return child;
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : JSON.stringify(b))).join("\n");
  return content === undefined ? "" : JSON.stringify(content);
}
