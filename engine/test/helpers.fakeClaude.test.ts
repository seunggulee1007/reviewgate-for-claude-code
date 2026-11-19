import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCmdShim } from "../src/platform/winShell.js";
import { versionCommand, versionOf } from "../src/platform/toolchain.js";
import { parseCliVersion } from "../src/session/cliVersion.js";
import { exec } from "../src/util/exec.js";
import { makeFakeClaude } from "./helpers/fakeClaude.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

/** The fake `claude` of the terminal-chat tests: its `--version` reaches the engine on every platform. */
const dirs: string[] = [];
const temp = (): string => {
  const d = makeTempDir("rg-fake-claude");
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("makeFakeClaude", () => {
  it("Windows shape: the engine looks through claude.cmd to the script, which answers --version", async () => {
    const dir = temp();
    const claude = makeFakeClaude(dir, "2.1.300", true);
    expect(claude).toBe(join(dir, "claude.cmd"));
    // The shim as the engine reads it on Windows (win32 paths there, whatever runs this test).
    const shim = "C:\\bin\\claude.cmd";
    const script = "C:\\bin\\cli.cjs";
    const fs = { read: (p: string) => (p === shim ? readFileSync(claude, "utf8") : null), exists: (p: string) => p === script };
    expect(resolveCmdShim(shim, fs)).toEqual({ kind: "node", script });
    expect(versionCommand(shim, true, fs, "C:\\node\\node.exe")).toEqual({ file: "C:\\node\\node.exe", args: [script, "--version"], env: { ELECTRON_RUN_AS_NODE: "1" } });
    // What that command runs: the script under node.
    const out = await exec(process.execPath, [join(dir, "cli.cjs"), "--version"], { timeoutMs: 30_000 });
    expect(out.status).toBe(0);
    expect(parseCliVersion(out.stdout.toString("utf8"))).toBe("2.1.300");
    expect((await exec(process.execPath, [join(dir, "cli.cjs"), "-p", "hi"], { timeoutMs: 30_000 })).status).toBe(1);
  });

  it.runIf(process.platform === "win32")("on Windows: versionOf reads it through the real shim", async () => {
    const claude = makeFakeClaude(temp(), "2.1.302");
    expect(await versionOf(claude, process.env, true)).toBe("2.1.302 (Claude Code)");
  });

  it.skipIf(process.platform === "win32")("POSIX shape: a script answering --version", async () => {
    const claude = makeFakeClaude(temp(), "2.1.301", false);
    expect(await versionOf(claude, process.env, false)).toBe("2.1.301 (Claude Code)");
  });
});
