/**
 * MARK: terminal-win — PROTOCOL §57.17: `--rg-pty-selftest[=<out.json>]`. Proves node-pty loads in this Electron (N-API
 * prebuild, app.asar.unpacked in a packaged app) and that ConPTY runs a console program: `%ComSpec% /d /c echo rg-pty-ok`
 * with the bundled conpty.dll (POSIX: `/bin/sh -c 'echo rg-pty-ok'`). main.ts runs it before the single-instance lock and
 * before any window; it touches no settings and writes only the JSON it is asked for. CI runs it under `npx electron`
 * and in the installed app (.github/workflows/ci.yml, windows-installer.yml).
 */
import { existsSync } from "node:fs";
import { conptyFiles, windowsBuild, type NodePtyLoad } from "./nodePty.js";

export const SELFTEST_MARKER = "rg-pty-ok";
const FLAG = "--rg-pty-selftest";

export type SelftestResult = {
  ok: boolean;
  nodePtyDir: string | null;
  conptyDll: boolean;
  openConsole: boolean;
  electron: string | null;
  osBuild: number | null;
  error?: string;
};

/** `--rg-pty-selftest` → `{out: null}` (stdout), `--rg-pty-selftest=<path>` → that file; absent → null. */
export function selftestArg(argv: readonly string[]): { out: string | null } | null {
  for (const a of argv) {
    if (a === FLAG) return { out: null };
    if (a.startsWith(`${FLAG}=`)) return { out: a.slice(FLAG.length + 1) || null };
  }
  return null;
}

export type SelftestOptions = {
  load: NodePtyLoad;
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  env: Record<string, string | undefined>;
  cwd: string;
  electron: string | null;
  timeoutMs?: number;
  exists?: (path: string) => boolean;
};

export async function runPtySelftest(o: SelftestOptions): Promise<SelftestResult> {
  const exists = o.exists ?? existsSync;
  const win = o.platform === "win32";
  const files = o.load.dir && win ? conptyFiles(o.load.dir, o.arch) : null;
  const base: SelftestResult = {
    ok: false,
    nodePtyDir: o.load.dir,
    conptyDll: files ? exists(files.conptyDll) : false,
    openConsole: files ? exists(files.openConsole) : false,
    electron: o.electron,
    osBuild: win ? windowsBuild(o.osRelease) : null,
  };
  if (!o.load.ok) return { ...base, error: o.load.reason };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env)) if (v !== undefined) env[k] = v;
  const file = win ? (env.ComSpec ?? env.COMSPEC ?? `${env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`) : "/bin/sh";
  const args = win ? `/d /c echo ${SELFTEST_MARKER}` : ["-c", `echo ${SELFTEST_MARKER}`];
  const mod = o.load.mod;
  return new Promise<SelftestResult>((resolve) => {
    let output = "";
    let settled = false;
    let pty: ReturnType<typeof mod.spawn> | null = null;
    const finish = (r: SelftestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        pty?.kill();
      } catch {
        /* already gone */
      }
      finish({ ...base, error: `no exit within ${o.timeoutMs ?? 15_000} ms (output: ${JSON.stringify(output.slice(-200))})` });
    }, o.timeoutMs ?? 15_000);
    try {
      pty = mod.spawn(file, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: o.cwd,
        env,
        ...(win ? { useConpty: true, useConptyDll: true, conptyInheritCursor: false } : {}),
      });
    } catch (err) {
      finish({ ...base, error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    pty.onData((d) => {
      output += d;
    });
    pty.onExit(({ exitCode }) => {
      // ConPTY may deliver the last output just after the exit: give it a moment.
      setTimeout(() => {
        const seen = output.includes(SELFTEST_MARKER);
        finish(seen && exitCode === 0 ? { ...base, ok: true } : { ...base, error: `exit ${exitCode}, marker ${seen ? "seen" : "missing"} (output: ${JSON.stringify(output.slice(-200))})` });
      }, 300);
    });
  });
}
