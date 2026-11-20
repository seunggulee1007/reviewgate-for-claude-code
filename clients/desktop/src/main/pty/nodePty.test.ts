import { chmodSync, mkdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conptyFiles, ensureExecutable, loadNodePtyWith, MIN_CONPTY_BUILD, nodePty, nodePtyDir, ptyInfoOf, windowsBuild, WINDOWS_TOO_OLD, type LoadOptions } from "./nodePty.js";
import { runPtySelftest, selftestArg, SELFTEST_MARKER } from "./selftest.js";

const fakeMod = { spawn: () => null };

function opts(o: Partial<LoadOptions> = {}): LoadOptions & { required: string[]; chmodded: string[] } {
  const required: string[] = [];
  const chmodded: string[] = [];
  return {
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.19045",
    packaged: true,
    resourcesPath: "C:\\Users\\dev\\AppData\\Local\\Programs\\ReviewGate\\resources",
    requireFn: (id) => {
      required.push(id);
      return fakeMod;
    },
    resolveDir: () => "/work/acme/node_modules/node-pty",
    ensureExecutable: (p) => void chmodded.push(p),
    ...o,
    required,
    chmodded,
  };
}

describe("node-pty loading (§57.17)", () => {
  it("reads the Windows build from os.release()", () => {
    expect(windowsBuild("10.0.19045")).toBe(19045);
    expect(windowsBuild("10.0.18309")).toBe(MIN_CONPTY_BUILD);
    expect(windowsBuild("6.1.7601")).toBe(7601);
    expect(windowsBuild("24.1.0")).toBe(0);
    expect(windowsBuild("weird")).toBeNull();
  });

  it("packaged: requires node-pty by path from app.asar.unpacked; development: by name", () => {
    const o = opts();
    const r = loadNodePtyWith(o);
    expect(r.ok).toBe(true);
    const dir = join(o.resourcesPath, "app.asar.unpacked", "node_modules", "node-pty");
    expect(r.dir).toBe(dir);
    expect(o.required).toEqual([dir]);
    expect(o.chmodded).toEqual([]); // nothing to chmod on Windows

    const dev = opts({ packaged: false, platform: "darwin", arch: "arm64", osRelease: "24.1.0" });
    expect(loadNodePtyWith(dev)).toMatchObject({ ok: true, dir: "/work/acme/node_modules/node-pty" });
    expect(dev.required).toEqual(["node-pty"]);
    expect(dev.chmodded).toEqual([join("/work/acme/node_modules/node-pty", "prebuilds", "darwin-arm64", "spawn-helper"), join("/work/acme/node_modules/node-pty", "build", "Release", "spawn-helper")]);
    expect(nodePtyDir({ packaged: false, resourcesPath: "", resolveDir: () => null })).toBeNull();
  });

  it("Windows older than 1903 has no PTY (never winpty); a load failure keeps its reason", () => {
    const old = opts({ osRelease: "10.0.17763" });
    expect(loadNodePtyWith(old)).toEqual({ ok: false, reason: WINDOWS_TOO_OLD, dir: null });
    expect(old.required).toEqual([]);
    expect(loadNodePtyWith(opts({ osRelease: "10.0.18309" })).ok).toBe(true);

    const broken = opts({
      requireFn: () => {
        throw new Error("The module was compiled against a different Node.js version");
      },
    });
    const r = loadNodePtyWith(broken);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("different Node.js version");
    expect(loadNodePtyWith(opts({ requireFn: () => ({}) }))).toMatchObject({ ok: false, reason: "node-pty has no spawn()" });
    expect(loadNodePtyWith(opts({ packaged: false, resolveDir: () => null }))).toMatchObject({ ok: false, reason: "node-pty is not installed" });
  });

  it("rg:pty:info: shells only on Windows; the reason when unavailable", () => {
    const ok = loadNodePtyWith(opts());
    expect(ptyInfoOf(ok, "win32", "10.0.22631")).toEqual({ available: true, reason: null, osBuild: 22631, shells: ["powershell", "cmd"] });
    expect(ptyInfoOf(ok, "darwin", "24.1.0")).toEqual({ available: true, reason: null, osBuild: null, shells: [] });
    const old = loadNodePtyWith(opts({ osRelease: "10.0.17134" }));
    expect(ptyInfoOf(old, "win32", "10.0.17134")).toEqual({ available: false, reason: WINDOWS_TOO_OLD, osBuild: 17134, shells: [] });
  });

  it("conpty.dll and OpenConsole.exe are looked for in the win32 prebuild", () => {
    const f = conptyFiles("/x/node-pty", "x64");
    expect(f.conptyDll).toBe(join("/x/node-pty", "prebuilds", "win32-x64", "conpty", "conpty.dll"));
    expect(f.openConsole).toBe(join("/x/node-pty", "prebuilds", "win32-x64", "conpty", "OpenConsole.exe"));
  });
});

describe("--rg-pty-selftest (§57.17)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("parses the flag", () => {
    expect(selftestArg(["electron", "."])).toBeNull();
    expect(selftestArg(["electron", ".", "--rg-pty-selftest"])).toEqual({ out: null });
    expect(selftestArg(["x", "--rg-pty-selftest=C:\\Users\\dev\\AppData\\Local\\Temp\\pty.json"])).toEqual({ out: "C:\\Users\\dev\\AppData\\Local\\Temp\\pty.json" });
    expect(selftestArg(["x", "--rg-pty-selftest-other"])).toBeNull();
  });

  it("a failed load is reported, nothing spawned", async () => {
    const r = await runPtySelftest({ load: { ok: false, reason: WINDOWS_TOO_OLD, dir: null }, platform: "win32", arch: "x64", osRelease: "10.0.17134", env: {}, cwd: tmpdir(), electron: "44.5.1" });
    expect(r).toEqual({ ok: false, nodePtyDir: null, conptyDll: false, openConsole: false, electron: "44.5.1", osBuild: 17134, error: WINDOWS_TOO_OLD });
  });

  it("the real node-pty runs the marker command in a PTY (ConPTY with its DLL on Windows)", async () => {
    const load = nodePty();
    expect(load.ok, load.ok ? "" : load.reason).toBe(true);
    const r = await runPtySelftest({ load, platform: process.platform, arch: process.arch, osRelease: (await import("node:os")).release(), env: process.env, cwd: tmpdir(), electron: null });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    if (process.platform === "win32") {
      expect(r.conptyDll).toBe(true);
      expect(r.openConsole).toBe(true);
      expect(r.osBuild).toBeGreaterThanOrEqual(MIN_CONPTY_BUILD);
    }
    expect(SELFTEST_MARKER).toBe("rg-pty-ok");
  });

  it("the darwin spawn-helper's lost executable bit is set back when node-pty loads", () => {
    if (process.platform === "win32") return;
    const d = mkdtempSync(join(tmpdir(), "rg-pty-helper-"));
    dirs.push(d);
    const helper = join(d, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    mkdirSync(join(helper, ".."), { recursive: true });
    writeFileSync(helper, "#!/bin/sh\n");
    chmodSync(helper, 0o644);
    // nodePty()'s own ensureExecutable, through a development load of a fake package folder.
    const r = loadNodePtyWith({ ...opts({ platform: process.platform, arch: process.arch, packaged: false, resolveDir: () => d }), ensureExecutable });
    expect(r.ok).toBe(true);
    expect(statSync(helper).mode & 0o111).not.toBe(0);
  });
});

