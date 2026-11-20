/**
 * MARK: terminal-win — PROTOCOL §57.17: loading node-pty in Electron main, once, lazily.
 *
 * Packaged, node-pty is required by path from `resources/app.asar.unpacked/node_modules/node-pty`, so its `__dirname`,
 * the conout worker thread, the `.node` binaries, the console-list agent and `conpty.dll` / `OpenConsole.exe` are all real
 * files (a worker or a DLL inside app.asar is the risky part). In development a plain `require("node-pty")`.
 * On Windows ConPTY needs build 18309 (Windows 10 1903) or later: below it there is no PTY at all — winpty is never used
 * (it mangles UTF-8 and VT sequences). No Electron import here: every input is injected, so the rules are unit-tested.
 */
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { release } from "node:os";
import { join } from "node:path";
import type * as NodePty from "node-pty";
import type { PtyInfo, ShellKind } from "../../shared/ipc.js";

export type NodePtyModule = typeof NodePty;
export type NodePtyLoad = { ok: true; mod: NodePtyModule; dir: string } | { ok: false; reason: string; dir: string | null };

/** The first Windows build with a working ConPTY (Windows 10 1903). */
export const MIN_CONPTY_BUILD = 18309;
export const WINDOWS_TOO_OLD = "Terminal chat needs Windows 10 1903 or later";

export type LoadOptions = {
  platform: NodeJS.Platform;
  arch: string;
  /** `os.release()` — "10.0.19045" on Windows. */
  osRelease: string;
  packaged: boolean;
  resourcesPath: string;
  /** `require` (createRequire'd); throws when the module cannot load. */
  requireFn: (id: string) => unknown;
  /** Resolves a package's folder in development (`require.resolve("node-pty/package.json")`'s folder). */
  resolveDir: (id: string) => string | null;
  /** chmod +x a file that lost its executable bit (the darwin prebuild's spawn-helper); never throws. */
  ensureExecutable: (path: string) => void;
};

/** The build number of a Windows `os.release()` ("10.0.19045" → 19045); null when it has none. */
export function windowsBuild(osRelease: string): number | null {
  const m = /^\d+\.\d+\.(\d+)/.exec(osRelease.trim());
  return m ? Number(m[1]) : null;
}

/** Where node-pty lives: the unpacked copy in a packaged app, else wherever node resolution finds it. */
export function nodePtyDir(o: Pick<LoadOptions, "packaged" | "resourcesPath" | "resolveDir">): string | null {
  if (o.packaged) return join(o.resourcesPath, "app.asar.unpacked", "node_modules", "node-pty");
  return o.resolveDir("node-pty");
}

/** ConPTY's own files inside node-pty's win32 prebuild (`useConptyDll`). */
export function conptyFiles(dir: string, arch: string): { conptyDll: string; openConsole: string } {
  const base = join(dir, "prebuilds", `win32-${arch}`, "conpty");
  return { conptyDll: join(base, "conpty.dll"), openConsole: join(base, "OpenConsole.exe") };
}

export function loadNodePtyWith(o: LoadOptions): NodePtyLoad {
  if (o.platform === "win32") {
    const build = windowsBuild(o.osRelease);
    if (build === null || build < MIN_CONPTY_BUILD) return { ok: false, reason: WINDOWS_TOO_OLD, dir: null };
  }
  const dir = nodePtyDir(o);
  if (!dir) return { ok: false, reason: "node-pty is not installed", dir: null };
  if (o.platform !== "win32") {
    // node-pty 1.1.0's darwin prebuild ships spawn-helper without its executable bit (`posix_spawnp failed`).
    o.ensureExecutable(join(dir, "prebuilds", `${o.platform}-${o.arch}`, "spawn-helper"));
    o.ensureExecutable(join(dir, "build", "Release", "spawn-helper"));
  }
  try {
    const mod = o.requireFn(o.packaged ? dir : "node-pty") as NodePtyModule;
    if (!mod || typeof mod.spawn !== "function") return { ok: false, reason: "node-pty has no spawn()", dir };
    return { ok: true, mod, dir };
  } catch (err) {
    return { ok: false, reason: `node-pty did not load: ${err instanceof Error ? err.message : String(err)}`, dir };
  }
}

const nodeRequire = createRequire(import.meta.url);

/** chmod +x a file that lost its executable bit; a missing file or a read-only install is left alone. */
export function ensureExecutable(path: string): void {
  try {
    if (!existsSync(path)) return;
    const mode = statSync(path).mode;
    if ((mode & 0o111) === 0) chmodSync(path, mode | 0o755);
  } catch {
    /* read-only install: the spawn says so */
  }
}

let config: Pick<LoadOptions, "packaged" | "resourcesPath"> = { packaged: false, resourcesPath: "" };
let loaded: NodePtyLoad | null = null;

/** main.ts: whether the app is packaged and where its resources are (before the first load). */
export function configureNodePty(c: { packaged: boolean; resourcesPath: string }): void {
  config = { ...c };
}

/** node-pty for this process, loaded on first use; the result (and a failure's reason) is kept. */
export function nodePty(): NodePtyLoad {
  loaded ??= loadNodePtyWith({
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    ...config,
    requireFn: (id) => nodeRequire(id),
    resolveDir: (id) => {
      try {
        return join(nodeRequire.resolve(`${id}/package.json`), "..");
      } catch {
        return null;
      }
    },
    ensureExecutable,
  });
  return loaded;
}

/** Hello `capabilities.terminalChat` and the shell panel: static per process. */
export function ptyAvailable(): boolean {
  return nodePty().ok;
}

/** `rg:pty:info`. The shell panel's shells are Windows' (PowerShell / Command Prompt); none elsewhere. */
export function ptyInfoOf(load: NodePtyLoad, platform: NodeJS.Platform, osRelease: string): PtyInfo {
  const shells: ShellKind[] = load.ok && platform === "win32" ? ["powershell", "cmd"] : [];
  return { available: load.ok, reason: load.ok ? null : load.reason, osBuild: platform === "win32" ? windowsBuild(osRelease) : null, shells };
}

export function ptyInfo(): PtyInfo {
  return ptyInfoOf(nodePty(), process.platform, release());
}
