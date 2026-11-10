import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReviewState, SessionMeta } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { errorEventText, presentationOf } from "./errorCodes";
import { errorSubline, factsOf } from "./sessionErrors";
import { chatMoveNoticeText, moveRefusalText, movedChat } from "./chatMove";
import { stopReasonWords } from "./stopWords";

/**
 * wave4b w4b-check4: the §39.4 / §39.5 / §40.1 shapes as the engine really sends them (engine/test/fixtures/wire/
 * wave4.follow.json, written by engine.wave4Wire.test.ts), through the helpers the store and the screens use. (The Mac's
 * Wave4WireGoldenTests read the same file.)
 */
type ErrorEv = { type: "error"; message: string; fatal: boolean; scope: "session"; code?: string; detail?: string; toolName?: string; hookName?: string; exitCode?: number; path?: string; sessionId?: string };
type Golden = {
  notices: ErrorEv[];
  turnEnd: { stopReason: string };
  results: { id: string; ok: boolean; code?: string }[];
  chatMoved: { type: "chat_moved"; sessionId: string; path: string; name: string; baseline: "head" | "disk"; interrupted: boolean };
  sourceMeta: SessionMeta;
  movedIn: ErrorEv[];
  targetMeta: SessionMeta;
};
const golden = JSON.parse(readFileSync(new URL("../../../../engine/test/fixtures/wire/wave4.follow.json", import.meta.url), "utf8")) as Golden;

describe("the engine's §39.4 / §39.5 / §40.1 shapes in Electron's helpers", () => {
  it("the auto-mode and hook notices are rows with their words; a blocked hook is not a failure", () => {
    initI18n("en", "darwin");
    const [denied, unavailable, blocked, failed] = golden.notices;
    expect(golden.notices.map((n) => presentationOf(n.code))).toEqual(["row", "row", "row", "row"]);
    expect(errorEventText(denied!)).toBe("Auto mode blocked: git push --force — [Security Weaken]");
    expect(errorEventText(unavailable!)).toContain("Auto mode is not available");
    expect(errorEventText(blocked!)).toBe("Blocked by a hook: PreToolUse:Bash — no rm -rf in this repo");
    expect(errorSubline(factsOf(blocked!))).toBe("");
    expect(errorEventText(failed!)).toBe("A hook failed: PostToolUse:Bash");
    expect(errorSubline(factsOf(failed!))).toBe("commit-sweep.sh: not found · exit code 1");
  });

  it("the turn-end stop reason in words", () => {
    initI18n("en", "darwin");
    expect(stopReasonWords(golden.turnEnd.stopReason)).toBe("Stopped at the tool-call limit");
  });

  it("chat_move's refusal codes, the moved chat's metas and the notice in the target", () => {
    initI18n("en", "darwin");
    expect(golden.results.map((r) => [r.id, r.ok, r.code ?? null])).toEqual([
      ["req-same", false, "same_worktree"],
      ["req-missing", false, "path_not_found"],
      ["req-move", true, null],
      ["req-record", false, "chat_is_record"],
    ]);
    for (const r of golden.results.filter((x) => !x.ok)) expect(moveRefusalText(r.code!)).not.toMatch(/could not be moved \(/); // each has its own words
    expect(golden.chatMoved).toEqual({ type: "chat_moved", sessionId: "chat-1", path: "/repo-wt", name: "repo-wt", baseline: "disk", interrupted: false });
    const state = { sessions: { list: [golden.sourceMeta], currentId: "chat-1", openTabIds: ["chat-1"] } } as unknown as ReviewState;
    expect(movedChat(state)).toEqual({ path: "/repo-wt", name: "repo-wt", at: "2026-01-02T03:04:05.000Z" });
    expect(golden.targetMeta.movedFrom).toEqual({ path: "/repo", name: "repo", at: "2026-01-02T03:04:05.000Z" });
    expect(golden.targetMeta.movedTo).toBeUndefined();
    const notice = golden.movedIn[0]!;
    expect(chatMoveNoticeText(notice.code, notice.path)).toBe("This chat moved here from /repo. It is reviewed from here on; changes made here before the move are not in the review.");
  });
});
