// MARK: polish p-lifecycle — P1-chrome-02 / P5-sheets-54: closing the last window (✕, Alt+F4 — how Windows apps are quit)
// keeps the window list, so "Reopen last projects" reopens that project at the next launch.
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) } }));
vi.mock("./settings.js", () => ({ loadSettings: () => ({}), saveSettings: () => undefined }));
vi.mock("./log.js", () => ({ logLine: () => undefined }));

import { openWindowsToWrite } from "./windowState";

describe("the window list (P1-chrome-02)", () => {
  it("the windows with a project, in order", () => {
    expect(openWindowsToWrite([{ projectPath: "/work/acme-api", destroyed: false }, { projectPath: null, destroyed: false }, { projectPath: "/work/acme-web", destroyed: false }], false)).toEqual(["/work/acme-api", "/work/acme-web"]);
  });

  it("the last window gone, or the app quitting: the list written stays", () => {
    expect(openWindowsToWrite([], false)).toBeNull();
    expect(openWindowsToWrite([{ projectPath: "/work/acme-api", destroyed: false }], true)).toBeNull();
  });

  it("a window that closed its project but stays writes the list without it (the user closed it)", () => {
    expect(openWindowsToWrite([{ projectPath: null, destroyed: false }], false)).toEqual([]);
    expect(openWindowsToWrite([{ projectPath: "/work/acme-api", destroyed: true }], false)).toEqual([]);
  });
});
