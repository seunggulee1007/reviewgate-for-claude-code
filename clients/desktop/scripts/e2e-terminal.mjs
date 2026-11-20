// `npm run e2e:terminal -w clients/desktop` (after the build): the hidden Electron terminal-chat run of PROTOCOL §57.17
// (src/main/e2eTerminal.ts). Everything lives in one temporary folder — the repository, userData, the REVIEWGATE data
// folder, CLAUDE_CONFIG_DIR and the fake claude (npm's shape: claude.cmd + node_modules/@anthropic-ai/claude-code/cli.js,
// so ReviewGate's own claude.cmd resolution keeps it and never finds a real claude.exe) — and is removed afterwards.
// Windows CI only: it starts Electron, so it refuses elsewhere unless `--any-os` is given.
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const appDir = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "win32" && !process.argv.includes("--any-os")) {
  console.error("e2e:terminal starts Electron (hidden) and is meant for Windows CI; pass --any-os to run it elsewhere.");
  process.exit(2);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "rg-e2e-term-")));
const dir = (name) => {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const repo = dir("repo");
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
git("init", "-q", "-b", "main");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
git("config", "core.autocrlf", "false");
writeFileSync(join(repo, "README.md"), "hello\n");
git("add", "-A");
git("commit", "-qm", "init");

const bin = dir("bin");
const pkg = join(bin, "node_modules", "@anthropic-ai", "claude-code");
mkdirSync(pkg, { recursive: true });
copyFileSync(join(appDir, "src", "main", "pty", "testing", "fakeClaudeTerminal.cjs"), join(pkg, "cli.js"));
let claude;
if (process.platform === "win32") {
  claude = join(bin, "claude.cmd");
  writeFileSync(claude, `@ECHO off\r\nnode "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`);
} else {
  claude = join(bin, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${join(pkg, "cli.js").replace(/'/g, `'\\''`)}' "$@"\n`);
  chmodSync(claude, 0o755);
}

const userData = dir("user-data");
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ claudePath: claude, terminalChatPreview: true, newChatKind: "chat", reopenLastProjects: false, notifications: false, autoCheckUpdates: false, confirmQuit: false }),
);
const out = join(root, "report.json");
// REVIEWGATE_E2E_FAKE_CLAUDE: the harness refuses to start unless the claude it was given is this fake.
const env = { ...process.env, REVIEWGATE_PROJECT: repo, REVIEWGATE_DATA_DIR: dir("data"), CLAUDE_CONFIG_DIR: dir("claude-config"), REVIEWGATE_E2E_FAKE_CLAUDE: claude };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [appDir, "--e2e-terminal", `--rg-user-data=${userData}`, `--rg-e2e-out=${out}`], { env, stdio: ["ignore", "inherit", "inherit"] });
child.on("exit", (code) => {
  let report = null;
  try {
    report = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    report = null;
  }
  console.log(report ? JSON.stringify(report, null, 2) : "e2e:terminal: no report");
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* a file still held by an exiting process: the runner is thrown away */
  }
  process.exit(report && report.ok === true && code === 0 ? 0 : code || 1);
});
