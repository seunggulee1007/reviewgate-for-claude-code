// §48 Windows (the Mac's P5-sheets-48): the launch after an update's restart reopens the windows that were open, once,
// whatever "Reopen last projects" says.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const settings: Record<string, unknown> = {};
vi.mock("electron", () => ({ screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) } }));
vi.mock("./settings.js", () => ({ loadSettings: () => settings, saveSettings: (p: Record<string, unknown>) => Object.assign(settings, p) }));
vi.mock("./log.js", () => ({ logLine: () => undefined }));

import { restorableWindows } from "./windowState";

const project = mkdtempSync(join(tmpdir(), "rg-restore-once-"));
afterAll(() => rmSync(project, { recursive: true, force: true }));

describe("reopening after an update's restart", () => {
  it("reopens once with the switch off, then follows the switch again", () => {
    Object.assign(settings, { reopenLastProjects: false, openWindows: [{ path: project }], restoreOnceAfterRelaunch: true });
    expect(restorableWindows().map((w) => w.path)).toEqual([project]);
    expect(settings["restoreOnceAfterRelaunch"]).toBeUndefined();
    expect(restorableWindows()).toEqual([]);
  });

  it("with the switch on nothing changes", () => {
    Object.assign(settings, { reopenLastProjects: true, openWindows: [{ path: project }], restoreOnceAfterRelaunch: undefined });
    expect(restorableWindows().map((w) => w.path)).toEqual([project]);
  });
});
