// MARK: a-gitflow — docs/PROTOCOL.md §61: the end of a day on Windows — the words of each switch refusal, Create PR's
// gate (not a dirty tree: the default branch), the PR sheet's base check, and Commit… where a switch waits for it.
import { beforeAll, describe, expect, it } from "vitest";
import type { ReviewState } from "@reviewgate/engine";
import { commitBeforeSwitchBlocker, prBaseBlocker, prCreateBlocker } from "./branchFlow";
import { refusalCodeText, switchBlockedText } from "./errorCodes";
import { initI18n } from "./i18n";

function st(o: { branch?: string | null; defaultBranch?: string | null; phase?: string; vcs?: "git" | "shadow"; accepted?: string[]; pending?: string[] } = {}): ReviewState {
  const files = [...(o.accepted ?? []).map((path) => ({ path, state: "accepted" })), ...(o.pending ?? []).map((path) => ({ path, state: "pending" }))];
  return {
    project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: o.branch === undefined ? "feature/cart" : o.branch, remoteURL: null, vcs: o.vcs ?? "git" },
    gate: { phase: o.phase ?? "idle", collectError: null },
    branches: { list: [], isWorktreeDirty: true, switchBlocker: { kind: "dirtyWorktree" }, createBlocker: null, defaultBranch: o.defaultBranch === undefined ? "main" : o.defaultBranch },
    changedFiles: files,
    commit: { canCommit: (o.accepted ?? []).length > 0, acceptedPaths: o.accepted ?? [] },
  } as unknown as ReviewState;
}

describe("§61 branches with work in progress", () => {
  beforeAll(() => initI18n("en", "win32"));

  it("each switch_blocked kind says its own reason", () => {
    expect(switchBlockedText("pendingReview")).toBe("Finish the review before switching branches");
    expect(switchBlockedText("dirtyWorktree")).toBe("Working tree has uncommitted changes — commit them before switching branches");
    expect(switchBlockedText("running")).toBe("Claude is working — switch branches when the turn ends");
    expect(switchBlockedText("")).toBe("Switching is not possible right now.");
    expect(refusalCodeText("switch_blocked", "dirtyWorktree")).toBe(switchBlockedText("dirtyWorktree"));
    expect(refusalCodeText("pr_same_branch", "main")).toBe("You're on main, the base branch — create a branch for this work first");
    expect(refusalCodeText("pr_no_commits", "origin/main")).toBe("This branch has no commits since origin/main");
  });

  it("Create PR waits for a branch other than the default one — not for a clean tree or a finished review", () => {
    expect(prCreateBlocker(st())).toBeNull(); // dirty + switchBlocker set: still allowed
    expect(prCreateBlocker(st({ branch: "main" }))).toBe("You're on main, the base branch — create a branch for this work first");
    expect(prCreateBlocker(st({ branch: null }))).toBe("Check out a branch first (HEAD is detached).");
    expect(prCreateBlocker(st({ phase: "running" }))).toBe("Claude is working");
    expect(prCreateBlocker(st({ vcs: "shadow" }))).not.toBeNull();
    expect(prCreateBlocker(st({ branch: "main", defaultBranch: null }))).toBeNull(); // unknown default: the sheet and the engine decide
  });

  it("the PR sheet: the base is the branch itself, or nothing is on the branch since the base", () => {
    expect(prBaseBlocker("main", "main", null)).toBe("You're on main, the base branch — create a branch for this work first");
    expect(prBaseBlocker("main", "feature/cart", { baseRef: "origin/main", commits: [] })).toBe("This branch has no commits since origin/main");
    expect(prBaseBlocker("main", "feature/cart", { baseRef: "origin/main", commits: ["fix the cart"] })).toBeNull();
    expect(prBaseBlocker("release", "feature/cart", { baseRef: null, commits: [] })).toBeNull(); // an unknown base is gh's to judge
  });

  it("Commit… beside a blocked switch opens when there is something to commit, else says why", () => {
    expect(commitBeforeSwitchBlocker(st({ accepted: ["a.ts"] }))).toBeNull();
    expect(commitBeforeSwitchBlocker(st({ pending: ["b.ts"] }))).toBeNull(); // the sheet accepts pending files as it commits
    expect(commitBeforeSwitchBlocker(st())).toBe(refusalCodeText("nothing_to_commit", ""));
    expect(commitBeforeSwitchBlocker(st({ accepted: ["a.ts"], phase: "running" }))).toBe("Claude is working — wait for the turn to finish");
  });
});
