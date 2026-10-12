// MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the stdin a status line command reads, in Claude Code's shape.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RateLimitWindow } from "../src/protocol.js";
import { buildStatusLineInput, contextWindowOf, gitWorktreeName, lastTranscriptUsage, modelDisplayName, modelTakesEffort, rateLimitsOf, repoOfRemote, usedPercentage, type StatusLineSnapshot } from "../src/statusline/input.js";
import { STATIC_MODELS } from "../src/session/models.js";
import { ContextWindows } from "../src/statusline/contextWindows.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

const NOW = Date.parse("2026-10-26T02:00:00Z");

function snapshot(over: Partial<StatusLineSnapshot> = {}): StatusLineSnapshot {
  return {
    sessionId: "11111111-2222-3333-4444-555555555555",
    sessionName: "ReviewGate · repo",
    transcriptPath: "/cfg/projects/-work-repo/11111111-2222-3333-4444-555555555555.jsonl",
    cwd: "/work/repo",
    projectDir: "/work/repo",
    gitWorktree: null,
    repo: { host: "github.com", owner: "acme", name: "reviewgate" },
    model: { id: "claude-opus-5-5", displayName: "Opus 5.5" },
    version: "2.1.310",
    outputStyle: "default",
    costUsd: 0.46,
    durationMs: 540_000,
    apiDurationMs: 61_000,
    linesAdded: 156,
    linesRemoved: 23,
    usage: { input_tokens: 8, output_tokens: 1200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 9000 },
    contextWindowSize: 200_000,
    effort: "high",
    thinkingEnabled: true,
    fastMode: false,
    rateLimits: [],
    nowMs: NOW,
    ...over,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("status line stdin (§44.2)", () => {
  it("carries the CLI's fields in the CLI's order", () => {
    const input = buildStatusLineInput(snapshot());
    expect(Object.keys(input)).toEqual([
      "session_id", "transcript_path", "cwd", "effort", "session_name", "model", "workspace", "version", "output_style", "cost",
      "context_window", "exceeds_200k_tokens", "fast_mode", "thinking",
    ]);
    expect(input).toEqual({
      session_id: "11111111-2222-3333-4444-555555555555",
      transcript_path: "/cfg/projects/-work-repo/11111111-2222-3333-4444-555555555555.jsonl",
      cwd: "/work/repo",
      effort: { level: "high" },
      session_name: "ReviewGate · repo",
      model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
      workspace: { current_dir: "/work/repo", project_dir: "/work/repo", added_dirs: [], repo: { host: "github.com", owner: "acme", name: "reviewgate" } },
      version: "2.1.310",
      output_style: { name: "default" },
      cost: { total_cost_usd: 0.46, total_duration_ms: 540_000, total_api_duration_ms: 61_000, total_lines_added: 156, total_lines_removed: 23 },
      context_window: {
        total_input_tokens: 14_008,
        total_output_tokens: 1200,
        context_window_size: 200_000,
        current_usage: { input_tokens: 8, output_tokens: 1200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 9000 },
        used_percentage: 7,
        remaining_percentage: 93,
      },
      exceeds_200k_tokens: false,
      fast_mode: false,
      thinking: { enabled: true },
    });
  });

  it("no answer yet: an empty context window with null percentages; no effort for a model without it", () => {
    const input = buildStatusLineInput(snapshot({ usage: null, effort: null, sessionName: null, repo: null, gitWorktree: "agent-a58b" }));
    expect(input.context_window).toEqual({ total_input_tokens: 0, total_output_tokens: 0, context_window_size: 200_000, current_usage: null, used_percentage: null, remaining_percentage: null });
    expect(input).not.toHaveProperty("effort");
    expect(input).not.toHaveProperty("session_name");
    expect(input.workspace).toEqual({ current_dir: "/work/repo", project_dir: "/work/repo", added_dirs: [], git_worktree: "agent-a58b" });
  });

  it("the percentage is of the input the last answer read, clamped; exceeds_200k counts its output too", () => {
    expect(contextWindowOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 250_000 }, 200_000)).toMatchObject({ used_percentage: 100, remaining_percentage: 0 });
    expect(contextWindowOf({ input_tokens: 999, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, 1_000_000)).toMatchObject({ used_percentage: 0, remaining_percentage: 100 });
    const big = buildStatusLineInput(snapshot({ usage: { input_tokens: 1, output_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 198_000 } }));
    expect(big.exceeds_200k_tokens).toBe(true);
  });

  it("rate_limits: the five-hour and seven-day windows with a percentage, resets in epoch seconds, none that reset already", () => {
    const windows: RateLimitWindow[] = [
      { kind: "five_hour", status: "allowed", percent: 7, resetsAt: "2026-10-26T05:34:00.000Z", at: "2026-10-26T01:59:00.000Z" },
      { kind: "seven_day", status: "allowed_warning", percent: 44, resetsAt: "2026-10-30T08:00:00.000Z", at: "2026-10-26T01:59:00.000Z" },
      { kind: "seven_day_opus", status: "allowed", percent: 12, at: "2026-10-26T01:59:00.000Z" },
    ];
    expect(buildStatusLineInput(snapshot({ rateLimits: windows })).rate_limits).toEqual({
      five_hour: { used_percentage: 7, resets_at: Date.parse("2026-10-26T05:34:00Z") / 1000 },
      seven_day: { used_percentage: 44, resets_at: Date.parse("2026-10-30T08:00:00Z") / 1000 },
    });
    expect(rateLimitsOf([{ ...windows[0]!, resetsAt: "2026-10-26T01:00:00.000Z" }], NOW)).toBeNull();
    expect(rateLimitsOf([{ kind: "five_hour", status: "rejected", at: "x" }], NOW)).toBeNull();
    expect(buildStatusLineInput(snapshot())).not.toHaveProperty("rate_limits");
  });

  it("used_percentage is the CLI's: the utilization with one decimal, at most 100; the whole percent without it", () => {
    expect(usedPercentage({ percent: 82, utilization: 0.8234 })).toBe(82.3);
    expect(usedPercentage({ percent: 0, utilization: 0.0004 })).toBe(0);
    expect(usedPercentage({ percent: 100, utilization: 1.0 })).toBe(100);
    expect(usedPercentage({ percent: 100, utilization: 104.56 })).toBe(100); // above 1: a percentage already, still ≤ 100
    expect(usedPercentage({ percent: 41, utilization: 41.25 })).toBe(41.3);
    expect(usedPercentage({ percent: 7 })).toBe(7);
    expect(usedPercentage({})).toBeNull();
    const w: RateLimitWindow = { kind: "five_hour", status: "allowed", percent: 82, utilization: 0.8234, resetsAt: "2026-10-26T05:34:00.000Z", at: "x" };
    expect(rateLimitsOf([w], NOW)).toEqual({ five_hour: { used_percentage: 82.3, resets_at: Date.parse("2026-10-26T05:34:00Z") / 1000 } });
  });

  it("display names as the CLI shows them", () => {
    expect(modelDisplayName("claude-opus-5-5", STATIC_MODELS)).toBe("Opus 5.5");
    expect(modelDisplayName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelDisplayName("claude-opus-4-7[1m]")).toBe("Opus 4.7 (1M context)");
    expect(modelDisplayName("claude-opus-4-20250514")).toBe("Opus 4");
    expect(modelDisplayName("claude-3-5-haiku-20241022")).toBe("Haiku 3.5");
    expect(modelDisplayName("claude-sonnet-5-5", [{ value: "default", displayName: "Default (recommended)", description: "", resolvedModel: "claude-sonnet-5-5" }])).toBe("Sonnet 5.5");
    expect(modelDisplayName("my-proxy-model")).toBe("my-proxy-model");
  });

  it("effort only for models that take it", () => {
    expect(modelTakesEffort("claude-opus-5-5", STATIC_MODELS)).toBe(true);
    expect(modelTakesEffort("claude-haiku-4-5")).toBe(false);
    expect(modelTakesEffort("claude-sonnet-4-5-20250929")).toBe(false);
    expect(modelTakesEffort("claude-3-7-sonnet-20250219")).toBe(false);
    expect(modelTakesEffort("claude-opus-4-7")).toBe(true);
  });

  it("workspace.repo from the remote; git_worktree from a linked worktree's .git file", () => {
    expect(repoOfRemote("git@ghe.example.com:acme/app.git")).toEqual({ host: "ghe.example.com", owner: "acme", name: "app" });
    expect(repoOfRemote("https://github.com/anthropics/claude-code")).toEqual({ host: "github.com", owner: "anthropics", name: "claude-code" });
    expect(repoOfRemote("ssh://git@host:2222/o/n.git")).toEqual({ host: "host", owner: "o", name: "n" });
    expect(repoOfRemote(null)).toBeNull();
    expect(repoOfRemote("/local/bare.git")).toBeNull();

    const root = makeTempDir("rg-sl-wt");
    dirs.push(root);
    const linked = join(root, "wt");
    mkdirSync(linked);
    writeFileSync(join(linked, ".git"), `gitdir: ${join(root, "main", ".git", "worktrees", "agent-a58b")}\n`);
    expect(gitWorktreeName(linked)).toBe("agent-a58b");
    const main = join(root, "main");
    mkdirSync(join(main, ".git"), { recursive: true });
    expect(gitWorktreeName(main)).toBeNull();
    expect(gitWorktreeName(join(root, "none"))).toBeNull();
  });

  it("a resumed chat's last main answer is read from the transcript's end (no sidechain, no synthetic)", () => {
    const dir = makeTempDir("rg-sl-tr");
    dirs.push(dir);
    const file = join(dir, "s.jsonl");
    const row = (o: unknown) => JSON.stringify(o);
    writeFileSync(
      file,
      [
        row({ type: "user", message: { content: "hi" } }),
        row({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 3, output_tokens: 40, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 } } }),
        row({ type: "assistant", isSidechain: true, message: { model: "claude-haiku-5-5", usage: { input_tokens: 9, output_tokens: 9 } } }),
        row({ type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } }),
        "{ cut",
      ].join("\n") + "\n",
    );
    expect(lastTranscriptUsage(file)).toEqual({ model: "claude-opus-5-5", usage: { input_tokens: 3, output_tokens: 40, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 } });
    expect(lastTranscriptUsage(join(dir, "missing.jsonl"))).toBeNull();
  });

  it("a compaction after the last answer is the context: its postTokens, not the answer before it", () => {
    const dir = makeTempDir("rg-sl-cb");
    dirs.push(dir);
    const file = join(dir, "s.jsonl");
    const row = (o: unknown) => JSON.stringify(o);
    const answer = row({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 2, output_tokens: 977, cache_creation_input_tokens: 531, cache_read_input_tokens: 183_030 } } });
    const boundary = row({ type: "system", subtype: "compact_boundary", isSidechain: false, compactMetadata: { trigger: "manual", preTokens: 184_867, postTokens: 15_093 } });
    writeFileSync(file, [answer, boundary, row({ type: "user", message: { content: "summary" } })].join("\n") + "\n");
    expect(lastTranscriptUsage(file)).toEqual({ model: null, usage: { input_tokens: 15_093, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    // An answer after the compaction is the context again.
    const later = row({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 50_000 } } });
    writeFileSync(file, [answer, boundary, later].join("\n") + "\n");
    expect(lastTranscriptUsage(file)?.usage.cache_read_input_tokens).toBe(50_000);
  });

  it("ContextWindows remembers the last window per model, app-wide, [1m] or not", () => {
    const dir = makeTempDir("rg-sl-cw");
    dirs.push(dir);
    const a = new ContextWindows(dir);
    expect(a.get("claude-opus-5-5")).toBeUndefined();
    a.set("claude-opus-5-5", 1_000_000);
    expect(new ContextWindows(dir).get("claude-opus-5-5[1m]")).toBe(1_000_000);
    a.set("claude-opus-5-5", 0); // ignored
    expect(new ContextWindows(dir).get("claude-opus-5-5")).toBe(1_000_000);
  });
});
