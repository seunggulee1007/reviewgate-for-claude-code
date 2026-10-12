import { exec } from "../util/exec.js";
import { isExecutable } from "./darwin.js";
import type { Platform } from "./index.js";
import { cmdInvocation, isBatchFile, realShimFs, resolveCmdShim, type ShimFs } from "./winShell.js";

export type Toolchain = {
  claude: string | null;
  gh: string | null;
  git: string | null;
  claudeVersion: string | null;
  ghVersion: string | null;
  gitVersion: string | null;
  /** PATH handed to every child process (login-shell PATH on darwin). */
  path: string;
};

export type ToolchainOverrides = { claude?: string | null; gh?: string | null; git?: string | null };

const VERSION_TIMEOUT_MS = 10000;

/** Compares `vA.B.C` tags: negative when `a < b`, positive when `a > b`, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Resolves `claude`, `gh` and `git` (overrides first, then `platform.which`) and reads their
 * `--version`. A tool that cannot be found or run yields `null` for both fields.
 */
export async function locateToolchain(
  platform: Platform,
  env: Record<string, string | undefined> = process.env,
  overrides: ToolchainOverrides = {},
): Promise<Toolchain> {
  const path = await platform.loginPATH(env);
  const childEnv = { ...env, PATH: path };
  const resolve = async (name: keyof ToolchainOverrides): Promise<string | null> => {
    const o = overrides[name];
    if (o && (platform.isWindows || isExecutable(o))) return o;
    return platform.which(name, childEnv);
  };
  const [claude, gh, git] = await Promise.all([resolve("claude"), resolve("gh"), resolve("git")]);
  const [claudeVersion, ghVersion, gitVersion] = await Promise.all([
    versionOf(claude, childEnv, platform.isWindows),
    versionOf(gh, childEnv, platform.isWindows),
    versionOf(git, childEnv, platform.isWindows),
  ]);
  return { claude, gh, git, claudeVersion, ghVersion, gitVersion, path };
}

/** How `versionOf` runs `exe --version`: directly, or (Windows batch shim) without cmd.exe when possible, else through it. */
export function versionCommand(
  exe: string,
  isWindows: boolean,
  fs: ShimFs = realShimFs,
  nodePath: string = process.execPath,
  comspec: string = process.env.ComSpec ?? "cmd.exe",
): { file: string; args: string[]; env?: Record<string, string>; windowsVerbatimArguments?: true } {
  if (!isWindows || !isBatchFile(exe)) return { file: exe, args: ["--version"] };
  // execFile() of a .cmd / .bat fails with EINVAL (Node ≥ 18.20.2): look through the shim first.
  const shim = resolveCmdShim(exe, fs);
  if (shim?.kind === "exe") return { file: shim.path, args: ["--version"] };
  if (shim?.kind === "node") return { file: nodePath, args: [shim.script, "--version"], env: { ELECTRON_RUN_AS_NODE: "1" } };
  return cmdInvocation(exe, ["--version"], { comspec });
}

export async function versionOf(
  exe: string | null,
  env: Record<string, string | undefined>,
  isWindows: boolean = process.platform === "win32",
): Promise<string | null> {
  if (!exe) return null;
  try {
    const cmd = versionCommand(exe, isWindows);
    const out = await exec(cmd.file, cmd.args, {
      env: cmd.env ? { ...env, ...cmd.env } : env,
      timeoutMs: VERSION_TIMEOUT_MS,
      ...(cmd.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    if (out.status !== 0) return null;
    // `gh --version` prints two lines; the first carries the version.
    return out.stdout.toString("utf8").trim().split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}
