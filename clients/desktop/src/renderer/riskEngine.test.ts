// MARK: wave4b w4b-files — §40.2 (comp-12): the engine decides the badges and the order; the old rules are the fallback.
import { describe, expect, it } from "vitest";
import type { ChangedFileState } from "@reviewgate/engine";
import { ALL_RISKS, riskKinds, riskLabel, riskScore, sortByRisk } from "./risk";

const file = (path: string, over: Partial<ChangedFileState> = {}): ChangedFileState =>
  ({ path, oldPath: null, status: "M", added: 1, deleted: 1, isBinary: false, tools: ["Edit"], toolUseIds: ["t1"], state: "pending", noteCount: 0, origin: "tool", ...over }) as ChangedFileState;

describe("risk badges from the engine", () => {
  it("shows the engine's kinds as sent and drops ones this client does not know", () => {
    expect(riskKinds(file("src/main/resources/mapper/FooMapper.xml", { risks: ["sql"], riskScore: 25 }))).toEqual(["sql"]);
    expect(riskKinds(file("x", { risks: ["sensitive", "ci", "future-kind" as never] }))).toEqual(["sensitive", "ci"]);
    // The engine's empty list wins over the old rules (which would call a lockfile "config").
    expect(riskKinds(file("package-lock.json", { risks: [] }))).toEqual([]);
  });

  it("falls back to the old rules for an older engine", () => {
    expect(riskKinds(file("package-lock.json"))).toEqual(["config"]);
    expect(riskKinds(file("a.ts", { status: "D" }))).toEqual(["deleted"]);
  });

  it("orders by the engine's score: a test file never above the service it tests", () => {
    const service = file("src/main/java/FooService.java", { risks: [], riskScore: 0 });
    const test = file("src/test/java/FooServiceTest.java", { risks: ["test"], riskScore: -1 });
    const mapper = file("src/main/resources/mapper/FooMapper.xml", { risks: ["sql"], riskScore: 25 });
    expect(sortByRisk([test, service, mapper]).map((f) => f.path)).toEqual([mapper.path, service.path, test.path]);
    expect(riskScore(test)).toBe(-1);
  });

  it("labels every kind and lists them in the engine's order", () => {
    for (const k of ALL_RISKS) expect(riskLabel(k)).toBeTruthy();
    expect(ALL_RISKS).toEqual(["sensitive", "deleted", "permission", "schema", "bash", "sql", "large", "settings", "ci", "external", "config", "test"]);
  });
});
