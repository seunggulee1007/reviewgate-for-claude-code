import { describe, expect, it } from "vitest";
import type { McpServerInfo } from "@reviewgate/engine";
import { abbreviate, canOpenMarkdown, claudeMdRefusal, diffCounts, instructionsDiff, instructionTitle, isFromParentFolder, isOffForRepository, notRemovableReason, originLine, parentRemoveHelp, removeScope, terminalCommand, whenRead } from "./claudeConfig";

/** wave4d w4d-config — docs/PROTOCOL.md §42.3 on Electron: origins, kinds, the editor's refusals and diff (the Mac's rules). */

const base: McpServerInfo = {
  name: "context7",
  status: "connected",
  scope: "project",
  source: "project",
  transport: "stdio",
  toolCount: 2,
  tools: [],
  error: null,
  serverInfo: null,
  config: null,
  disabledByUser: false,
  sessionAdded: false,
};

describe("MCP origins (§42.3)", () => {
  it("a parent folder's .mcp.json: named, removable with its file; an older engine (no origin): the source decides", () => {
    const parent: McpServerInfo = { ...base, origin: { file: "/w/workspace/.mcp.json", place: "parent", removable: true } };
    expect(isFromParentFolder(parent)).toBe(true);
    expect(removeScope(parent)).toBe("project");
    expect(originLine(parent, null)).toContain("/w/workspace/.mcp.json");
    expect(originLine(parent, null)).toContain("every project under it");
    expect(parentRemoveHelp(parent, null)).toContain("every project and workbench under it");
    expect(originLine(base, null)).toBeNull();
    expect(removeScope(base)).toBe("project");
    expect(parentRemoveHelp(base, null)).toBeNull();
    expect(removeScope({ ...base, source: "local" })).toBeNull();
    expect(removeScope({ ...base, source: "local" }, { localScope: true })).toBe("local");
  });

  it("not removable where it is defined: the reason and the terminal command", () => {
    const ghost: McpServerInfo = { ...base, origin: { file: null, place: null, removable: false, reason: "not_found", command: "claude mcp remove --scope project ghost" } };
    expect(removeScope(ghost)).toBeNull();
    expect(notRemovableReason(ghost, null)).toBe("ReviewGate could not find which .mcp.json defines it");
    expect(terminalCommand(ghost)).toBe("claude mcp remove --scope project ghost");
    const ro: McpServerInfo = { ...base, origin: { file: "/w/.mcp.json", place: "parent", removable: false, reason: "read_only", command: "cd /w && claude mcp remove --scope project context7" } };
    expect(notRemovableReason(ro, null)).toBe("ReviewGate cannot change /w/.mcp.json");
    expect(notRemovableReason({ ...base, origin: { file: null, place: null, removable: false, reason: "plugin" } }, null)).toContain("plugin");
    expect(terminalCommand({ ...base, origin: { file: "/r/.mcp.json", place: "project", removable: true, command: "x" } })).toBeNull();
    expect(notRemovableReason(base, null)).toBeNull();
  });

  it("off for every workbench only when the repository's choice turned it off", () => {
    expect(isOffForRepository({ ...base, status: "disabled", disabledByUser: true, disabledIn: "repository" })).toBe(true);
    expect(isOffForRepository({ ...base, status: "disabled", disabledByUser: true, disabledIn: "worktree" })).toBe(false);
    expect(isOffForRepository({ ...base, disabledIn: "repository" })).toBe(false);
  });

  it("abbreviates the home folder", () => {
    expect(abbreviate("/Users/u/x/.mcp.json", "/Users/u")).toBe("~/x/.mcp.json");
    expect(abbreviate("/Users/uu/x", "/Users/u")).toBe("/Users/uu/x");
    expect(abbreviate("C:\\Users\\u\\x.md", "C:\\Users\\u")).toBe("~\\x.md");
    expect(abbreviate("/a", null)).toBe("/a");
  });
});

describe("Claude's instructions (§42.3)", () => {
  it("every kind has a title and says when Claude reads it", () => {
    for (const k of ["user", "project", "local", "parent", "nested", "rules", "auto_memory", "managed", "other"]) {
      expect(instructionTitle(k)).toBeTruthy();
      expect(whenRead(k)).toBeTruthy();
    }
    expect(whenRead("nested")).not.toBe(whenRead("project"));
    expect(whenRead(undefined)).toBe("Loaded by Claude Code");
  });

  it("only Markdown files go to the default app", () => {
    expect(canOpenMarkdown("/r/CLAUDE.md")).toBe(true);
    expect(canOpenMarkdown("C:\\r\\agents\\x.MARKDOWN")).toBe(true);
    expect(canOpenMarkdown("/Applications/Evil.app")).toBe(false);
    expect(canOpenMarkdown(null)).toBe(false);
  });

  it("refusals in words", () => {
    expect(claudeMdRefusal("claude_md_changed", "x")).toContain("changed since you opened it");
    expect(claudeMdRefusal("in_review", "x")).toContain("open review");
    expect(claudeMdRefusal("session_busy", "x")).toContain("Claude is working");
    expect(claudeMdRefusal("something_else", "the fallback")).toBe("the fallback");
  });

  it("the diff keeps context around the changes and folds the rest", () => {
    const old = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    lines[9] = "line 10 changed";
    lines.push("line 21");
    const rows = instructionsDiff(old, lines.join("\n") + "\n", 2);
    expect(rows[0]).toEqual({ kind: "fold", text: "", folded: 7 });
    expect(rows.filter((r) => r.kind === "del").map((r) => r.text)).toEqual(["line 10"]);
    expect(rows.filter((r) => r.kind === "add").map((r) => r.text)).toEqual(["line 10 changed", "line 21"]);
    expect(diffCounts(rows)).toEqual({ added: 2, removed: 1 });
    expect(rows.some((r) => r.kind === "fold" && r.folded === 6)).toBe(true);
    expect(instructionsDiff("a\n", "a\n")).toEqual([]);
    expect(instructionsDiff("", "# Rules\n").map((r) => r.kind)).toEqual(["add"]);
  });
});
