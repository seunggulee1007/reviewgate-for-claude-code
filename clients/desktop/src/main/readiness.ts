/**
 * MARK: polish p-lifecycle — P5-sheets-44: what ReviewGate needs before a project opens, for the empty window's checklist
 * (lane p-window draws it): the Claude Code CLI, the GitHub CLI's login (pull requests, updates) and git's identity
 * (commits). A first user used to meet these only as errors after opening a project. Main finds the tools the way an
 * engine does (`locateToolchain`, the settings' overrides) and asks gh and git; `rg:readiness` answers the page, at most once
 * a minute (a check after the user fixed something comes back fresh then).
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { ipcMain } from "electron";
import { createPlatform, locateToolchain, type Toolchain } from "@reviewgate/engine";
import type { Readiness, ReadinessCheck } from "../shared/ipc.js";
import { loadSettings } from "./settings.js";

export type ToolRun = (exe: string, args: string[], env: Record<string, string | undefined>) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Runs `exe` without a shell, quietly, at most 8 s (a tool that hangs reads as failed). */
export const runTool: ToolRun = (exe, args, env) =>
  new Promise((resolve) => {
    execFile(exe, args, { env, cwd: homedir(), timeout: 8000, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

/** "2.1.31 (Claude Code)" → "2.1.31". */
export function versionNumber(text: string | null): string | undefined {
  return text?.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
}

/**
 * The checklist's facts from a located toolchain. `detail`: the version, the account, the identity — or, when a line is not
 * ok, "missing" (the tool is not installed) or the git keys that are not set ("user.name", "user.email").
 */
export async function readinessOf(tc: Pick<Toolchain, "claude" | "gh" | "git" | "claudeVersion" | "path">, run: ToolRun, ghHost = ""): Promise<Readiness> {
  const env = { ...process.env, PATH: tc.path, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1" };
  const claude: ReadinessCheck = tc.claude ? { ok: true, ...(versionNumber(tc.claudeVersion) ? { detail: versionNumber(tc.claudeVersion)! } : {}) } : { ok: false, detail: "missing" };
  const [ghLogin, gitIdentity] = await Promise.all([ghLoginOf(tc.gh, run, env, ghHost.trim() || "github.com"), gitIdentityOf(tc.git, run, env)]);
  return { claude, ghLogin, gitIdentity };
}

async function ghLoginOf(gh: string | null, run: ToolRun, env: Record<string, string | undefined>, host: string): Promise<ReadinessCheck> {
  if (!gh) return { ok: false, detail: "missing" };
  const r = await run(gh, ["auth", "status", "--hostname", host], env);
  if (r.code !== 0) return { ok: false };
  // "✓ Logged in to github.com account dev (keyring)" (older gh: "Logged in to github.com as dev").
  const account = `${r.stdout}\n${r.stderr}`.match(/Logged in to \S+ (?:account|as) ([^\s()]+)/)?.[1];
  return { ok: true, ...(account ? { detail: account } : {}) };
}

async function gitIdentityOf(git: string | null, run: ToolRun, env: Record<string, string | undefined>): Promise<ReadinessCheck> {
  if (!git) return { ok: false, detail: "missing" };
  const [name, email] = await Promise.all([run(git, ["config", "--get", "user.name"], env), run(git, ["config", "--get", "user.email"], env)]);
  const n = name.code === 0 ? name.stdout.trim() : "";
  const e = email.code === 0 ? email.stdout.trim() : "";
  if (n && e) return { ok: true, detail: `${n} <${e}>` };
  return { ok: false, detail: [n ? null : "user.name", e ? null : "user.email"].filter(Boolean).join(", ") };
}

const FRESH_MS = 60_000;
let cached: { at: number; value: Promise<Readiness> } | null = null;

/** The page's `readiness()`: found again when the last answer is more than a minute old. */
export function installReadiness(run: ToolRun = runTool, now: () => number = Date.now): void {
  ipcMain.handle("rg:readiness", () => {
    if (cached && now() - cached.at < FRESH_MS) return cached.value;
    const s = loadSettings();
    const value = locateToolchain(createPlatform(process.platform), process.env as Record<string, string>, { claude: s.claudePath, gh: s.ghPath, git: s.gitPath }).then((tc) => readinessOf(tc, run, s.ghHost));
    cached = { at: now(), value };
    // A failure is not kept: the next ask tries again.
    value.catch(() => {
      if (cached?.value === value) cached = null;
    });
    return value;
  });
}
