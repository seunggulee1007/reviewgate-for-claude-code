import { DarwinPlatform } from "./darwin.js";
import { LinuxPlatform } from "./linux.js";
import { Win32Platform } from "./win32.js";

/** OS-specific process/shell/config behavior the engine depends on. */
export interface Platform {
  readonly name: PlatformName;
  readonly isWindows: boolean;
  /** Absolute path of `name` (an executable) or `null`. Never spawns through a shell. */
  which(name: string, env?: Record<string, string | undefined>): Promise<string | null>;
  /** PATH as the user's shell sees it (darwin: login shell), or the process PATH. */
  loginPATH(env?: Record<string, string | undefined>): Promise<string>;
  /**
   * Opens an interactive terminal window running `command` (used for `gh auth login`). MARK: wave4d w4d-config — §42.3:
   * `cwd` = the folder it starts in (Windows; macOS / Linux commands `cd` themselves).
   */
  openTerminal(command: string, cwd?: string): Promise<void>;
  /** Kills `pid` and all of its descendants. */
  killTree(pid: number): Promise<void>;
  /** `gh` configuration directory (`GH_CONFIG_DIR` wins when set). */
  ghConfigDir(env?: Record<string, string | undefined>): string;
  tmpDir(): string;
}

export type PlatformName = "darwin" | "win32" | "linux";

export function createPlatform(name: NodeJS.Platform = process.platform): Platform {
  switch (name) {
    case "darwin":
      return new DarwinPlatform();
    case "win32":
      return new Win32Platform();
    default:
      return new LinuxPlatform();
  }
}

export { DarwinPlatform, LinuxPlatform, Win32Platform };
export { parseLoginShellProbe, type LoginShellProbe } from "./darwin.js";
export { locateToolchain, compareVersions, type Toolchain, type ToolchainOverrides } from "./toolchain.js";
