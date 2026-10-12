import { accessSync, constants, readdirSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename } from "node:path";
import { exec } from "../util/exec.js";
import type { Platform } from "./index.js";
import { killProcessTree } from "./processTree.js"; // MARK: wave4 w4-install

export type LoginShellProbe = {
  /** Absolute paths keyed by executable name, from `command -v <name>` lines. */
  found: Record<string, string>;
  /** Last non-empty line — the login shell's `$PATH`. */
  path: string | null;
};

/**
 * Parses the output of `zsh -lic 'command -v a; command -v b; ...; printf "%s\n" "$PATH"'`.
 * Interactive shells may print noise (MOTD, plugin banners), so every line is inspected:
 * an absolute path ending in one of `names` wins (last occurrence), `name: aliased to /path ...`
 * is unwrapped, and the final non-empty line is taken as PATH.
 */
export function parseLoginShellProbe(text: string, names: readonly string[]): LoginShellProbe {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { found: {}, path: null };
  const path = lines[lines.length - 1]!;
  const found: Record<string, string> = {};
  for (const line of lines.slice(0, -1)) {
    const candidate = extractPath(line);
    if (!candidate || !candidate.startsWith("/")) continue;
    const name = basename(candidate);
    if (names.includes(name)) found[name] = candidate;
  }
  return { found, path };
}

function extractPath(line: string): string | null {
  const marker = "aliased to ";
  const i = line.indexOf(marker);
  if (i >= 0) return line.slice(i + marker.length).split(" ")[0] ?? null;
  return line;
}

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** nvm-installed node binaries (newest version first), then Homebrew and /usr/local. */
export function nodeFallbacks(home: string): string[] {
  const list: string[] = [];
  const nvmDir = `${home}/.nvm/versions/node`;
  try {
    const versions = readdirSync(nvmDir).filter((v) => v.startsWith("v")).sort((a, b) => -compareVersionTags(a, b));
    list.push(...versions.map((v) => `${nvmDir}/${v}/bin/node`));
  } catch {
    // no nvm
  }
  list.push("/opt/homebrew/bin/node", "/usr/local/bin/node");
  return list;
}

function compareVersionTags(a: string, b: string): number {
  const pa = a.slice(1).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.slice(1).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const PROBE_NAMES = ["node", "claude", "gh", "git"] as const;
const PROBE_TIMEOUT_MS = 5000;

export class DarwinPlatform implements Platform {
  readonly name = "darwin" as const;
  readonly isWindows = false;
  private probe: Promise<LoginShellProbe> | null = null;

  /** One `zsh -lic` probe per process; the result is cached (login shells are slow). */
  private loginShell(): Promise<LoginShellProbe> {
    if (!this.probe) {
      const script = PROBE_NAMES.map((n) => `command -v ${n}`).join("; ") + '; printf "%s\\n" "$PATH"';
      this.probe = exec("/bin/zsh", ["-lic", script], {
        env: {
          HOME: homedir(),
          USER: safeUserName(),
          TERM: "dumb",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        },
        timeoutMs: PROBE_TIMEOUT_MS,
      })
        .then((out) => parseLoginShellProbe(out.stdout.toString("utf8"), PROBE_NAMES))
        .catch(() => ({ found: {}, path: null }));
    }
    return this.probe;
  }

  async which(name: string): Promise<string | null> {
    const shell = await this.loginShell();
    const fromShell = shell.found[name];
    if (fromShell && isExecutable(fromShell)) return fromShell;
    for (const c of this.fallbacks(name)) if (isExecutable(c)) return c;
    return null;
  }

  private fallbacks(name: string): string[] {
    const home = homedir();
    switch (name) {
      case "node":
        return nodeFallbacks(home);
      case "claude":
        return [`${home}/.local/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
      case "git":
        return ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"];
      default:
        return [`${home}/.local/bin/${name}`, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`];
    }
  }

  async loginPATH(env?: Record<string, string | undefined>): Promise<string> {
    const shell = await this.loginShell();
    if (shell.path) return shell.path;
    return env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  }

  async openTerminal(command: string): Promise<void> {
    const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `tell application "Terminal"\nactivate\ndo script "${escaped}"\nend tell`;
    const out = await exec("/usr/bin/osascript", ["-e", script], { timeoutMs: 10000 });
    if (out.status !== 0) throw new Error(`osascript failed (exit ${out.status}): ${out.stderr.trim()}`);
  }

  async killTree(pid: number): Promise<void> {
    // MARK: wave4 w4-install (robustness-12): `claude` is not a group leader (it shares the sidecar's group), so the
    // whole tree below it is found and killed — the group too when `pid` leads one (a workbench setup's shell).
    await killProcessTree(pid);
  }

  ghConfigDir(env: Record<string, string | undefined> = process.env): string {
    return env.GH_CONFIG_DIR || `${homedir()}/.config/gh`;
  }

  tmpDir(): string {
    return tmpdir();
  }
}

function safeUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "";
  }
}
