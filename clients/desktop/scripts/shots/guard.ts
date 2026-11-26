/**
 * Imported first by the harness's main (scripts/shots/main.ts): this process starts no child process at all — no engine,
 * no `claude`, no git, no shell. Every `child_process` entry point throws, so a fixture gap can never fall through to a
 * real run. (Chromium's own helper processes are started by Electron, not through Node.)
 */
import cp from "node:child_process";

const refuse = (name: string) => () => {
  throw new Error(`shots: ${name} refused — the screenshot harness starts no process`);
};
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
  Object.defineProperty(cp, name, { value: refuse(name), configurable: false, writable: false });
}
