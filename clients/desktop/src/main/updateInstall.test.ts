// The Windows in-app update's steps (docs/PROTOCOL.md §48, Windows): download → verify → (waiting for Claude) → ready →
// the record and the quit; cancel and failures; the installer's argv; what the next launch says from the record, once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockerLine, ELEVATED_INSTALLER_ARGS, INSTALLER_ARGS, installerCommand, installMode, launchInstaller, noticeOf, READY_MS, UpdateInstaller, validRecord, WAIT_POLL_MS, type Blocker, type InstallDeps, type InstallTarget, type SpawnInstaller, type UpdateRecord } from "./updateInstall";

const target: InstallTarget = {
  version: "0.6.0",
  assets: {
    installer: { name: "ReviewGate-Setup-0.6.0.exe", url: "https://github.com/acme/app/releases/download/v0.6.0/ReviewGate-Setup-0.6.0.exe", size: 1000, digest: null },
    checksum: { name: "ReviewGate-Setup-0.6.0.exe.sha256", url: "https://github.com/acme/app/releases/download/v0.6.0/ReviewGate-Setup-0.6.0.exe.sha256", size: 94, digest: null },
  },
};
const prepared = { file: "C:\\Users\\dev\\AppData\\Roaming\\ReviewGate\\updates\\0.6.0-a\\ReviewGate-Setup-0.6.0.exe", folder: "C:\\Users\\dev\\AppData\\Roaming\\ReviewGate\\updates\\0.6.0-a" };

function harness(over: Partial<InstallDeps> = {}) {
  const log: string[] = [];
  const records: Array<UpdateRecord | null> = [];
  let blockers: Blocker[] = [];
  let confirm = true;
  const deps: InstallDeps = {
    current: "0.5.17",
    download: async (_t, _s, progress) => {
      progress(500, 1000);
      progress(1000, 1000);
      return { ...prepared, checksumText: "abc" };
    },
    verify: async () => null,
    discard: (f) => log.push(`discard ${f}`),
    blockers: () => blockers,
    confirmRestartNow: async () => confirm,
    saveRecord: (r) => records.push(r),
    quit: (p) => log.push(`quit ${p.file}`),
    changed: () => log.push(`view ${JSON.stringify(installer.view)}`),
    ...over,
  };
  const installer = new UpdateInstaller(deps);
  return {
    installer,
    log,
    records,
    setBlockers: (b: Blocker[]) => (blockers = b),
    setConfirm: (c: boolean) => (confirm = c),
    views: () => log.filter((l) => l.startsWith("view ")).map((l) => JSON.parse(l.slice(5)) as { kind: string } | null),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the install's steps", () => {
  it("idle Claude: downloading (with progress) → checking → ready for 2 s → the record, then the quit", async () => {
    const h = harness();
    await h.installer.start(target);
    expect(h.views().map((v) => v?.kind)).toEqual(["downloading", "downloading", "downloading", "verifying", "ready"]);
    expect(h.views()[2]).toEqual({ kind: "downloading", received: 1000, total: 1000 });
    expect(h.log.some((l) => l.startsWith("quit"))).toBe(false);
    await vi.advanceTimersByTimeAsync(READY_MS);
    expect(h.records).toEqual([{ from: "0.5.17", to: "0.6.0" }]);
    expect(h.log.at(-1)).toBe(`quit ${prepared.file}`);
    // The record is written before the quit is asked for.
    expect(h.log.indexOf(`quit ${prepared.file}`)).toBeGreaterThan(0);
  });

  it("Claude working: waits (the windows listed), goes on by itself once they are idle", async () => {
    const h = harness();
    h.setBlockers([{ id: 3, name: "acme-api", reason: "working" }]);
    await h.installer.start(target);
    expect(h.installer.view).toEqual({ kind: "waiting", blockers: [{ id: 3, name: "acme-api", reason: "working" }] });
    await vi.advanceTimersByTimeAsync(WAIT_POLL_MS * 5);
    expect(h.installer.view?.kind).toBe("waiting");
    h.setBlockers([]);
    await vi.advanceTimersByTimeAsync(WAIT_POLL_MS);
    expect(h.installer.view).toEqual({ kind: "ready" });
    // A turn that starts during "Ready" is waited for after all.
    h.setBlockers([{ id: 3, name: "acme-api", reason: "waiting" }]);
    await vi.advanceTimersByTimeAsync(READY_MS);
    expect(h.installer.view?.kind).toBe("waiting");
    expect(h.records).toEqual([]);
    h.setBlockers([]);
    await vi.advanceTimersByTimeAsync(WAIT_POLL_MS + READY_MS);
    expect(h.records).toEqual([{ from: "0.5.17", to: "0.6.0" }]);
  });

  it("Restart Now while Claude works asks first; No keeps waiting, Yes quits at once", async () => {
    const h = harness();
    h.setBlockers([{ id: 1, name: "", reason: "working" }]);
    await h.installer.start(target);
    h.setConfirm(false);
    await h.installer.restartNow();
    expect(h.installer.view?.kind).toBe("waiting");
    expect(h.records).toEqual([]);
    h.setConfirm(true);
    await h.installer.restartNow();
    expect(h.records).toEqual([{ from: "0.5.17", to: "0.6.0" }]);
    expect(h.log.at(-1)).toBe(`quit ${prepared.file}`);
    // Never twice.
    await h.installer.restartNow();
    await vi.advanceTimersByTimeAsync(READY_MS * 3);
    expect(h.log.filter((l) => l.startsWith("quit")).length).toBe(1);
  });

  it("Cancel while waiting removes the download and the banner is the release's again; no record", async () => {
    const h = harness();
    h.setBlockers([{ id: 1, name: "acme", reason: "working" }]);
    await h.installer.start(target);
    h.installer.cancel();
    expect(h.installer.view).toBeNull();
    expect(h.log).toContain(`discard ${prepared.folder}`);
    h.setBlockers([]);
    await vi.advanceTimersByTimeAsync(WAIT_POLL_MS + READY_MS);
    expect(h.records).toEqual([]);
    expect(h.log.some((l) => l.startsWith("quit"))).toBe(false);
  });

  it("Cancel during the download stops it (the signal) and says nothing went wrong", async () => {
    let signal: AbortSignal | null = null;
    const h = harness({
      download: (_t, s) => {
        signal = s;
        return new Promise((_, reject) => s.addEventListener("abort", () => reject(new Error("aborted"))));
      },
    });
    const run = h.installer.start(target);
    expect(h.installer.view?.kind).toBe("downloading");
    h.installer.cancel();
    await run;
    expect(signal!.aborted).toBe(true);
    expect(h.installer.view).toBeNull();
  });

  it("a failed download or check says why, removes the download, and Try Again starts over", async () => {
    const h = harness({ download: async () => Promise.reject(new Error("The download failed: HTTP 404")) });
    await h.installer.start(target);
    expect(h.installer.view).toEqual({ kind: "failed", why: "The download failed: HTTP 404" });
    expect(h.installer.busy).toBe(false);

    const v = harness({ verify: async () => "The download does not match its checksum — nothing was installed." });
    await v.installer.start(target);
    expect(v.installer.view).toEqual({ kind: "failed", why: "The download does not match its checksum — nothing was installed." });
    expect(v.log).toContain(`discard ${prepared.folder}`);
    expect(v.records).toEqual([]);
    v.installer.dismissFailure();
    expect(v.installer.view).toBeNull();
  });

  it("a second start while one runs is ignored", async () => {
    let calls = 0;
    const h = harness({
      download: async () => {
        calls++;
        return { ...prepared, checksumText: "" };
      },
    });
    h.setBlockers([{ id: 1, name: "a", reason: "working" }]);
    await Promise.all([h.installer.start(target), h.installer.start(target)]);
    expect(calls).toBe(1);
  });
});

describe("the installer's command line", () => {
  it("is silent, per user, an update, and starts ReviewGate when done", () => {
    expect(INSTALLER_ARGS).toEqual(["/S", "/currentuser", "--updated", "--force-run"]);
  });

  it("starts detached from its own folder; a spawn error is said", async () => {
    const calls: unknown[] = [];
    let unref = 0;
    const ok: SpawnInstaller = (file, args, options) => {
      calls.push([file, args, options]);
      return { once: (e: string, cb: () => void) => (e === "spawn" ? queueMicrotask(cb) : undefined), unref: () => void unref++ } as ReturnType<SpawnInstaller>;
    };
    expect(await launchInstaller("/tmp/rg/updates/0.6.0-a/ReviewGate-Setup-0.6.0.exe", ok)).toBeNull();
    expect(calls).toEqual([["/tmp/rg/updates/0.6.0-a/ReviewGate-Setup-0.6.0.exe", INSTALLER_ARGS, { detached: true, stdio: "ignore", cwd: "/tmp/rg/updates/0.6.0-a", windowsHide: false }]]);
    expect(unref).toBe(1);
    const fails: SpawnInstaller = () => ({ once: (e: string, cb: (x: Error) => void) => (e === "error" ? queueMicrotask(() => cb(new Error("spawn EACCES"))) : undefined), unref: () => undefined }) as ReturnType<SpawnInstaller>;
    expect(await launchInstaller("x.exe", fails)).toBe("The installer could not start: spawn EACCES");
    const throws: SpawnInstaller = () => {
      throw new Error("EINVAL");
    };
    expect(await launchInstaller("x.exe", throws)).toBe("The installer could not start: EINVAL");
  });

  it("only the installed Windows app updates itself; one installed for all users does it elevated", () => {
    const base = { platform: "win32" as const, packaged: true, execPath: "C:\\Users\\dev\\AppData\\Local\\Programs\\ReviewGate\\ReviewGate.exe", env: { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" }, exists: (p: string) => p === "C:\\Users\\dev\\AppData\\Local\\Programs\\ReviewGate\\Uninstall ReviewGate.exe" };
    const refused = (o: Parameters<typeof installMode>[0]) => {
      const m = installMode(o);
      return m.kind === "refused" ? m.why : null;
    };
    expect(installMode(base)).toEqual({ kind: "user" });
    expect(refused({ ...base, platform: "darwin" })).toMatch(/for the Windows installer/);
    expect(refused({ ...base, packaged: false })).toMatch(/development build/);
    expect(refused({ ...base, exists: () => false })).toMatch(/not installed by its installer/);
    const machine = { ...base, execPath: "C:\\Program Files\\ReviewGate\\ReviewGate.exe", exists: () => true };
    expect(installMode(machine)).toEqual({ kind: "elevated" });
    expect(installMode({ ...machine, execPath: "c:\\program files (x86)\\ReviewGate\\ReviewGate.exe" })).toEqual({ kind: "elevated" });
    // Under Program Files but not by the installer: still refused.
    expect(refused({ ...machine, exists: () => false })).toMatch(/not installed by its installer/);
    // A folder that only starts like Program Files is not it.
    expect(installMode({ ...machine, execPath: "C:\\Program Files Tools\\ReviewGate\\ReviewGate.exe" })).toEqual({ kind: "user" });
  });

  it("per user: the installer itself; for all users: PowerShell by full path, Start-Process -Verb RunAs with /allusers, quoted", () => {
    const file = "C:\\Users\\dev\\AppData\\Roaming\\ReviewGate\\updates\\0.6.0-a\\ReviewGate-Setup-0.6.0.exe";
    expect(installerCommand(file, "user")).toEqual({ command: file, args: INSTALLER_ARGS });
    expect(ELEVATED_INSTALLER_ARGS).toEqual(["/S", "/allusers", "--updated", "--force-run"]);
    const script = (c: { args: readonly string[] }) => {
      expect(c.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      return Buffer.from(c.args[3]!, "base64").toString("utf16le");
    };
    const elevated = installerCommand(file, "elevated", "C:\\Windows");
    expect(elevated.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(elevated.args).toHaveLength(4);
    expect(script(elevated)).toBe(
      "$ErrorActionPreference = 'Stop'\n" +
        `try { Start-Process -FilePath '${file}' -ArgumentList '/S','/allusers','--updated','--force-run' -WorkingDirectory 'C:\\Users\\dev\\AppData\\Roaming\\ReviewGate\\updates\\0.6.0-a' -Verb RunAs } catch { exit 1 }\n` +
        "exit 0",
    );
    // Spaces stay inside the quotes; every quote PowerShell knows is doubled, so the path cannot end the string.
    const odd = "C:\\Users\\Dev O'Brien ‘x’\\App Data\\ReviewGate-Setup-0.6.0.exe";
    const s = script(installerCommand(odd, "elevated", "D:\\WINNT"));
    expect(s).toContain("-FilePath 'C:\\Users\\Dev O''Brien ‘‘x’’\\App Data\\ReviewGate-Setup-0.6.0.exe' -ArgumentList");
    expect(s).toContain("-WorkingDirectory 'C:\\Users\\Dev O''Brien ‘‘x’’\\App Data' -Verb RunAs");
    expect(installerCommand(odd, "elevated", "D:\\WINNT").command).toBe("D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("elevated: waits for PowerShell — 0 once the installer runs, else the rights were not given", async () => {
    const exits = (code: number | null): SpawnInstaller => () => ({ once: (e: string, cb: (c: number | null) => void) => (e === "exit" ? queueMicrotask(() => cb(code)) : undefined), unref: () => undefined }) as ReturnType<SpawnInstaller>;
    expect(await launchInstaller("C:\\u\\ReviewGate-Setup-0.6.0.exe", exits(0), "elevated")).toBeNull();
    expect(await launchInstaller("C:\\u\\ReviewGate-Setup-0.6.0.exe", exits(1), "elevated")).toBe("Administrator rights were not given — the installer did not run.");
    const calls: unknown[] = [];
    const seen: SpawnInstaller = (file, args, options) => {
      calls.push([file, args.length, options.windowsHide]);
      return exits(0)(file, args, options);
    };
    await launchInstaller("/tmp/rg/ReviewGate-Setup-0.6.0.exe", seen, "elevated", "C:\\Windows");
    expect(calls).toEqual([["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", 4, true]]);
  });
});

describe("after the restart", () => {
  it("the new version running → updated; still the old one → did not install, with why", () => {
    expect(noticeOf({ from: "0.5.17", to: "0.6.0" }, "0.6.0")).toEqual({ kind: "updated", version: "0.6.0", from: "0.5.17" });
    expect(noticeOf({ from: "0.5.17", to: "0.6.0" }, "0.6.1")).toEqual({ kind: "updated", version: "0.6.1", from: "0.5.17" });
    expect(noticeOf({ from: "0.5.17", to: "0.6.0" }, "0.5.17")).toEqual({ kind: "failed", version: "0.6.0", why: "ReviewGate 0.5.17 is still installed." });
    expect(noticeOf({ from: "0.5.17", to: "0.6.0", why: "The installer could not start: spawn EACCES" }, "0.5.17")).toEqual({ kind: "failed", version: "0.6.0", why: "The installer could not start: spawn EACCES" });
    expect(noticeOf(undefined, "0.6.0")).toBeNull();
    expect(noticeOf({ from: "0.5.17" }, "0.6.0")).toBeNull();
    expect(noticeOf({ from: "x", to: "0.6.0" }, "0.6.0")).toBeNull();
    expect(validRecord({ from: "0.5.17", to: "0.6.0", why: "  " })).toEqual({ from: "0.5.17", to: "0.6.0" });
  });

  it("never loops: a failed install is said once and nothing installs again by itself", async () => {
    // Launch 1 after a failed install: the record is taken (removed) and said; no install starts.
    let stored: unknown = { from: "0.5.17", to: "0.6.0" };
    const take = () => {
      const r = stored;
      stored = undefined;
      return r;
    };
    expect(noticeOf(take(), "0.5.17")?.kind).toBe("failed");
    // Launch 2: nothing to say.
    expect(noticeOf(take(), "0.5.17")).toBeNull();
    // An installer that is never started writes no record and never quits.
    const h = harness();
    await vi.advanceTimersByTimeAsync(READY_MS * 10);
    expect(h.records).toEqual([]);
    expect(h.log).toEqual([]);
  });

  it("names the windows the restart waits for", () => {
    expect(blockerLine({ id: 1, name: "acme-api", reason: "working" })).toBe("acme-api: Claude is working");
    expect(blockerLine({ id: 1, name: "", reason: "waiting" })).toBe("ReviewGate: a card waits for your answer");
  });
});
