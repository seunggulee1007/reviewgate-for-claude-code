// MARK: polish p-lifecycle — P5-sheets-49: the Windows client notices a new release (the Mac's §48 check); §48 Windows: what
// the banner is told, the record the launch takes once, and the installer started after the engines stopped.
import { describe, expect, it, vi } from "vitest";

const settings: Record<string, unknown> = {};
const sent: unknown[] = [];
const relaunched: number[] = [];
vi.mock("electron", () => ({
  app: { getVersion: () => "0.5.10", isPackaged: false, getPath: () => "/tmp/rg-update-test-user-data", relaunch: () => relaunched.push(1), quit: () => undefined },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_c: string, s: unknown) => sent.push(s) } }], getFocusedWindow: () => null },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  ipcMain: { handle: () => undefined },
  net: { fetch: async () => ({ ok: false, status: 500 }) },
  shell: { openExternal: async () => undefined },
}));
vi.mock("./settings.js", () => ({ loadSettings: () => settings, saveSettings: (p: Record<string, unknown>) => Object.assign(settings, p) }));
vi.mock("./log.js", () => ({ logLine: () => undefined }));

import { afterEnginesStopped, checkOnce, installNow, outcomeOf, parseRelease, updateStatus } from "./update";
import type { SpawnInstaller } from "./updateInstall";
import type { UpdateStatus } from "../shared/ipc";

const PAGE = "https://github.com/seunggulee1007/reviewgate-for-claude-code/releases/tag";
const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, html_url: `${PAGE}/${tag}`, draft: false, prerelease: false, body: "- a change", ...extra });

describe("the update check (P5-sheets-49)", () => {
  it("reads the release and compares it with the running version", () => {
    expect(parseRelease(release("v0.6.0"))).toEqual({ version: "0.6.0", tag: "v0.6.0", page: `${PAGE}/v0.6.0`, notes: "- a change", assets: null });
    expect(parseRelease(release("v0.6.0", { prerelease: true }))).toBeNull();
    expect(parseRelease(release("nightly"))).toBeNull();
    // A page that is not GitHub's is never opened: the releases page of the tag instead.
    expect(parseRelease(release("v0.6.0", { html_url: "https://tasks.example.com/x" }))?.page).toBe(`${PAGE}/v0.6.0`);
    expect(outcomeOf(release("v0.5.11"), "0.5.10")).toMatchObject({ kind: "available", release: { version: "0.5.11" } });
    expect(outcomeOf(release("v0.5.10"), "0.5.10")).toEqual({ kind: "upToDate", latest: "0.5.10" });
    expect(outcomeOf({ message: "Not Found" }, "0.5.10").kind).toBe("unavailable");
  });

  it("reads the Windows installer and its checksum from the release's assets", () => {
    const base = "https://github.com/seunggulee1007/reviewgate-for-claude-code/releases/download/v0.6.0/";
    const assets = [
      { name: "ReviewGate-Setup-0.6.0.exe", browser_download_url: `${base}ReviewGate-Setup-0.6.0.exe`, size: 115_000_000 },
      { name: "ReviewGate-Setup-0.6.0.exe.sha256", browser_download_url: `${base}ReviewGate-Setup-0.6.0.exe.sha256`, size: 94 },
    ];
    expect(parseRelease(release("v0.6.0", { assets }))?.assets?.installer).toMatchObject({ name: "ReviewGate-Setup-0.6.0.exe", size: 115_000_000 });
  });

  it("a newer release reaches every window's banner; Later for it keeps it quiet, a newer one shows again", async () => {
    expect(await checkOnce(async () => ({ ok: true, json: release("v0.6.0") }))).toMatchObject({ kind: "available" });
    expect(updateStatus()).toMatchObject({ current: "0.5.10", release: { version: "0.6.0", page: `${PAGE}/v0.6.0`, hasNotes: true }, install: null, notice: null, downloadPage: `${PAGE}/v0.6.0`, checking: false });
    expect((sent.at(-1) as UpdateStatus).release?.version).toBe("0.6.0");
    expect(updateStatus().lastCheck?.text).toBe("ReviewGate 0.6.0 is available");
    settings["dismissedUpdateVersion"] = "0.6.0";
    expect(updateStatus().release).toBeNull();
    await checkOnce(async () => ({ ok: true, json: release("v0.6.1") }));
    expect(updateStatus().release?.version).toBe("0.6.1");
    // Up to date again (a reinstall): no banner.
    await checkOnce(async () => ({ ok: true, json: release("v0.5.10") }));
    expect(updateStatus().release).toBeNull();
    expect(updateStatus().lastCheck?.text).toBe("ReviewGate is up to date");
  });

  it("a failed check keeps what an earlier one found and says why", async () => {
    await checkOnce(async () => ({ ok: true, json: release("v0.6.2") }));
    const failed = await checkOnce(async () => ({ ok: false, why: "GitHub could not be reached. Check the network connection and try again." }));
    expect(failed).toEqual({ kind: "unavailable", why: "GitHub could not be reached. Check the network connection and try again." });
    expect(updateStatus().release?.version).toBe("0.6.2");
    expect(updateStatus().lastCheck?.text).toBe("GitHub could not be reached. Check the network connection and try again.");
  });

  it("a copy that cannot install (here: not the packaged Windows app) says why and installs nothing", async () => {
    await checkOnce(async () => ({ ok: true, json: release("v0.6.2") }));
    expect(updateStatus().release?.why).toBeTruthy();
    await installNow();
    expect(updateStatus().install).toBeNull();
    expect(settings["pendingUpdateInstall"]).toBeUndefined();
  });
});

describe("the installer after the engines stopped (§48 Windows)", () => {
  it("nothing prepared → nothing started", async () => {
    const spawn = vi.fn() as unknown as SpawnInstaller;
    await afterEnginesStopped(spawn);
    expect(spawn).not.toHaveBeenCalled();
    expect(relaunched).toEqual([]);
  });
});
