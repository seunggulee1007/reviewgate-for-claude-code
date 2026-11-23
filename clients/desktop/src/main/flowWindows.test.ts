/**
 * MARK: wave3 desktop-flow — what one window hands another through main: §36.12 a failed setup's report (checked, taken once,
 * bounded) and §36.14 a composer draft (text only, never empty).
 */
import { describe, expect, it } from "vitest";
import { isComposerDraft, isWorkbenchSetupReport } from "../shared/flowSettings.js";
import { COMPOSER_HANDOFF_MS, createComposerHandoffs, createSetupReports } from "./flowWindows.js";

const report = { branch: "feature/PAY-1600", exitCode: 1, log: "[ERROR] BUILD FAILURE" };

describe("§36.12 the setup report reaches the new window once", () => {
  it("is kept per folder and taken by any of the window's paths", () => {
    const r = createSetupReports();
    expect(r.remember("/Users/me/acme-1600/", report)).toBe(true);
    expect(r.take(["/elsewhere", "/Users/me/acme-1600"])).toEqual(report);
    expect(r.take(["/Users/me/acme-1600"])).toBeNull();
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

describe("§9 New Chat in a Workbench: a held message reaches the new workbench's window once", () => {
  it("is kept per folder, taken by any of the window's paths, and says the first chat must be a chat", () => {
    const h = createComposerHandoffs();
    expect(h.waits("/work/acme-wb/wb-261123-0905", 0)).toBe(false);
    expect(h.remember("/work/acme-wb/wb-261123-0905/", "go on here\n\n@src/cart.ts", 0)).toBe(true);
    expect(h.waits("/work/acme-wb/wb-261123-0905", 0)).toBe(true);
    expect(h.take(["/elsewhere", "/work/acme-wb/wb-261123-0905"], 0)).toBe("go on here\n\n@src/cart.ts");
    expect(h.take(["/work/acme-wb/wb-261123-0905"], 0)).toBeNull();
    expect(h.waits("/work/acme-wb/wb-261123-0905", 0)).toBe(false);
  });

  it("text only, never empty; a quarter of an hour; the newer one wins; at most 20 wait", () => {
    const h = createComposerHandoffs();
    expect(h.remember("/a", "  ", 0)).toBe(false);
    expect(h.remember("/a", 42, 0)).toBe(false);
    expect(h.remember("", "x", 0)).toBe(false);
    expect(h.remember("/a", "old", 0)).toBe(true);
    expect(h.remember("/a", "new", 0)).toBe(true);
    expect(h.waits("/a", COMPOSER_HANDOFF_MS)).toBe(true);
    expect(h.waits("/a", COMPOSER_HANDOFF_MS + 1)).toBe(false);
    expect(h.take(["/a"], COMPOSER_HANDOFF_MS + 1)).toBeNull();
    expect(h.remember("/a", "new", 0)).toBe(true);
    expect(h.take(["/a"], 0)).toBe("new");
    for (let i = 0; i < 25; i++) h.remember(`/w/${i}`, `m${i}`, 0);
    expect(h.waits("/w/0", 0)).toBe(false);
    expect(h.take(["/w/24"], 0)).toBe("m24");
    expect(h.take("/w/23", 0)).toBeNull();
  });
});
