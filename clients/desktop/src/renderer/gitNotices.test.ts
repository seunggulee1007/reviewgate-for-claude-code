import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@reviewgate/engine";
import { errorEventText, presentationOf } from "./errorCodes";
import { committedBadge, committedHelp, gitNoticeText, isGitRow, onceOnlyHelp } from "./gitNotices";
import { reasonView } from "./permissionQueue";
import { gateNoticeKey } from "./reviewGate";
import { errorSubline, errorTone } from "./sessionErrors";

// MARK: r1-git — docs/PROTOCOL.md §46 / §31.3 in Electron, as on the Mac (GitAutoTests.swift): only what throws work away
// or rewrites the remote keeps the red card, which says why it is one call at a time; Claude's own commit keeps its file in
// the review with a "커밋됨" badge; what Claude's git commands did is a gray row, never the head-moved banner.

const bash = (command: string, reason?: PermissionRequest["reason"]): Pick<PermissionRequest, "toolName" | "reason"> => ({ toolName: "Bash", ...(reason ? { reason } : {}) });

describe("the git card (§46)", () => {
  it("git_command is a red line in the app's words — no longer the engine's English in orange", () => {
    const view = reasonView({ code: "git_command", message: "A git command that throws away uncommitted work or rewrites the remote — the review cannot bring it back." });
    expect(view).toEqual({ code: "git_command", text: "A git command that throws away uncommitted work or rewrites the remote — the review cannot bring it back", tone: "red", path: null });
  });

  it("a card with a reason says why it allows one call at a time; an ordinary card does not", () => {
    expect(onceOnlyHelp(bash("git reset --hard", { code: "git_command", message: "x" }))).toBe(
      "Allowed one call at a time — this git command can throw away work the review cannot bring back, so it is never remembered (Ctrl+Enter)",
    );
    expect(onceOnlyHelp(bash("cd sub && make", { code: "nested_repository", message: "x" }))).toBe(
      "Allowed one call at a time — this call works where the review cannot follow, so it is never remembered (Ctrl+Enter)",
    );
    expect(onceOnlyHelp(bash("git commit -m x"))).toBeNull();
    expect(onceOnlyHelp({ toolName: "SendMessage", reason: { code: "git_command", message: "x" } })).toBeNull();
  });
});

describe("what Claude's git commands did (§46, §31.3)", () => {
  it("each code is a gray row in its own words, without a second line", () => {
    const cases: [string, string, string][] = [
      ["claude_committed", "abc1234", "Claude committed abc1234 — its files stay in the review"],
      ["claude_moved_head", "main@abc1234 → feature/acme-7@abc1234", "Claude's git command moved HEAD (main@abc1234 → feature/acme-7@abc1234) — the review shows only Claude's changes"],
      ["git_stashed", "src/App.java, README.md", "Stashed and out of the review: src/App.java, README.md (git stash pop brings them back)"],
      ["reject_committed", "src/App.java (abc1234)", "Reverted on disk — Claude's commit still holds the change: src/App.java (abc1234) (git reset --soft or git revert undoes it)"],
    ];
    for (const [code, detail, text] of cases) {
      expect(isGitRow(code)).toBe(true);
      expect(presentationOf(code)).toBe("row");
      expect(errorTone(code, false)).toBe("info");
      expect(gitNoticeText({ code, detail })).toBe(text);
      expect(errorEventText({ code, detail, message: "english" })).toBe(text);
      expect(errorSubline({ code, cliDetail: detail })).toBe("");
    }
    expect(isGitRow("auto_mode_denied")).toBe(false);
    expect(gitNoticeText({ code: "hook_blocked" })).toBeNull();
  });

  it("a committed file's badge and its tooltip", () => {
    expect(committedBadge("abc1234")).toBe("Committed abc1234");
    expect(committedHelp("abc1234")).toContain("the file stays in the review");
  });

  it("a HEAD move Claude made is never the head-moved banner; anyone else's still is", () => {
    const from = { sha: "1111111aaaa", branch: "main" };
    const to = { sha: "2222222bbbb", branch: "main" };
    expect(gateNoticeKey("headMoved", { headMoved: { from, to, explainedBy: "claude_git", commits: ["2222222"] } })).toBeNull();
    expect(gateNoticeKey("headMoved", { headMoved: { from, to } })).not.toBeNull();
  });
});
