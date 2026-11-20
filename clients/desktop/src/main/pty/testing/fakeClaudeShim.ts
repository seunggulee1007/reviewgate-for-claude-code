/**
 * Installs the terminal fake (fakeClaudeTerminal.cjs) as `claude` in `dir`, shaped like a real install (modelled on
 * engine/test/helpers/fakeClaude.ts). Windows: npm's `claude.cmd` naming the script next to it — the launch looks
 * through the shim and runs the script under a real node.exe (never the `.cmd` through ConPTY). POSIX: a `/bin/sh`
 * script that `exec`s node on it. Returns the path the engine is given as `claudePath`.
 */
import { chmodSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_SCRIPT = fileURLToPath(new URL("./fakeClaudeTerminal.cjs", import.meta.url));

export function writeFakeClaude(dir: string, node = process.execPath, windows = process.platform === "win32"): string {
  const script = join(dir, "fake-claude.cjs");
  copyFileSync(FAKE_SCRIPT, script);
  if (windows) {
    // `.js` like npm's cli.js: the Agent SDK runs only `.js` / `.mjs` under node and spawns anything else as a binary
    // (`.cjs` failed with spawn EFTYPE). The package.json keeps it CommonJS whatever sits above the temp folder.
    copyFileSync(FAKE_SCRIPT, join(dir, "fake-claude.js"));
    writeFileSync(join(dir, "package.json"), `{"type":"commonjs"}\n`);
    const shim = join(dir, "claude.cmd");
    writeFileSync(shim, `@ECHO off\r\nnode "%~dp0\\fake-claude.js" %*\r\n`);
    return shim;
  }
  const sh = join(dir, "claude");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(sh, `#!/bin/sh\nexec ${q(node)} ${q(script)} "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}
