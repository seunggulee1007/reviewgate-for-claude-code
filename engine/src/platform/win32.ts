import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { win32 as path } from "node:path";
import { exec } from "../util/exec.js";
import type { Platform } from "./index.js";
import { terminalInvocation } from "./winShell.js";

/** MARK: wave4d w4d-config — §42.3: an existing folder (a terminal's start folder). */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Windows: `where.exe` + well-known install dirs, `cmd /c start`, `taskkill /T`. */
export class Win32Platform implements Platform {
  readonly name = "win32" as const;
  readonly isWindows = true;
  private readonly cache = new Map<string, string | null>();

  async which(name: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;
    let result: string | null = null;
    try {
      const where = path.join(env.SystemRoot ?? env.WINDIR ?? "C:\\Windows", "System32", "where.exe");
      const out = await exec(exists(where) ? where : "where.exe", [name], { env, timeoutMs: 5000 });
      if (out.status === 0) {
        const lines = out.stdout.toString("utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        // prefer native executables over npm shims
        result = lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.cmd$/i.test(l)) ?? lines[0] ?? null;
      }
    } catch {
      // where.exe missing — fall through to known dirs
    }
    if (!result) {
      for (const c of this.knownDirs(name, env)) {
        if (exists(c)) {
          result = c;
          break;
        }
      }
    }
    this.cache.set(name, result);
    return result;
  }

  private knownDirs(name: string, env: Record<string, string | undefined>): string[] {
    const home = env.USERPROFILE ?? homedir();
    const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    switch (name) {
      case "claude":
        return [path.join(home, ".local", "bin", "claude.exe"), path.join(appData, "npm", "claude.cmd")];
      case "gh":
        return [path.join(programFiles, "GitHub CLI", "gh.exe")];
      case "git":
        return [path.join(programFiles, "Git", "cmd", "git.exe"), path.join(localAppData, "Programs", "Git", "cmd", "git.exe")];
      case "node":
        return [path.join(programFiles, "nodejs", "node.exe")];
      default:
        return [];
    }
  }

  async loginPATH(env: Record<string, string | undefined> = process.env): Promise<string> {
    return env.PATH ?? env.Path ?? "";
  }

  /**
   * A new console window (`detached` gives cmd.exe its own) running `command`, which must be a
   * plain `gh …` / `claude …` line (winShell.ts `terminalInvocation`; anything else throws).
   */
  async openTerminal(command: string, cwd?: string): Promise<void> {
    const inv = terminalInvocation(command, process.env.ComSpec ?? "cmd.exe");
    // MARK: wave4d w4d-config — §42.3: `claude /mcp` started in the project lists its project / local servers.
    const dir = cwd && isDirectory(cwd) ? cwd : undefined;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(inv.file, inv.args, {
        ...(dir ? { cwd: dir } : {}),
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        windowsVerbatimArguments: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  async killTree(pid: number): Promise<void> {
    await exec("taskkill", ["/pid", String(pid), "/T", "/F"], { timeoutMs: 10000 }).catch(() => undefined);
  }

  ghConfigDir(env: Record<string, string | undefined> = process.env): string {
    if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
    const appData = env.APPDATA ?? path.join(env.USERPROFILE ?? homedir(), "AppData", "Roaming");
    return path.join(appData, "GitHub CLI");
  }

  tmpDir(): string {
    return tmpdir();
  }
}
