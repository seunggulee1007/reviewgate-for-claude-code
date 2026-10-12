import { describe, expect, it } from "vitest";
import type { TranscriptSearchMatch } from "@reviewgate/engine";
import { fileCause, historyOffersContext, imageSrc, isPreviewImage, matchHits, prOffersContext, whitespaceEmptyText } from "./reviewLeftovers";
import { indexTranscript } from "./agents";
import { groupFiles, sectionLabel } from "./fileGroups";
import type { ChatItem } from "./store";

/** MARK: wave4c w4c-review — §41.3 client rules (the Mac's ReviewLeftoversTests pin the same cases). */
describe("review leftovers (§41.3)", () => {
  it("20줄 더 보기: a modified / renamed text file of a past round or a PR", () => {
    expect([historyOffersContext("M", false), historyOffersContext("R", false), historyOffersContext("A", false), historyOffersContext("D", false), historyOffersContext("M", true)]).toEqual([true, true, false, false, false]);
    expect([prOffersContext("modified", false), prOffersContext("renamed", false), prOffersContext("changed", false), prOffersContext("added", false), prOffersContext("removed", false), prOffersContext("modified", true)]).toEqual([true, true, true, false, false, false]);
  });

  const match = (more: TranscriptSearchMatch["more"], total?: number): TranscriptSearchMatch => ({
    sessionId: "s",
    title: "chat",
    row: 9,
    turn: 5,
    at: "t9",
    kind: "assistant_text",
    line: "newest",
    ...(more ? { more } : {}),
    ...(total !== undefined ? { total } : {}),
  });

  it("the chat search shows a chat's three newest matches and counts the rest", () => {
    const more = [
      { row: 7, turn: 4, at: "t7", kind: "user_message" as const, line: "older" },
      { row: 3, turn: 2, at: "t3", kind: "assistant_text" as const, line: "oldest shown" },
    ];
    const r = matchHits(match(more, 7));
    expect(r.hits.map((h) => h.line)).toEqual(["newest", "older", "oldest shown"]);
    expect(r.more).toBe(4);
    // An engine before §41.3: one match, nothing counted.
    expect(matchHits(match(undefined))).toEqual({ hits: [{ row: 9, turn: 5, at: "t9", kind: "assistant_text", line: "newest" }], more: 0 });
    // A total smaller than what was sent never goes negative.
    expect(matchHits(match(more, 1)).more).toBe(0);
  });

  it("the whitespace view's empty body says whether only whitespace changed", () => {
    expect(whitespaceEmptyText({ whitespaceOnly: true })).toBe("Only whitespace changed — ignoring it, nothing is left");
    expect(whitespaceEmptyText({})).toBe("No changes once whitespace is ignored");
  });

  it("by cause: a subagent first, then the Bash command, then the turn of its reason, else the main agent; sections in first-seen order", () => {
    const index = indexTranscript([
      { kind: "toolUse", id: 1, toolUseId: "b1", name: "Bash", input: { command: "./gradlew spotlessApply\n  --info" } },
      { kind: "toolUse", id: 2, toolUseId: "b2", name: "Bash", input: { command: `echo ${"x".repeat(80)}` } },
    ] as ChatItem[]);
    const executor = [{ key: "a1", label: "executor", agentToolUseId: "a1" }];
    const main = [{ key: "main", label: "Main", agentToolUseId: null }];
    expect(fileCause({ origin: "tool", toolUseIds: ["e1"] }, executor, index)).toBe("◆ executor");
    expect(fileCause({ origin: "bash", toolUseIds: ["b1"] }, main, index)).toBe("Bash · ./gradlew spotlessApply");
    expect(fileCause({ origin: "bash", toolUseIds: ["b2"] }, main, index)).toBe(`Bash · echo ${"x".repeat(55)}…`);
    expect(fileCause({ origin: "bash", toolUseIds: ["gone"] }, main, index)).toBe("Bash");
    expect(fileCause({ origin: "tool", toolUseIds: ["e1"], why: { text: "x", source: "same_message", turn: 3 } }, main, index)).toBe("Turn 3");
    expect(fileCause({ origin: "tool", toolUseIds: [] }, [], null)).toBe("Main");
    const files = [{ path: "a" }, { path: "b" }, { path: "c" }];
    const cause: Record<string, string> = { a: "Turn 2", b: "◆ executor", c: "Turn 2" };
    expect(groupFiles(files, "cause", (f) => cause[f.path]!).map((s) => [s.key, s.files.map((f) => f.path)])).toEqual([["Turn 2", ["a", "c"]], ["◆ executor", ["b"]]]);
    expect(groupFiles(files, "cause").map((s) => s.files.length)).toEqual([3]); // no causes known: one section
    expect(sectionLabel("cause", "")).toBe("Main");
  });

  it("images: png / jpg / gif previews, a side over 2 MB says why, a missing side is nothing", () => {
    expect(["a.png", "b.JPG", "c.jpeg", "d.gif", "e.svg", "f.webp"].map(isPreviewImage)).toEqual([true, true, true, true, false, false]);
    expect(imageSrc({ size: 3, dataBase64: "AAA" }, "image/png")).toEqual({ src: "data:image/png;base64,AAA" });
    expect(imageSrc({ size: 3_000_000, tooLarge: true }, "image/png")).toEqual({ reason: "Larger than 2 MB — not previewed" });
    expect(imageSrc(null, "image/png")).toBeNull();
  });
});
