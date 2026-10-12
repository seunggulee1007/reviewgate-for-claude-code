import { describe, expect, it } from "vitest";
import {
  cmdInvocation,
  escapeCmdArgument,
  escapeCmdCommand,
  resolveCmdShim,
  shimTarget,
  splitSimpleCommand,
  terminalInvocation,
  type ShimFs,
} from "../src/platform/winShell.js";
import { versionCommand } from "../src/platform/toolchain.js";
import { claudeLaunchProblem, resolveClaudeExecutable } from "../src/session/claude.js";

const fakeFs = (files: Record<string, string>): ShimFs => ({
  exists: (p) => p in files,
  read: (p) => files[p] ?? null,
});

const NPM = "C:\\Users\\x\\AppData\\Roaming\\npm";
const SHIM_JS = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`;
const SHIM_EXE = `@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n`;

describe("cmd.exe quoting (cross-spawn rules)", () => {
  it("escapes metacharacters in the program path", () => {
    expect(escapeCmdCommand("C:\\Program Files\\x\\a&b.cmd")).toBe("C:\\Program^ Files\\x\\a^&b.cmd");
    expect(escapeCmdCommand("plain.cmd")).toBe("plain.cmd");
  });

  it("quotes arguments MSVCRT-style, then ^-escapes once or twice", () => {
    expect(escapeCmdArgument("--version", false)).toBe('^"--version^"');
    expect(escapeCmdArgument("--version", true)).toBe('^^^"--version^^^"');
    expect(escapeCmdArgument("a b", false)).toBe('^"a^ b^"');
    expect(escapeCmdArgument("a&calc", false)).toBe('^"a^&calc^"');
    expect(escapeCmdArgument("%PATH%", false)).toBe('^"^%PATH^%^"');
    expect(escapeCmdArgument("100%!", true)).toBe('^^^"100^^^%^^^!^^^"');
    expect(escapeCmdArgument("", false)).toBe('^"^"');
  });

  it("doubles backslashes before a quote and at the end; escapes embedded quotes", () => {
    expect(escapeCmdArgument('say "hi"', false)).toBe('^"say^ \\^"hi\\^"^"');
    expect(escapeCmdArgument("C:\\dir\\", false)).toBe('^"C:\\dir\\\\^"');
    expect(escapeCmdArgument('a\\"b', false)).toBe('^"a\\\\\\^"b^"');
  });

  it("builds a cmd.exe /d /s /c invocation with verbatim arguments", () => {
    const inv = cmdInvocation("C:\\Program Files\\nodejs\\claude.cmd", ["--version"], { comspec: "C:\\Windows\\System32\\cmd.exe" });
    expect(inv).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\Program^ Files\\nodejs\\claude.cmd ^^^"--version^^^""'],
      windowsVerbatimArguments: true,
    });
    expect(cmdInvocation("x.bat", ["a"], { doubleEscape: false }).args[3]).toBe('"x.bat ^"a^""');
  });
});

describe("cmd-shim resolution", () => {
  it("reads the target of npm cmd-shims (%dp0% and %~dp0 forms), skipping node", () => {
    expect(shimTarget(SHIM_JS)).toBe("node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(shimTarget(SHIM_EXE)).toBe("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
    expect(shimTarget("@echo off\r\nnode foo.js %*\r\n")).toBeNull();
  });

  it("prefers the exe / js the shim launches, falls back to claude-code/cli.js, else null", () => {
    const cmd = `${NPM}\\claude.cmd`;
    const exe = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    const cli = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    expect(resolveCmdShim(cmd, fakeFs({ [cmd]: SHIM_EXE, [exe]: "" }))).toEqual({ kind: "exe", path: exe });
    expect(resolveCmdShim(cmd, fakeFs({ [cmd]: SHIM_JS, [cli]: "" }))).toEqual({ kind: "node", script: cli });
    // the target is missing, but cli.js sits where npm puts it
    expect(resolveCmdShim(cmd, fakeFs({ [cmd]: SHIM_EXE, [cli]: "" }))).toEqual({ kind: "node", script: cli });
    expect(resolveCmdShim(cmd, fakeFs({ [cmd]: SHIM_EXE }))).toBeNull();
    expect(resolveCmdShim("C:\\x\\claude.exe", fakeFs({}))).toBeNull();
  });

  it("versionCommand never execFile()s a batch file on Windows", () => {
    const cmd = `${NPM}\\claude.cmd`;
    const exe = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    const cli = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    expect(versionCommand("/usr/bin/git", false)).toEqual({ file: "/usr/bin/git", args: ["--version"] });
    expect(versionCommand("C:\\gh\\gh.exe", true)).toEqual({ file: "C:\\gh\\gh.exe", args: ["--version"] });
    expect(versionCommand(cmd, true, fakeFs({ [cmd]: SHIM_EXE, [exe]: "" }))).toEqual({ file: exe, args: ["--version"] });
    expect(versionCommand(cmd, true, fakeFs({ [cmd]: SHIM_JS, [cli]: "" }), "C:\\app\\ReviewGate.exe")).toEqual({
      file: "C:\\app\\ReviewGate.exe",
      args: [cli, "--version"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    const viaCmd = versionCommand(cmd, true, fakeFs({ [cmd]: "@echo off\r\nfoo %*" }), "node", "cmd.exe");
    expect(viaCmd.file).toBe("cmd.exe");
    expect(viaCmd.windowsVerbatimArguments).toBe(true);
    expect(viaCmd.args).toEqual(["/d", "/s", "/c", `"${NPM}\\claude.cmd ^^^"--version^^^""`]);
  });

  it("the session spawns what the shim launches, and refuses a shim with nothing behind it", () => {
    const cmd = `${NPM}\\claude.cmd`;
    const exe = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    const cli = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    expect(resolveClaudeExecutable(cmd, true, fakeFs({ [cmd]: SHIM_EXE, [exe]: "" }))).toEqual({ path: exe });
    const js = resolveClaudeExecutable(cmd, true, fakeFs({ [cmd]: SHIM_JS, [cli]: "" }));
    expect(js.path).toBe(cli);
    expect(js.executable).toBe(process.execPath);
    expect(js.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(resolveClaudeExecutable("/usr/local/bin/claude", false)).toEqual({ path: "/usr/local/bin/claude" });

    expect(claudeLaunchProblem(cmd, true, fakeFs({ [cmd]: SHIM_JS, [cli]: "" }))).toBeNull();
    expect(claudeLaunchProblem(cmd, true, fakeFs({ [cmd]: "@echo off" }))).toMatch(/batch file .*claude\.cmd/);
    expect(claudeLaunchProblem(cmd, false, fakeFs({}))).toBeNull();
    expect(claudeLaunchProblem("C:\\x\\claude.exe", true, fakeFs({}))).toBeNull();
  });
});

describe("openTerminal command (Windows)", () => {
  it("splits simple POSIX-quoted command lines and rejects shell syntax", () => {
    expect(splitSimpleCommand("gh auth login --hostname 'github.com' --web --git-protocol https")).toEqual([
      "gh", "auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https",
    ]);
    expect(splitSimpleCommand('claude "/login"')).toEqual(["claude", "/login"]);
    expect(splitSimpleCommand("gh auth login && calc")).toBeNull();
    expect(splitSimpleCommand("gh 'unterminated")).toBeNull();
    expect(splitSimpleCommand('gh "$HOME"')).toBeNull();
    expect(splitSimpleCommand("gh %PATH%")).toBeNull();
    expect(splitSimpleCommand("gh a|b")).toBeNull();
    expect(splitSimpleCommand("   ")).toBeNull();
  });

  it("builds cmd.exe /d /s /k with escaped arguments for allowed programs only", () => {
    const inv = terminalInvocation("gh auth login --hostname 'ghe.example.com:8443' --web --git-protocol https", "cmd.exe");
    expect(inv.file).toBe("cmd.exe");
    expect(inv.windowsVerbatimArguments).toBe(true);
    expect(inv.args).toEqual([
      "/d", "/s", "/k",
      '"gh ^"auth^" ^"login^" ^"--hostname^" ^"ghe.example.com:8443^" ^"--web^" ^"--git-protocol^" ^"https^""',
    ]);
    expect(() => terminalInvocation("powershell -c calc")).toThrow(/not allowed/);
    expect(() => terminalInvocation("gh auth login & calc")).toThrow(/unsupported/);
    expect(() => terminalInvocation("C:\\evil\\gh.exe auth")).toThrow(/unsupported/);
  });
});
