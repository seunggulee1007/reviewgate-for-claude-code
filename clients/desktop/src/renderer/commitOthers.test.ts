// MARK: git-sync — docs/PROTOCOL.md §68.5 on Windows: the commit dialog's second group (none ticked, untracked on request),
// the dialog opening for files outside the review alone, and `invalid_extra`'s words.
import { beforeAll, describe, expect, it } from "vitest";
import type { OtherChange, ReviewState } from "@reviewgate/engine";
import { commitBeforeSwitchBlocker } from "./branchFlow";
import { extraPathsOf, followingTicks, otherChangesTotal, otherStatusLetter, othersMessage, othersOnly, visibleOthers } from "./commitOthers";
import { refusalCodeText } from "./errorCodes";
import { initI18n } from "./i18n";

const files: OtherChange[] = [
  { path: "README.md", oldPath: null, status: "M", untracked: false },
  { path: "notes.md", oldPath: null, status: "?", untracked: true },
];

describe("§68.5 files outside the review in the commit dialog", () => {
  beforeAll(() => initI18n("en", "win32"));

  it("tracked changes are listed, untracked ones only when asked for; a hidden ticked one is not committed", () => {
    expect(visibleOthers(files, false).map((f) => f.path)).toEqual(["README.md"]);
    expect(visibleOthers(files, true).map((f) => f.path)).toEqual(["README.md", "notes.md"]);
    expect(extraPathsOf(new Set(["README.md", "notes.md"]), files, false)).toEqual(["README.md"]);
    expect(extraPathsOf(new Set(), files, true)).toEqual([]);
    expect(otherStatusLetter(files[0]!)).toBe("M");
    expect(otherStatusLetter(files[1]!)).toBe("U");
  });

  it("the dialog opens for changes outside the review alone; an older engine sends no count", () => {
    const st = (otherChanges?: { tracked: number; untracked: number }) =>
      ({
        project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: null, vcs: "git" },
        gate: { phase: "idle", collectError: null },
        changedFiles: [],
        commit: { canCommit: false, acceptedPaths: [], ...(otherChanges ? { otherChanges } : {}) },
      }) as unknown as ReviewState;
    expect(otherChangesTotal(st())).toBe(0);
    expect(otherChangesTotal(st({ tracked: 1, untracked: 2 }))).toBe(3);
    expect(commitBeforeSwitchBlocker(st())).toBe(refusalCodeText("nothing_to_commit", ""));
    expect(commitBeforeSwitchBlocker(st({ tracked: 1, untracked: 0 }))).toBeNull();
    expect(refusalCodeText("invalid_extra", "b.txt")).toBe("b.txt is no longer a change outside the review — reopen the commit sheet");
  });

  it("a dialog of only other changes is not about accepted files", () => {
    expect(othersOnly(0, 2, false)).toBe(true);
    expect(othersOnly(0, 0, true)).toBe(true); // over 500, none listed
    expect(othersOnly(1, 2, false)).toBe(false); // the review's files lead
    expect(othersOnly(0, 0, false)).toBe(false);
  });

  it("a commit of only other changes takes the engine's neutral message, unless something was typed", () => {
    const review = "Apply accepted changes";
    expect(othersMessage(review, review, "Update README.md", true)).toBe("Update README.md");
    expect(othersMessage("", review, "Update 2 files", true)).toBe("Update 2 files");
    expect(othersMessage("fix: typo", review, "Update README.md", true)).toBeNull();
    expect(othersMessage(review, review, "Update README.md", false)).toBeNull(); // review files listed
    expect(othersMessage(review, review, undefined, true)).toBeNull(); // an older engine
  });

  it("the message follows the ticked files until the user typed their own", () => {
    expect(followingTicks("Update 2 files", "Update 2 files", "Update a.txt")).toBe("Update a.txt");
    expect(followingTicks("my words", "Update 2 files", "Update a.txt")).toBeNull();
    expect(followingTicks("Update a.txt", "Update a.txt", "Update a.txt")).toBeNull();
    expect(followingTicks("x", null, "Update a.txt")).toBeNull();
  });
});
