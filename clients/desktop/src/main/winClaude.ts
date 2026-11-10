/**
 * Windows: turn a `claude.cmd` npm shim into something the engine can spawn without a shell.
 * Node ≥ 18.20.2 / 20.12.2 refuses to spawn `.cmd` / `.bat` without `shell: true` (EINVAL), and the
 * SDK spawns `pathToClaudeCodeExecutable` directly. The engine already runs a shim's sibling
 * `node_modules/@anthropic-ai/claude-code/cli.js` under Electron-as-node (session/claude.ts
 * `resolveClaudeExecutable`), but newer npm releases of Claude Code ship a native `claude.exe`
 * instead of `cli.js`, and the engine's `claude --version` probe execFile()s the shim either way.
 * So main resolves the shim first: the `.exe` the shim launches, else a native one next to it, else
 * (cli.js present) the shim itself for the engine's cli.js path, else the native installer's
 * `%USERPROFILE%\.local\bin\claude.exe`. Pure (fs injected), unit-tested in winClaude.test.ts.
 */
import { win32 as path } from "node:path";

export type WinFs = { exists(p: string): boolean; read(p: string): string | null };

/** The program a cmd-shim (npm's cmd-shim, `"%dp0%\…"` / `"%~dp0\…"`) runs, relative to the shim's folder; node.exe excluded. */
export function shimTarget(cmdText: string): string | null {
  const targets = [...cmdText.matchAll(/"%~?dp0%?\\([^"]+)"/gi)].map((m) => m[1]!).filter((t) => !/^node(\.exe)?$/i.test(t));
  return targets.length > 0 ? targets[targets.length - 1]! : null;
}

export function resolveWindowsClaude(claudePath: string, fs: WinFs, env: Record<string, string | undefined>): string {
  if (!/\.(cmd|bat)$/i.test(claudePath)) return claudePath;
  const dir = path.dirname(claudePath);
  const text = fs.read(claudePath);
  const target = text ? shimTarget(text) : null;
  if (target) {
    const abs = path.resolve(dir, target);
    if (/\.exe$/i.test(abs) && fs.exists(abs)) return abs;
  }
  const pkg = path.join(dir, "node_modules", "@anthropic-ai", "claude-code");
  const arch = env.PROCESSOR_ARCHITECTURE?.toUpperCase() === "ARM64" ? "arm64" : "x64";
  const natives = [
    path.join(pkg, "bin", "claude.exe"),
    path.join(pkg, "claude.exe"),
    path.join(pkg, "node_modules", "@anthropic-ai", `claude-code-win32-${arch}`, "claude.exe"),
    path.join(dir, "node_modules", "@anthropic-ai", `claude-code-win32-${arch}`, "claude.exe"),
  ];
  const native = natives.find((p) => fs.exists(p));
  if (native) return native;
  // cli.js: the engine runs it under Electron-as-node itself (keeps working, only `--version` is lost).
  if (fs.exists(path.join(pkg, "cli.js"))) return claudePath;
  const home = env.USERPROFILE;
  const installer = home ? path.join(home, ".local", "bin", "claude.exe") : null;
  if (installer && fs.exists(installer)) return installer;
  return claudePath;
}
