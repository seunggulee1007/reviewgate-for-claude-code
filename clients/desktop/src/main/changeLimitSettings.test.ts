// docs/PROTOCOL.md §54: the change limit is opt-in — off, the engine gets no budget (0 / 0) and the built-in append says
// nothing about small units, stopping or waiting; a stored copy of an earlier built-in append is the built-in one.
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.3.0", getPath: () => "/tmp/rg-user-data", getLocale: () => "ko" },
  nativeTheme: { themeSource: "system" },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

import { DEFAULTS, engineSettings } from "./settings";
import { sanitizeSettingsPatch } from "./settingsGuard";
import { DEFAULT_SYSTEM_PROMPT_APPEND, isLegacySystemPromptAppend } from "../shared/systemPrompt";

const LEGACY =
  "You are working inside a review gate. Work in small units: at most {maxFiles} files and about {maxLines} changed lines per reply. " +
  "After finishing one unit, STOP and report what you changed and what the next unit would be; wait for the user. " +
  "Run git commands that change the repository (commit, merge, pull, checkout, reset, stash, …) only when the user asks — " +
  "the app shows the user an approval card for each. If an edit is denied with 'REVIEW GATE', stop immediately and report.";

describe("change limit (§54)", () => {
  it("is off by default: no budget, and the built-in append never asks Claude to stop", () => {
    expect(DEFAULTS.budgetEnabled).toBe(false);
    expect(DEFAULTS.systemPromptAppend).toBe("");
    const s = engineSettings({ ...DEFAULTS }, null);
    expect(s.budget).toEqual({ maxFiles: 0, maxLines: 0 });
    expect(s.systemPromptAppend).toBe(DEFAULT_SYSTEM_PROMPT_APPEND);
    for (const word of ["small units", "STOP", "wait for the user", "REVIEW GATE"]) expect(s.systemPromptAppend).not.toContain(word);
    expect(s.systemPromptAppend).toContain("only when the user or a skill they ran asks"); // the git sentence stays
    expect(s.systemPromptAppend).not.toContain("approval card"); // r1-git (§46): no card for every git command any more
    // A settings file from before the switch has no `budgetEnabled`: off.
    const old = { ...DEFAULTS } as Record<string, unknown>;
    delete old.budgetEnabled;
    expect(engineSettings(old as never, null).budget).toEqual({ maxFiles: 0, maxLines: 0 });
  });

  it("on: the numbers go out and the built-in append names them, without stopping", () => {
    const s = engineSettings({ ...DEFAULTS, budgetEnabled: true, budgetMaxFiles: 25 }, null);
    expect(s.budget).toEqual({ maxFiles: 25, maxLines: 400, hardMultiplier: 2 });
    expect(s.systemPromptAppend.startsWith(`${DEFAULT_SYSTEM_PROMPT_APPEND} The user set a change limit of 25 files and about 400 changed lines per reply`)).toBe(true);
    expect(s.systemPromptAppend).not.toMatch(/STOP|wait for the user|small units/);
  });

  it("a stored earlier built-in append is the built-in one; the user's own stays, its placeholders get the limit's numbers", () => {
    expect(isLegacySystemPromptAppend(LEGACY)).toBe(true);
    // r1-git: §54's first built-in append (the approval-card promise) is an earlier one now too.
    const FIRST = "You are working inside a review gate. Run git commands that change the repository (commit, merge, pull, checkout, reset, stash, …) only when the user asks — the app shows the user an approval card for each.";
    expect(isLegacySystemPromptAppend(FIRST)).toBe(true);
    expect(engineSettings({ ...DEFAULTS, systemPromptAppend: FIRST }, null).systemPromptAppend).toBe(DEFAULT_SYSTEM_PROMPT_APPEND);
    expect(isLegacySystemPromptAppend(`  ${LEGACY}\n`)).toBe(true);
    expect(isLegacySystemPromptAppend("my own words")).toBe(false);
    expect(engineSettings({ ...DEFAULTS, systemPromptAppend: LEGACY }, null).systemPromptAppend).toBe(DEFAULT_SYSTEM_PROMPT_APPEND);
    const own = engineSettings({ ...DEFAULTS, systemPromptAppend: "Keep replies within {maxFiles} files / {maxLines} lines." }, null);
    expect(own.systemPromptAppend).toBe("Keep replies within 10 files / 400 lines.");
    expect(engineSettings({ ...DEFAULTS, budgetEnabled: true, systemPromptAppend: "mine" }, null).systemPromptAppend).toBe("mine");
  });

  it("the renderer may write budgetEnabled as a boolean only", () => {
    expect(sanitizeSettingsPatch({ budgetEnabled: true })).toEqual({ patch: { budgetEnabled: true }, rejected: [] });
    expect(sanitizeSettingsPatch({ budgetEnabled: "yes" }).rejected).toEqual(["budgetEnabled"]);
  });
});
