// §48 Windows through main's update.ts (Electron mocked, the download and the location check stubbed): [Install and Restart]
// → the record and the quit hook → the installer started once the engines stopped; an installer that cannot start → the
// record says why and the app reopens; the next launch says it once and installs nothing by itself. Each "launch" is a
// fresh import of the module (a new process).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { INSTALLER_ARGS, type SpawnInstaller } from "./updateInstall";

const h = vi.hoisted(() => ({ userData: "", version: "0.5.17", settings: {} as Record<string, unknown>, relaunched: [] as number[], mode: { kind: "user" } as { kind: "user" | "elevated" } }));
h.userData = mkdtempSync(join(tmpdir(), "rg-update-flow-"));
afterAll(() => rmSync(h.userData, { recursive: true, force: true }));
vi.mock("electron", () => ({
  app: { getVersion: () => h.version, isPackaged: true, getPath: () => h.userData, relaunch: () => h.relaunched.push(1), quit: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  ipcMain: { handle: () => undefined },
  net: { fetch: async () => ({ ok: false, status: 500 }), request: () => undefined },
  shell: { openExternal: async () => undefined },
}));
vi.mock("./settings.js", () => ({ loadSettings: () => h.settings, saveSettings: (p: Record<string, unknown>) => Object.assign(h.settings, p) }));
vi.mock("./log.js", () => ({ logLine: () => undefined }));
// The bytes are not the point here (updateDownload.test.ts serves real ones): each "download" writes its file.
vi.mock("./updateDownload.js", async (orig) => ({
  ...(await orig<typeof import("./updateDownload")>()),
  downloadTo: async (url: string, dest: string) => {
    writeFileSync(dest, url.endsWith(".sha256") ? "ab".repeat(32) : "MZ");
    return 2;
  },
}));
vi.mock("./updateVerify.js", async (orig) => ({ ...(await orig<typeof import("./updateVerify")>()), verifyInstaller: async () => null }));
vi.mock("./updateInstall.js", async (orig) => ({ ...(await orig<typeof import("./updateInstall")>()), installMode: () => h.mode }));

const base = "https://github.com/seunggulee1007/reviewgate-for-claude-code/releases/download/v0.6.0/";
const release = {
  tag_name: "v0.6.0",
  html_url: "https://github.com/seunggulee1007/reviewgate-for-claude-code/releases/tag/v0.6.0",
  draft: false,
  prerelease: false,
  body: "notes",
  assets: [
    { name: "ReviewGate-Setup-0.6.0.exe", browser_download_url: `${base}ReviewGate-Setup-0.6.0.exe`, size: 2 },
    { name: "ReviewGate-Setup-0.6.0.exe.sha256", browser_download_url: `${base}ReviewGate-Setup-0.6.0.exe.sha256`, size: 64 },
  ],
};
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};
/** A launch of the app at `version`: a fresh module, its hooks installed. */
async function launch(version: string, quit: () => void = () => undefined) {
  h.version = version;
  vi.resetModules();
  const m = await import("./update");
  m.installUpdates({ blockers: () => [], quit, focus: () => undefined });
  return m;
}
const started = (calls: Array<[string, readonly string[]]>): SpawnInstaller => (file, args) => {
  calls.push([file, args]);
  return { once: (e: string, cb: () => void) => (e === "spawn" ? queueMicrotask(cb) : undefined), unref: () => undefined } as ReturnType<SpawnInstaller>;
};
const cannotStart: SpawnInstaller = () => ({ once: (e: string, cb: (x: Error) => void) => (e === "error" ? queueMicrotask(() => cb(new Error("spawn UNKNOWN"))) : undefined), unref: () => undefined }) as ReturnType<SpawnInstaller>;

describe("the Windows update through main (§48)", () => {
  it("installs: the record, the quit, then the installer once the engines stopped; the next launch says Updated, once", async () => {
    let quits = 0;
    const m = await launch("0.5.17", () => void quits++);
    await m.checkOnce(async () => ({ ok: true, json: release }));
    expect(m.updateStatus().release).toMatchObject({ version: "0.6.0", why: null });
    await m.installNow();
    await until(() => quits > 0);
    expect(quits).toBe(1);
    expect(h.settings["pendingUpdateInstall"]).toEqual({ from: "0.5.17", to: "0.6.0" });
    expect(h.settings["restoreOnceAfterRelaunch"]).toBe(true);
    expect(m.updateStatus().install).toEqual({ kind: "ready", version: "0.6.0" });

    const calls: Array<[string, readonly string[]]> = [];
    await m.afterEnginesStopped(started(calls));
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toMatch(/updates[\\/]0\.6\.0-[0-9a-f]{8}[\\/]ReviewGate-Setup-0\.6\.0\.exe$/);
    expect(calls[0]![1]).toEqual(INSTALLER_ARGS);
    expect(h.relaunched).toEqual([]);
    await m.afterEnginesStopped(started(calls));
    expect(calls.length).toBe(1);

    const next = await launch("0.6.0");
    expect(next.updateStatus().notice).toEqual({ kind: "updated", version: "0.6.0", from: "0.5.17", hasNotes: false });
    expect(h.settings["pendingUpdateInstall"]).toBeUndefined();
    const third = await launch("0.6.0");
    expect(third.updateStatus().notice).toBeNull();
  });

  it("an installer that cannot start: the record says why, the app reopens, that launch says it did not install and installs nothing by itself", async () => {
    let quits = 0;
    const m = await launch("0.5.17", () => void quits++);
    await m.checkOnce(async () => ({ ok: true, json: release }));
    await m.installNow();
    await until(() => quits > 0);
    await m.afterEnginesStopped(cannotStart);
    expect(h.settings["pendingUpdateInstall"]).toEqual({ from: "0.5.17", to: "0.6.0", why: "The installer could not start: spawn UNKNOWN" });
    expect(h.relaunched).toEqual([1]);

    let laterQuits = 0;
    const next = await launch("0.5.17", () => void laterQuits++);
    expect(next.updateStatus().notice).toEqual({ kind: "failed", version: "0.6.0", why: "The installer could not start: spawn UNKNOWN" });
    expect(h.settings["pendingUpdateInstall"]).toBeUndefined();
    await new Promise((r) => setTimeout(r, 2500));
    expect(next.updateStatus().install).toBeNull();
    expect(laterQuits).toBe(0);
    expect(h.settings["pendingUpdateInstall"]).toBeUndefined();
  });
  it("a release without its installer yet: Install off and why; once it is attached, Install is on", async () => {
    h.mode = { kind: "user" };
    const m = await launch("0.5.17");
    await m.checkOnce(async () => ({ ok: true, json: { ...release, assets: [] } }));
    expect(m.updateStatus().release).toMatchObject({ version: "0.6.0", why: "The Windows installer is still being uploaded — ReviewGate checks again by itself." });
    await m.checkOnce(async () => ({ ok: true, json: release }));
    expect(m.updateStatus().release).toMatchObject({ version: "0.6.0", why: null });
  });

  it("an install for all users: the installer is started elevated; the prompt declined → the record says so and the app reopens", async () => {
    h.mode = { kind: "elevated" };
    try {
      let quits = 0;
      const m = await launch("0.5.17", () => void quits++);
      await m.checkOnce(async () => ({ ok: true, json: release }));
      expect(m.updateStatus().release).toMatchObject({ why: null });
      await m.installNow();
      await until(() => quits > 0);
      const relaunched = h.relaunched.length;
      const calls: Array<[string, readonly string[]]> = [];
      const declined: SpawnInstaller = (file, args) => {
        calls.push([file, args]);
        return { once: (e: string, cb: (c: number | null) => void) => (e === "exit" ? queueMicrotask(() => cb(1)) : undefined), unref: () => undefined } as ReturnType<SpawnInstaller>;
      };
      await m.afterEnginesStopped(declined);
      expect(calls[0]![0]).toMatch(/powershell\.exe$/);
      expect(Buffer.from(calls[0]![1][3]!, "base64").toString("utf16le")).toMatch(/ReviewGate-Setup-0\.6\.0\.exe' -ArgumentList '\/S','\/allusers','--updated','--force-run' .* -Verb RunAs/);
      expect(h.settings["pendingUpdateInstall"]).toEqual({ from: "0.5.17", to: "0.6.0", why: "Administrator rights were not given — the installer did not run." });
      expect(h.relaunched.length).toBe(relaunched + 1);
      const next = await launch("0.5.17");
      expect(next.updateStatus().notice).toEqual({ kind: "failed", version: "0.6.0", why: "Administrator rights were not given — the installer did not run." });
    } finally {
      h.mode = { kind: "user" };
    }
  });
});
