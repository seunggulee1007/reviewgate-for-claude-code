import { accessSync, constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, posix } from "node:path";
import { exec } from "../util/exec.js";
import type { Platform } from "./index.js";
import { killProcessTree } from "./processTree.js"; // MARK: wave4 w4-install

/** Minimal POSIX platform: PATH walk, `x-terminal-emulator`, process-group SIGKILL. */
export class LinuxPlatform implements Platform {
  readonly name = "linux" as const;
  readonly isWindows = false;

  async which(name: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
    const dirs = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter);
    dirs.push(join(homedir(), ".local/bin"));
    for (const d of dirs) {
      if (!d) continue;
      const p = join(d, name);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        // keep looking
      }
    }
    return null;
  }

  async loginPATH(env: Record<string, string | undefined> = process.env): Promise<string> {
    return env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  }

  async openTerminal(command: string): Promise<void> {
    const term = (await this.which("x-terminal-emulator")) ?? (await this.which("xterm"));
    if (!term) throw new Error("no terminal emulator found");
    await exec(term, ["-e", "sh", "-c", `${command}; exec sh`], { timeoutMs: 5000 });
  }

  async killTree(pid: number): Promise<void> {
    await killProcessTree(pid); // MARK: wave4 w4-install (robustness-12): the whole tree, as on macOS
  }

  ghConfigDir(env: Record<string, string | undefined> = process.env): string {
    if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
    return env.XDG_CONFIG_HOME ? posix.join(env.XDG_CONFIG_HOME, "gh") : posix.join(homedir(), ".config/gh");
  }

  tmpDir(): string {
    return tmpdir();
  }
}
