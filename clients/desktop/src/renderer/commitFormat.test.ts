import { describe, expect, it } from "vitest";
import type { CommitFormatEvent } from "@reviewgate/engine";
import { compactedOf, compactedText, ghBlocker, issueFor, learnedSuggestion, loadPRMeta, metaList, prCreateMeta, savePRMeta, teamFormatLine } from "./commitFormat";
import { initI18n } from "./i18n";
import { withAppMeanings } from "./slashBuiltins";

// wave4c w4c-commit — docs/PROTOCOL.md §41.1: the team's format line, the PR sheet's metadata, a compacted turn's row and
// /clear in the palette (as on the Mac, TeamFormatTests.swift).

const reply = (over: Partial<CommitFormatEvent> = {}): CommitFormatEvent => ({
  type: "commit_format",
  learned: "PAY-{issue}: {title} - {summary}",
  kind: "key",
  examples: ["PAY-1400: 주문 마감 - 할인 계산 오류 수정"],
  issue: "1800",
  branch: "feature/PAY-1800-2",
  effective: "PAY-1800: {title} - {summary}",
  source: "learned",
  ...over,
});

describe("team format line", () => {
  it("the project's template wins, else the learned one; {issue} is the reply's for this branch, else the longest number", () => {
    initI18n("en", "darwin");
    expect(teamFormatLine("", "feature/PAY-1800-2", reply())).toEqual({ text: "PAY-1800: {title} - {summary}", learned: true });
    expect(teamFormatLine("[{issue}] {title}\nbody", "feature/PAY-1800-2", reply())).toEqual({ text: "[1800] {title}", learned: false });
    expect(teamFormatLine("", "main", null)).toBeNull();
    expect(teamFormatLine("", "main", reply({ learned: null }))).toBeNull();
    // A reply of another branch (switched since): the longest number of this one.
    expect(issueFor("feature/PAY-1100-2", reply())).toBe("1100");
    expect(issueFor("feature/PAY-1100-2", reply({ branch: "feature/PAY-1100-2", issue: "2" }))).toBe("2");
    expect(learnedSuggestion("", reply())).toBe("PAY-{issue}: {title} - {summary}");
    expect(learnedSuggestion("PAY-{issue}: {title} - {summary}", reply())).toBeNull();
    expect(learnedSuggestion("", null)).toBeNull();
  });
});

describe("PR metadata", () => {
  it("comma lists, @me by default, remembered per project", () => {
    expect(metaList(" bug, , urgent ,bug")).toEqual(["bug", "urgent"]);
    expect(prCreateMeta({ assignees: "@me", labels: "bug", reviewers: "", projects: "Acme 2026" })).toEqual({ assignees: ["@me"], labels: ["bug"], projects: ["Acme 2026"] });
    const mem = new Map<string, string>();
    const kv = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(loadPRMeta("/repo", kv)).toEqual({ assignees: "@me", labels: "", reviewers: "", projects: "" });
    savePRMeta("/repo", { assignees: "@me", labels: "bug", reviewers: "kim", projects: "" }, kv);
    expect(loadPRMeta("/repo", kv).labels).toBe("bug");
    expect(loadPRMeta("/other", kv).labels).toBe("");
    mem.set("rg.prMeta", "not json");
    expect(loadPRMeta("/repo", kv).assignees).toBe("@me");
  });

  it("gh missing or logged out disables the create with its reason", () => {
    initI18n("en", "darwin");
    expect(ghBlocker("ok", "ghe.example.com")).toBeNull();
    expect(ghBlocker(undefined, null)).toBeNull();
    expect(ghBlocker("not_found", null)).toMatch(/not installed/);
    expect(ghBlocker("not_logged_in", "ghe.example.com")).toMatch(/ghe\.example\.com/);
  });
});

describe("compacted turn row", () => {
  it("only for a turn that compacted; the tokens before → after when known", () => {
    initI18n("en", "darwin");
    expect(compactedOf({ contextTokens: 100 })).toBeUndefined();
    const c = compactedOf({ contextTokens: 3704, compacted: { trigger: "manual", preTokens: 16340 } })!;
    expect(c).toEqual({ trigger: "manual", preTokens: 16340, postTokens: 3704 });
    expect(compactedText(c)).toBe("Compacted the conversation · 16.3k → 3.7k tokens — Claude remembers what came before as a summary");
    expect(compactedText({ trigger: "auto" })).toBe("The conversation got long and was compacted — Claude remembers what came before as a summary");
  });
});

describe("/clear in the palette", () => {
  it("says it opens a new chat; the other commands keep the CLI's words", () => {
    initI18n("en", "darwin");
    const out = withAppMeanings([
      { name: "clear", description: "Clear conversation history and free up context", argumentHint: "", isSkill: false, aliases: ["reset", "new"], group: { kind: "builtin" } },
      { name: "compact", description: "Clear conversation history but keep a summary", argumentHint: "", isSkill: false, aliases: [], group: { kind: "builtin" } },
    ]);
    expect(out[0]!.description).toBe("Opens a new chat in the app — this chat stays in the list");
    expect(out[1]!.description).toBe("Clear conversation history but keep a summary");
  });
});
