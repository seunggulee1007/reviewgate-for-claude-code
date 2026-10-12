/**
 * MARK: wave3 desktop-flow — what one window hands another through main: §36.12 a failed setup's report (checked, taken once,
 * bounded) and §36.14 a composer draft (text only, never empty).
 */
import { describe, expect, it } from "vitest";
import { isComposerDraft, isWorkbenchSetupReport } from "../shared/flowSettings.js";
import { createSetupReports } from "./flowWindows.js";

const report = { branch: "feature/acme/4790", exitCode: 1, log: "[ERROR] BUILD FAILURE" };

describe("§36.12 the setup report reaches the new window once", () => {
  it("is kept per folder and taken by any of the window's paths", () => {
    const r = createSetupReports();
    expect(r.remember("/Users/me/acme-4790/", report)).toBe(true);
    expect(r.take(["/elsewhere", "/Users/me/acme-4790"])).toEqual(report);
    expect(r.take(["/Users/me/acme-4790"])).toBeNull();
  });

  it("only a report's shape; at most 20 wait", () => {
    const r = createSetupReports();
    expect(r.remember("/a", { ...report, exitCode: "1" })).toBe(false);
    expect(r.remember("/a", { ...report, log: "x".repeat(8001) })).toBe(false);
    expect(r.remember("", report)).toBe(false);
    expect(r.remember("/a", { ...report, exitCode: null })).toBe(true);
    for (let i = 0; i < 25; i++) r.remember(`/w/${i}`, report);
    expect(r.take(["/a"])).toBeNull();
    expect(r.take(["/w/24"])).toEqual(report);
    expect(r.take("/w/23")).toBeNull();
    expect(isWorkbenchSetupReport({ ...report, extra: 1 })).toBe(true);
  });
});

describe("§36.14 a composer draft for another window", () => {
  it("is text, not empty, bounded", () => {
    expect(isComposerDraft("/acme-tools:review-reply 512\n\n- a.ts:1 — @kim:")).toBe(true);
    expect(isComposerDraft("  ")).toBe(false);
    expect(isComposerDraft(42)).toBe(false);
    expect(isComposerDraft("a\0b")).toBe(false);
  });
});
