import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fake `claude` in `dir` that only answers `--version` (`<version> (Claude Code)`) and exits 1 for anything else.
 *
 * POSIX: a `#!/bin/sh` script. Windows: npm's shape — `claude.cmd` naming a script next to it (`cli.cjs`: CommonJS
 * whatever package.json sits above the temp folder). execFile cannot start a script or a `.cmd` there, so the engine
 * (`platform.isWindows`) looks through the shim (`resolveCmdShim`) and runs the script under node, as for an
 * npm-installed Claude Code. A node `.exe` stand-in like fakeGh's cannot be used: node answers a leading `--version`
 * itself.
 */
export function makeFakeClaude(dir: string, version = "2.1.325", windows = process.platform === "win32"): string {
  if (!windows) {
    const path = join(dir, "claude");
    writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\nexit 1\n`);
    chmodSync(path, 0o755);
    return path;
  }
  writeFileSync(
    join(dir, "cli.cjs"),
    `if (process.argv[2] === "--version") require("node:fs").writeSync(1, ${JSON.stringify(`${version} (Claude Code)\n`)});\nelse process.exitCode = 1;\n`,
  );
  const path = join(dir, "claude.cmd");
  writeFileSync(path, `@ECHO off\r\nnode "%~dp0\\cli.cjs" %*\r\n`);
  return path;
}
