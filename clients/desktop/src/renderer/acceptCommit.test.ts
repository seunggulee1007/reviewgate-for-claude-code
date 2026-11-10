import { describe, expect, it } from "vitest";
import type { ChangedFileState } from "@reviewgate/engine";
import { acceptAllNeedsDialog, acceptedToast, commitListed, commitPushFor, commitToAccept, setCommitPushFor } from "./acceptCommit";

// MARK: r2-review-flow — M28, as on the Mac (Core ReviewFlowAcceptTests.swift).

const file = (path: string, state: ChangedFileState["state"] = "pending", extra: Partial<ChangedFileState> = {}): ChangedFileState =>
  ({ path, oldPath: null, status: "M", added: 1, deleted: 0, isBinary: false, tools: ["Edit"], toolUseIds: ["e1"], state, noteCount: 0, origin: "tool", ...extra }) as ChangedFileState;

describe("accepting and committing take one action (M28)", () => {
  it("Accept all asks only when a file needs a look", () => {
    expect(acceptAllNeedsDialog({ unviewed: 0, changedSinceViewed: 0, sensitive: 0 })).toBe(false);
    expect(acceptAllNeedsDialog({ unviewed: 1, changedSinceViewed: 0, sensitive: 0 })).toBe(true);
    expect(acceptAllNeedsDialog({ unviewed: 0, changedSinceViewed: 1, sensitive: 0 })).toBe(true);
    expect(acceptAllNeedsDialog({ unviewed: 0, changedSinceViewed: 0, sensitive: 1 })).toBe(true);
    expect(acceptedToast(3)).toBe("Accepted 3 files");
  });

  it("the commit dialog lists pending files after the accepted ones and accepts the ticked ones", () => {
    const files = [file("a.txt", "accepted"), file("b.txt"), file("c.txt"), file("ignored.json", "pending", { ignored: true }), file("d.txt", "changesRequested")];
    expect(commitListed(["a.txt"], files)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(commitToAccept(new Set(["a.txt", "c.txt", "ignored.json"]), files)).toEqual(["c.txt"]);
  });

  it("push after commit is kept per project", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(commitPushFor("/work/acme", false, storage)).toBe(false);
    setCommitPushFor("/work/acme", true, storage);
    expect(commitPushFor("/work/acme", false, storage)).toBe(true);
    expect(commitPushFor("/work/other", false, storage)).toBe(false);
    expect(commitPushFor(null, true, storage)).toBe(true);
  });
});
