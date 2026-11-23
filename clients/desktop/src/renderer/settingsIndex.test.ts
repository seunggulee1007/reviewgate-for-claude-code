import { describe, expect, it } from "vitest";
import type { AppSettings } from "../shared/ipc";
import {
  SETTINGS_INDEX,
  SETTINGS_TABS,
  appliesBadge,
  changedSince,
  nextSessionStart,
  searchSettings,
  sessionStartValues,
  settingApplies,
  settingEntry,
  settingsTabOf,
} from "./settingsIndex";

// docs/PROTOCOL.md §55.11 on Windows: the tabs, the search across them and when a change applies (the Mac's
// SettingsCatalogTests).
const korean: Record<string, string> = {
  "Auto-allow Bash": "Bash 자동 허용",
  Permissions: "권한",
  "System prompt append": "시스템 프롬프트 추가문",
};
const ids = (q: string) => searchSettings(q, (k) => korean[k] ?? k).map((e) => e.id);

const settings = (over: Partial<AppSettings> = {}) =>
  ({ autoAllowBash: false, loadUserSettings: true, systemPromptAppend: "", budgetEnabled: false, budgetMaxFiles: 10, budgetMaxLines: 400, claudePath: "", ...over }) as AppSettings;

describe("Settings search", () => {
  it("finds by title in either language, any case, every word", () => {
    expect(ids("bash")).toContain("autoAllowBash");
    expect(ids("BASH")).toContain("autoAllowReadOnlyBash");
    expect(ids("자동 허용")).toContain("autoAllowBash");
    expect(ids("bash read-only")).toEqual(["autoAllowReadOnlyBash"]);
  });

  it("finds by explanation, section and tab name", () => {
    expect(ids("{maxFiles}")).toEqual(["systemPromptAppend"]);
    expect(ids("heap dump")).toEqual(["largeFileMB"]);
    const byTab = ids("권한");
    expect(byTab).toContain("bashAllowPatterns");
    expect(byTab).toContain("allowWorktreeIsolation");
    expect(byTab).not.toContain("confirmQuit");
  });

  it("an empty or nonsense query finds nothing; results keep the tab order", () => {
    expect(ids("")).toEqual([]);
    expect(ids("   ")).toEqual([]);
    expect(ids("zzz-nothing")).toEqual([]);
    const order = SETTINGS_TABS.map((t) => t.id);
    const tabs = searchSettings("a").map((e) => order.indexOf(e.tab));
    expect(tabs).toEqual([...tabs].sort((a, b) => a - b));
  });

  it("§63: Settings › Tasks is in the search — the MCP server, the branch prefix, the start screen; by its Korean tab name too", () => {
    expect(ids("MCP")).toContain("taskMcpServer");
    expect(ids("branch prefix")).toContain("taskBranchPrefix");
    expect(ids("start screen")).toContain("skipStartScreen");
    expect(ids("{body}")).toEqual(["taskPromptTemplate"]);
    expect(searchSettings("업무", (k) => (k === "Tasks" ? "업무" : k)).map((e) => e.id)).toEqual(["skipStartScreen", "taskPlatform", "taskBranchPrefix", "taskStartLocation", "taskMcpServer", "taskPromptTemplate"]);
    expect(settingEntry("skipStartScreen")?.tab).toBe("tasks");
    expect(settingApplies("taskPlatform")).toBe("immediately");
    expect(SETTINGS_TABS.map((tab) => tab.id).indexOf("tasks")).toBe(SETTINGS_TABS.map((tab) => tab.id).indexOf("git") + 1); // after Git, as on the Mac
  });

  it("ids are unique, every tab has rows, an unknown tab opens General", () => {
    const all = SETTINGS_INDEX.map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
    for (const tab of SETTINGS_TABS) expect(SETTINGS_INDEX.some((e) => e.tab === tab.id)).toBe(true);
    expect(settingsTabOf("permissions")).toBe("permissions");
    expect(settingsTabOf("gone")).toBe("general");
    expect(settingsTabOf(undefined)).toBe("general");
  });
});

describe("when a change applies", () => {
  it("the session-start settings wait for the next session; the rest apply at once", () => {
    for (const id of ["autoAllowBash", "loadUserSettings", "systemPromptAppend", "backgroundWork", "subagentsInTurn", "maxTurnsLimit", "allowWorktreeIsolation", "claudePath", "cliPin", "terminalFullRepaint"]) {
      expect(settingApplies(id), id).toBe("nextSession");
    }
    for (const id of ["autoAllowReadOnlyBash", "bashAllowPatterns", "applyUserAllowRules", "budgetEnabled", "sideModel", "checkpointIgnorePatterns", "commitTrailer"]) {
      expect(settingApplies(id), id).toBe("immediately");
    }
    expect(settingApplies("permissionMode")).toBe("newProject");
    expect(appliesBadge("immediately")).toBeNull();
    expect(appliesBadge("nextSession")).toBe("Next session");
  });

  it("what waits: changed since the session started, nothing once changed back or restarted", () => {
    const open = { open: true, starting: false };
    let start = nextSessionStart(null, { open: true, starting: true }, settings(), null);
    expect(start).not.toBeNull();
    const now = settings({ autoAllowBash: true, systemPromptAppend: "Keep it short." });
    expect(changedSince(start!, sessionStartValues(now))).toEqual(["autoAllowBash", "systemPromptAppend"]);
    expect(changedSince(start!, sessionStartValues(settings()))).toEqual([]);
    // Every id it can name is a "next session" row.
    for (const id of changedSince(start!, sessionStartValues(settings({ autoAllowBash: true, loadUserSettings: false, backgroundWork: false, subagentsInTurn: true, maxTurnsLimit: true, maxTurns: 50, allowWorktreeIsolation: false, claudePath: "C:\\Users\\dev\\claude.exe", terminalFullRepaint: false, systemPromptAppend: "x" })))) {
      expect(settingApplies(id), id).toBe("nextSession");
    }
    // The built-in prompt carries the limit's sentence: switching the limit changes what the next session gets.
    expect(changedSince(start!, sessionStartValues(settings({ budgetEnabled: true })))).toEqual(["systemPromptAppend"]);
    // A restart takes the settings now; a closed project drops it; no settings yet keeps waiting for them.
    start = nextSessionStart(open, { open: true, starting: true }, now, start);
    expect(changedSince(start!, sessionStartValues(now))).toEqual([]);
    expect(nextSessionStart(open, open, now, start)).toBe(start);
    expect(nextSessionStart(open, { open: false, starting: false }, now, start)).toBeNull();
    expect(nextSessionStart(null, open, null, null)).toBeNull();
  });
});
