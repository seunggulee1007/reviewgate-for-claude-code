/**
 * MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the JSON a status line command reads on stdin.
 *
 * The shape is Claude Code's own (read from the CLI 2.1.310 binary, the same in 2.1.270): the hook base fields, the
 * model, the workspace, the version, the output style, the session's cost, the context window of the last main-agent
 * API answer, effort, thinking and the subscription's usage windows. Filled from what the engine knows; what it does
 * not track is left out the way the CLI leaves out what does not apply (no `vim`, `agent`, `remote`, `pr`, `worktree`,
 * `prompt_cache`). Pure: no file is read here except by `lastTranscriptUsage`.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ModelOption, RateLimitWindow } from "../protocol.js";

/** The usage block of one API answer, as the CLI hands it on (`context_window.current_usage`). */
export type StatusUsage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };

export type StatusLineSnapshot = {
  sessionId: string;
  /** The session's name (`--name`, as the CLI's `session_name`); absent / null: none. */
  sessionName?: string | null;
  transcriptPath: string;
  /** The session's working directory (`cwd`, `workspace.current_dir`) and where it started (`workspace.project_dir`). */
  cwd: string;
  projectDir: string;
  addedDirs?: string[];
  /** The linked worktree's name (`.git/worktrees/<name>`) when `cwd` is one. */
  gitWorktree?: string | null;
  repo?: { host: string; owner: string; name: string } | null;
  model: { id: string; displayName: string };
  version: string;
  outputStyle: string;
  costUsd: number;
  durationMs: number;
  apiDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  /** The last main-agent API answer's usage; null before the first. */
  usage: StatusUsage | null;
  contextWindowSize: number;
  /** The effort level the model runs with; null when the model takes none (the field is left out). */
  effort: string | null;
  thinkingEnabled: boolean;
  fastMode: boolean;
  rateLimits: readonly RateLimitWindow[];
  nowMs: number;
};

/** The CLI's `exceeds_200k_tokens` threshold. */
export const EXCEEDS_TOKENS = 200_000;

/** The CLI's `context_window`: percentages of the window the last answer's input filled (null before one). */
export function contextWindowOf(usage: StatusUsage | null, size: number): Record<string, unknown> {
  const input = usage ? usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens : 0;
  const used = usage && size > 0 ? Math.min(100, Math.max(0, Math.round((input / size) * 100))) : null;
  return {
    total_input_tokens: input,
    total_output_tokens: usage?.output_tokens ?? 0,
    context_window_size: size,
    current_usage: usage ? { ...usage } : null,
    used_percentage: used,
    remaining_percentage: used === null ? null : 100 - used,
  };
}

/**
 * The CLI's `used_percentage` of a window: its utilization with one decimal, at most 100 (`Math.round(u * 1000) / 10`);
 * a utilization above 1 is a percentage already. Without the raw value, the window's whole percent.
 */
export function usedPercentage(w: Pick<RateLimitWindow, "percent" | "utilization">): number | null {
  const u = w.utilization;
  if (typeof u === "number" && Number.isFinite(u) && u >= 0) return Math.min(100, u <= 1 ? Math.round(u * 1000) / 10 : Math.round(u * 10) / 10);
  return w.percent ?? null;
}

/** `rate_limits`: the five-hour and seven-day windows with a known use whose reset is still ahead (seconds since the epoch). */
export function rateLimitsOf(windows: readonly RateLimitWindow[], nowMs: number): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const kind of ["five_hour", "seven_day"] as const) {
    const w = windows.find((x) => x.kind === kind);
    const used = w ? usedPercentage(w) : null;
    if (!w || used === null) continue;
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    if (Number.isFinite(reset) && reset <= nowMs) continue;
    out[kind] = { used_percentage: used, ...(Number.isFinite(reset) ? { resets_at: Math.floor(reset / 1000) } : {}) };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The status line's stdin object, in the CLI's field order. */
export function buildStatusLineInput(s: StatusLineSnapshot): Record<string, unknown> {
  const usage = s.usage;
  const total = usage ? usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens + usage.output_tokens : 0;
  const rateLimits = rateLimitsOf(s.rateLimits, s.nowMs);
  return {
    session_id: s.sessionId,
    transcript_path: s.transcriptPath,
    cwd: s.cwd,
    ...(s.effort !== null ? { effort: { level: s.effort } } : {}),
    ...(s.sessionName ? { session_name: s.sessionName } : {}),
    model: { id: s.model.id, display_name: s.model.displayName },
    workspace: {
      current_dir: s.cwd,
      project_dir: s.projectDir,
      added_dirs: [...(s.addedDirs ?? [])],
      ...(s.gitWorktree ? { git_worktree: s.gitWorktree } : {}),
      ...(s.repo ? { repo: { ...s.repo } } : {}),
    },
    version: s.version,
    output_style: { name: s.outputStyle },
    cost: {
      total_cost_usd: s.costUsd,
      total_duration_ms: Math.max(0, Math.round(s.durationMs)),
      total_api_duration_ms: Math.max(0, Math.round(s.apiDurationMs)),
      total_lines_added: s.linesAdded,
      total_lines_removed: s.linesRemoved,
    },
    context_window: contextWindowOf(usage, s.contextWindowSize),
    exceeds_200k_tokens: total > EXCEEDS_TOKENS,
    fast_mode: s.fastMode,
    thinking: { enabled: s.thinkingEnabled },
    ...(rateLimits ? { rate_limits: rateLimits } : {}),
  };
}

const FAMILIES: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };

/**
 * `model.display_name`: the name the CLI shows ("Opus 5.5", "Sonnet 4.5 (1M context)") — the model list's name for that
 * id when it has a real one, else read off the id (`claude-<family>-<major>-<minor>[-date]`, the older
 * `claude-<major>-<minor>-<family>`), else the id itself.
 */
export function modelDisplayName(id: string, models: readonly ModelOption[] = []): string {
  const oneM = /\[1m\]$/i.test(id);
  const base = id.replace(/\[1m\]$/i, "");
  const listed = models.find((m) => m.value === base || m.resolvedModel === base)?.displayName;
  const suffix = oneM ? " (1M context)" : "";
  if (listed && !/^default\b/i.test(listed) && listed !== base) return listed + suffix;
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(base) ?? null;
  if (m) return `${FAMILIES[m[1]!.toLowerCase()]} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ""}${suffix}`;
  const old = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?$/i.exec(base);
  if (old) return `${FAMILIES[old[3]!.toLowerCase()]} ${old[1]}${old[2] !== undefined ? `.${old[2]}` : ""}${suffix}`;
  return id;
}

/** Models the CLI sends no `effort` for (it does not take the parameter). */
export function modelTakesEffort(id: string, models: readonly ModelOption[] = []): boolean {
  const base = id.replace(/\[1m\]$/i, "");
  const listed = models.find((m) => m.value === base || m.resolvedModel === base);
  if (listed?.supportsEffort !== undefined) return listed.supportsEffort;
  if (/^claude-3-|^claude-\d+-\d+-(opus|sonnet|haiku)/.test(base)) return false;
  return !/^claude-(opus-4-0|opus-4-1|sonnet-4-0|sonnet-4-5|haiku-4-5)(?:-\d{8})?$/.test(base);
}

/** `owner/name` and the host of a `git@host:owner/name(.git)` / `https://host/owner/name(.git)` remote (`workspace.repo`). */
export function repoOfRemote(url: string | null | undefined): { host: string; owner: string; name: string } | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  const scp = /^[^@/:\s]+@([^:/@\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u);
  if (scp) return { host: scp[1]!, owner: scp[2]!, name: scp[3]! };
  const web = /^(?:https?|ssh|git):\/\/(?:[^@/?#]*@)?([^/?#@]+?)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u);
  if (web) return { host: web[1]!, owner: web[2]!, name: web[3]! };
  return null;
}

/**
 * `workspace.git_worktree`: the name of the linked worktree `root` is (its `.git` file points at
 * `<common>/.git/worktrees/<name>`, the CLI's test), null for a main checkout or outside git.
 */
export function gitWorktreeName(root: string): string | null {
  try {
    const dotGit = join(root, ".git");
    if (!statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return null;
    const gitDir = resolve(root, m[1]!);
    return basename(dirname(gitDir)) === "worktrees" ? basename(gitDir) : null;
  } catch {
    return null;
  }
}

/** At most this much of a transcript's end is read for its last usage. */
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

const usageCache = new Map<string, { size: number; mtimeMs: number; usage: StatusUsage | null; model: string | null }>();

/**
 * The last main-agent API answer of a CLI transcript (`<config>/projects/<key>/<id>.jsonl`): its usage and model — what
 * the CLI's status line reads from the conversation it loaded, before this engine saw an answer itself (a resumed chat).
 * Reads at most the file's last 512 KB; null when there is none (or the file cannot be read).
 */
export function lastTranscriptUsage(path: string): { usage: StatusUsage; model: string | null } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const st = fstatSync(fd);
    const hit = usageCache.get(path);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.usage ? { usage: hit.usage, model: hit.model } : null;
    const len = Math.min(st.size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString("utf8").split("\n");
    let found: { usage: StatusUsage; model: string | null } | null = null;
    for (let i = lines.length - 1; i >= 0 && !found; i--) {
      const line = lines[i]!.trim();
      // A compaction after the last answer: the context is what it left (`compactMetadata.postTokens`), not that answer's.
      if (line.startsWith("{") && line.includes('"compact_boundary"')) {
        try {
          const o = JSON.parse(line) as { type?: unknown; subtype?: unknown; isSidechain?: unknown; compactMetadata?: { postTokens?: unknown } };
          const post = o.compactMetadata?.postTokens;
          if (o.type === "system" && o.subtype === "compact_boundary" && o.isSidechain !== true && typeof post === "number" && post >= 0) {
            found = { usage: { input_tokens: post, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, model: null };
          }
        } catch {
          // not JSON
        }
        continue;
      }
      if (!line.startsWith("{") || !line.includes('"assistant"')) continue;
      try {
        const o = JSON.parse(line) as { type?: unknown; isSidechain?: unknown; message?: { usage?: Record<string, unknown>; model?: unknown } };
        const u = o.message?.usage;
        if (o.type !== "assistant" || o.isSidechain === true || !u) continue;
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        if (o.message?.model === "<synthetic>") continue;
        found = {
          usage: { input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens), cache_creation_input_tokens: n(u.cache_creation_input_tokens), cache_read_input_tokens: n(u.cache_read_input_tokens) },
          model: typeof o.message?.model === "string" ? o.message.model : null,
        };
      } catch {
        // a line cut at the start of the tail, or not JSON
      }
    }
    if (usageCache.size > 32) usageCache.clear();
    usageCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, usage: found?.usage ?? null, model: found?.model ?? null });
    return found;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
