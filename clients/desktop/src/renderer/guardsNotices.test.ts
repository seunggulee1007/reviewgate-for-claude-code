import { describe, expect, it } from "vitest";
import { errorEventText, presentationOf } from "./errorCodes";
import { reasonView } from "./permissionQueue";
import { sessionActions } from "./sessionErrors";

// r2-guards — docs/PROTOCOL.md §33.9 (M22) and §39.4 (M05b) in Electron, as on the Mac (PermissionQueueTests,
// ScopeNoticesTests): the settings card names the settings that take effect before the review; Claude's own move into or
// out of a worktree that the chat did not follow is a row that says where it went and offers the move.

describe("the claude_config card names its settings (M22)", () => {
  it("with keys: which ones, and why the card is there at all; without: the line as before", () => {
    const keyed = reasonView({ code: "claude_config", message: "m", path: "/repo/.claude/settings.json", keys: ["hooks", "env.NODE_OPTIONS"] })!;
    expect(keyed).toMatchObject({ tone: "red", path: "/repo/.claude/settings.json" });
    expect(keyed.text).toBe("Changes Claude Code settings (.claude/settings.json: hooks, env.NODE_OPTIONS) — they take effect before the review, so the review cannot undo them");
    expect(reasonView({ code: "claude_config", message: "m", keys: ["permissions"] })!.text).toBe(
      "Changes Claude Code settings (permissions) — they take effect before the review, so the review cannot undo them",
    );
    const plain = reasonView({ code: "claude_config", message: "m", path: "/repo/.mcp.json" })!;
    expect(plain.text).toContain("Changes a Claude Code settings file (repo/.mcp.json)");
  });
});

describe("EnterWorktree / ExitWorktree rows (M05b)", () => {
  const row = (toolName: string, path?: string) =>
    errorEventText({ type: "error", message: `${toolName} worked outside this window's review`, fatal: false, scope: "session", code: "worktree_outside_review", toolName, ...(path ? { path } : {}) } as never);

  it("say where Claude went — a row, never a banner — and offer the move into a worktree of this repository", () => {
    expect(presentationOf("worktree_outside_review")).toBe("row");
    expect(row("EnterWorktree", "/work/acme/.claude/worktrees/acme-42")).toBe(
      "Claude went into a worktree: /work/acme/.claude/worktrees/acme-42. Its work there is outside this window's review — move this chat there to review it there.",
    );
    expect(row("EnterWorktree")).toBe("Claude went into a worktree. Its work there is outside this window's review.");
    expect(row("ExitWorktree", "/work/acme")).toBe(
      "Claude went back to the folder it came from: /work/acme. What it does next is outside this window's review — move this chat there to review it there.",
    );
    // Any other tool keeps the sentence it had.
    expect(row("Agent", "/work/acme/.claude/worktrees/agent-1")).toBe("Claude worked where this window's review does not see it: /work/acme/.claude/worktrees/agent-1");
    expect(sessionActions("worktree_outside_review", { count: 1, facts: { path: "/work/acme/.claude/worktrees/acme-42" }, isWorkbench: () => true })[0]).toBe("moveChat");
  });
});
