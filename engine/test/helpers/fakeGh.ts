import { chmodSync, copyFileSync, linkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakeExe = { path: string; restore: () => void };

/**
 * A fake executable `name` in `dir` running `js` (synchronous CommonJS; `args` holds its arguments,
 * `fs` / `path` are required). Call `restore()` when the test is done.
 *
 * POSIX: a script with a `#!<node>` line. Windows: the engine runs tools with execFile (no shell), which
 * cannot start a script or a `.cmd` (EINVAL since CVE-2024-27980), so a real `.exe` stands in — node
 * itself (hard-linked, else copied) as `<name>.exe`, with the fake preloaded through NODE_OPTIONS.
 * `<name>.exe pr create …` makes node take `pr` as the script (argv[1], resolved) and pass the rest
 * through untouched; the preload runs and exits before node looks for that script. Node answers a
 * leading `--version` itself there, so a fake must not rely on it.
 */
export function makeFakeExe(dir: string, name: string, js: string): FakeExe {
  const prelude = 'const fs = require("node:fs");\nconst path = require("node:path");\n';
  if (process.platform !== "win32") {
    const file = join(dir, name);
    writeFileSync(file, `#!${process.execPath}\n${prelude}const args = process.argv.slice(2);\n${js}\n`);
    chmodSync(file, 0o755);
    return { path: file, restore: () => {} };
  }
  const exe = join(dir, `${name}.exe`);
  try {
    linkSync(process.execPath, exe);
  } catch {
    copyFileSync(process.execPath, exe);
  }
  const preload = join(dir, `${name}-fake.cjs`);
  writeFileSync(preload, `${prelude}const args = [path.basename(process.argv[1] || ""), ...process.argv.slice(2)];\n${js}\nprocess.exit(process.exitCode ?? 0);\n`);
  const prev = process.env.NODE_OPTIONS;
  // Forward slashes: NODE_OPTIONS treats a backslash inside quotes as an escape.
  process.env.NODE_OPTIONS = `--require "${preload.replace(/\\/g, "/")}"`;
  return {
    path: exe,
    restore: () => {
      if (prev === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prev;
    },
  };
}

/** A fake `gh` that writes its arguments (one per line) to `log` and prints `stdout`; `--version` answers like gh on POSIX. */
export function makeFakeGh(dir: string, log: string, stdout: string): FakeExe {
  return makeFakeExe(
    dir,
    "gh",
    [
      'if (args[0] === "--version") { fs.writeSync(1, "gh version 2.0.0 (fake)\\n"); process.exit(0); }',
      `fs.writeFileSync(${JSON.stringify(log)}, args.map((a) => a + "\\n").join(""));`,
      `fs.writeFileSync(${JSON.stringify(log + ".cwd")}, process.cwd());`,
      `fs.writeSync(1, ${JSON.stringify(stdout)});`,
    ].join("\n"),
  );
}
