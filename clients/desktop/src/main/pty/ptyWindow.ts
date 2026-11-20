/**
 * MARK: terminal-win — PROTOCOL §57.17: a window's PtyHub with the real world plugged in — node-pty, the window's
 * webContents, the launch builders over this process's environment, `taskkill /T /F` (win32) for a tree that outlives
 * its pseudoconsole. src/main/windows.ts makes one per window; the rules live in ptyHub.ts / terminalLaunch.ts.
 */
import { app, type BrowserWindow } from "electron";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createPlatform, type ReviewEngine } from "@reviewgate/engine";
import { nodePty } from "./nodePty.js";
import { PtyHub } from "./ptyHub.js";
import { buildChatLaunch, buildShellLaunch, whichSync, type LaunchPlatform, type ShimFs } from "./terminalLaunch.js";

const launchFs: ShimFs = {
  exists: (p) => existsSync(p),
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export function createWindowPtyHub(o: {
  win: BrowserWindow;
  engine: ReviewEngine;
  projectPath: () => string | null;
  fullRepaint: () => boolean;
  log: (level: "info" | "warn", msg: string) => void;
}): PtyHub {
  const load = nodePty();
  const platform = (process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux") as LaunchPlatform;
  const which = (name: string) => whichSync(name, { platform, env: process.env, isFile });
  const killer = createPlatform(process.platform);
  const live = () => !o.win.isDestroyed() && !o.win.webContents.isDestroyed();
  return new PtyHub({
    ownerId: o.win.webContents.id,
    engine: o.engine,
    spawn: load.ok ? (file, args, opts) => load.mod.spawn(file, args, opts) : null,
    unavailable: load.ok ? null : load.reason,
    platform: process.platform,
    send: (channel: string, ...args: unknown[]) => {
      if (live()) o.win.webContents.send(channel, ...args);
    },
    setIgnoreMenuShortcuts: (ignore) => {
      if (live()) o.win.webContents.setIgnoreMenuShortcuts(ignore);
    },
    chatLaunch: (spec) => buildChatLaunch({ spec, platform, parentEnv: process.env, appVersion: app.getVersion(), fullRepaint: o.fullRepaint(), fs: launchFs, which }),
    shellLaunch: (shell, cwd) => buildShellLaunch({ shell, cwd, platform, parentEnv: process.env, which, appVersion: app.getVersion() }),
    projectPath: o.projectPath,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    killTree: (pid) => killer.killTree(pid),
    log: o.log,
  });
}
