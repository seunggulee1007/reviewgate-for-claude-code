import { describe, expect, it } from "vitest";
import type { ChangedFileState, GateState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { autoUndoView, enabledTrustRules, rejectUndoView, ruleAccepted, trustRuleName } from "./trust";

// MARK: wave4c w4c-trust — docs/PROTOCOL.md §41.2 (as on the Mac, Core/Tests TrustRulesTests.swift).

const file = (path: string, over: Partial<ChangedFileState> = {}) => ({ path, oldPath: null, status: "M", added: 1, deleted: 0, isBinary: false, tools: ["Edit"], toolUseIds: ["e"], state: "pending", noteCount: 0, ...over }) as ChangedFileState;
const gate = (over: Partial<GateState> = {}) => ({ phase: "reviewing", ...over }) as GateState;

describe("auto-accept rules (§41.2)", () => {
  it("names the rules; an unknown one has none", () => {
    initI18n("en", "darwin");
    expect(trustRuleName("whitespace")).toBe("Whitespace only");
    expect(trustRuleName("newer")).toBeNull();
    initI18n("ko", "darwin");
    expect(trustRuleName("whitespace")).toBe("공백만 바뀜");
    expect(trustRuleName("lockfile")).toBe("매니페스트와 함께 lockfile");
    expect(trustRuleName("tests")).toBe("편집 뒤 테스트 통과");
    initI18n("en", "darwin");
    expect(enabledTrustRules({ tests: true, whitespace: false })).toEqual(["tests"]);
    expect(enabledTrustRules(undefined)).toEqual([]);
  });

  it("[모두 대기로 되돌리기]: the summary's files a rule still holds; disabled with a reason otherwise", () => {
    initI18n("en", "darwin");
    const files = [file("a.java", { state: "accepted", autoAccepted: "whitespace" }), file("b.java", { state: "accepted" }), file("c.lock", { state: "pending" })];
    expect(ruleAccepted(files)).toEqual(["a.java"]);
    expect(autoUndoView({ changedFiles: files, gate: gate() }, ["a.java", "c.lock"])).toEqual({ paths: ["a.java"], blocked: null });
    expect(autoUndoView({ changedFiles: files, gate: gate({ phase: "running" }) }, ["a.java"]).blocked).toBe("Claude is working — wait for the turn to end");
    expect(autoUndoView({ changedFiles: files, gate: gate() }, ["b.java"]).blocked).toBe("Already back to pending or out of the review");
  });

  it("the reject banner: offered, disabled with the engine's reason, absent without an offer", () => {
    initI18n("en", "darwin");
    expect(rejectUndoView({ gate: gate() })).toBeNull();
    expect(rejectUndoView({ gate: gate({ phase: "idle", rejectUndo: { path: "a.java", oldPath: null, status: "M", available: true } }) })).toEqual({ path: "a.java", blocked: null });
    expect(rejectUndoView({ gate: gate({ rejectUndo: { path: "a.java", oldPath: null, status: "M", available: false, reason: "changed_on_disk" } }) })?.blocked).toBe(
      "The file changed after the reject — it can no longer be put back",
    );
    expect(rejectUndoView({ gate: gate({ phase: "running", rejectUndo: { path: "a.java", oldPath: null, status: "M", available: true } }) })?.blocked).toBe("Claude is working — wait for the turn to end");
  });
});
