import { describe, expect, it } from "vitest";
import type { TerminalSpecEvent } from "@reviewgate/engine";
import { hookSettings, terminalArgv, TERMINAL_SYSTEM_APPEND } from "../../../../../engine/src/session/terminalSpec.js";
import {
  buildChatLaunch,
  buildShellLaunch,
  COMMAND_LINE_TOO_LONG,
  MAX_COMMAND_LINE,
  NEEDS_NATIVE_CLAUDE,
  whichSync,
  windowsCommandLine,
  type ChatLaunchInput,
  type ShimFs,
} from "./terminalLaunch.js";

/** CommandLineToArgvW (the same model as winCmd.test.ts). */
function argvOf(s: string): string[] {
  const args: string[] = [];
  let cur = "";
  let inQ = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\") {
      let n = 0;
      while (s[i] === "\\") (n++, i++);
      if (s[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else inQ = !inQ;
        started = true;
      } else {
        cur += "\\".repeat(n);
        i--;
      }
    } else if (c === '"') {
      inQ = !inQ;
      started = true;
    } else if ((c === " " || c === "\t") && !inQ) {
      if (cur || started) args.push(cur);
      cur = "";
      started = false;
    } else cur += c;
  }
  if (cur || started) args.push(cur);
  return args;
}

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SETTINGS = JSON.stringify(hookSettings("http://127.0.0.1:51234/hook"));
const EXE = "C:\\Users\\dev\\.local\\bin\\claude.exe";
const NPM = "C:\\Users\\dev\\AppData\\Roaming\\npm";

function spec(o: Partial<TerminalSpecEvent> = {}): TerminalSpecEvent {
  return {
    type: "terminal_spec",
    sessionId: ID,
    argv: terminalArgv({ claude: EXE, id: ID, resume: false, settingsJson: SETTINGS }),
    env: { RG_HOOK_TOKEN: "a".repeat(64) },
    cwd: "C:\\work\\acme",
    resume: false,
    ...o,
  };
}

function fsOf(files: Record<string, string>): ShimFs {
  const has = (p: string) => Object.keys(files).some((k) => k.toLowerCase() === p.toLowerCase());
  return { exists: has, read: (p) => (has(p) ? files[Object.keys(files).find((k) => k.toLowerCase() === p.toLowerCase())!]! : null) };
}

const PARENT = {
  Path: "C:\\Windows\\system32;C:\\Windows;C:\\Users\\dev\\AppData\\Roaming\\npm",
  SystemRoot: "C:\\Windows",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  USERPROFILE: "C:\\Users\\dev",
  APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
  TEMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
  CLAUDE_CONFIG_DIR: "C:\\Users\\dev\\.claude-alt",
  CLAUDE_CODE_GIT_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe",
  ANTHROPIC_BASE_URL: "https://llm.example.com",
  HTTPS_PROXY: "http://proxy.example.com:8080",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  CLAUDE_CODE_SSE_PORT: "1234",
  CLAUDE_AGENT_SDK_VERSION: "0.3.270",
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_NO_ATTACH_CONSOLE: "1",
  NODE_OPTIONS: "--inspect",
  VITE_DEV_SERVER_URL: "http://localhost:5173",
  REVIEWGATE_DATA_DIR: "C:\\x",
  RG_HOOK_TOKEN: "parent-token",
  rg_other: "x",
  "=C:": "C:\\work",
  UNSET: undefined,
};

function win(o: Partial<ChatLaunchInput> = {}): ChatLaunchInput {
  return { spec: spec(), platform: "win32", parentEnv: PARENT, appVersion: "0.5.17", fullRepaint: true, fs: fsOf({ [EXE]: "" }), which: () => null, ...o };
}

describe("windowsCommandLine (§57.10)", () => {
  it("round-trips through CommandLineToArgvW: the real settings JSON, the system prompt, Korean, backslashes, quotes, empty", () => {
    const cases = [
      SETTINGS,
      TERMINAL_SYSTEM_APPEND, // … — ' and line breaks
      "한글 경로\\메모.txt",
      "C:\\path with space\\",
      "trailing\\\\",
      'a "quoted" word',
      'ends with backslash quote \\"',
      "",
      "${RG_HOOK_TOKEN}",
      "tab\there",
      "%PATH% ^ & | < > !x!",
    ];
    expect(argvOf(windowsCommandLine(cases))).toEqual(cases);
    // Every argument is quoted (node-pty's own quoting never runs on a string).
    expect(windowsCommandLine(["a", "b"])).toBe('"a" "b"');
  });

  it("the whole spec argv survives; ${RG_HOOK_TOKEN} stays literal", () => {
    const r = buildChatLaunch(win());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.args).toBe("string");
    const back = argvOf(r.args as string);
    expect(back).toEqual(spec().argv.slice(1));
    expect(r.args as string).toContain("${RG_HOOK_TOKEN}");
    expect(r.args as string).not.toContain("a".repeat(64)); // the token rides in env only
  });
});

describe("buildChatLaunch on Windows (§57.10)", () => {
  it("a .exe is used as is", () => {
    const r = buildChatLaunch(win());
    expect(r).toMatchObject({ ok: true, file: EXE, cwd: "C:\\work\\acme" });
  });

  it("npm's cli.js shim: node.exe beside the shim, else node on PATH, else refused; a .cmd target is never run", () => {
    const shim = `${NPM}\\claude.cmd`;
    const cli = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    const shimText = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)';
    const s = spec({ argv: terminalArgv({ claude: shim, id: ID, resume: true, settingsJson: SETTINGS }) });
    const beside = buildChatLaunch(win({ spec: s, fs: fsOf({ [shim]: shimText, [cli]: "", [`${NPM}\\node.exe`]: "" }), which: () => "C:\\Program Files\\nodejs\\node.exe" }));
    expect(beside).toMatchObject({ ok: true, file: `${NPM}\\node.exe` });
    expect(beside.ok && argvOf(beside.args as string)).toEqual([cli, ...s.argv.slice(1)]);

    const onPath = buildChatLaunch(win({ spec: s, fs: fsOf({ [shim]: shimText, [cli]: "" }), which: (n) => (n === "node" ? "C:\\Program Files\\nodejs\\node.exe" : null) }));
    expect(onPath).toMatchObject({ ok: true, file: "C:\\Program Files\\nodejs\\node.exe" });

    const none = buildChatLaunch(win({ spec: s, fs: fsOf({ [shim]: shimText, [cli]: "" }), which: () => null }));
    expect(none).toEqual({ ok: false, code: "terminal_needs_native_claude", error: NEEDS_NATIVE_CLAUDE });
    // A node that is itself a batch shim (volta / nvs style) is not a node.exe.
    const batchNode = buildChatLaunch(win({ spec: s, fs: fsOf({ [shim]: shimText, [cli]: "" }), which: () => "C:\\tools\\node.cmd" }));
    expect(batchNode).toMatchObject({ ok: false, code: "terminal_needs_native_claude" });

    // A .cmd with nothing runnable behind it: refused, never cmd.exe.
    const bare = spec({ argv: terminalArgv({ claude: "C:\\tools\\claude.cmd", id: ID, resume: false, settingsJson: SETTINGS }) });
    const refused = buildChatLaunch(win({ spec: bare, fs: fsOf({ "C:\\tools\\claude.cmd": "@echo off\r\nsomething %*" }) }));
    expect(refused).toMatchObject({ ok: false, code: "terminal_needs_native_claude" });
    for (const r of [beside, onPath]) expect(r.ok && /cmd\.exe$/i.test(r.file)).toBe(false);
  });

  it("a shim that launches a claude.exe runs that exe", () => {
    const shim = `${NPM}\\claude.cmd`;
    const target = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    const s = spec({ argv: terminalArgv({ claude: shim, id: ID, resume: false, settingsJson: SETTINGS }) });
    const r = buildChatLaunch(win({ spec: s, fs: fsOf({ [shim]: '"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*', [target]: "" }) }));
    expect(r).toMatchObject({ ok: true, file: target });
  });

  it("refuses a command line over 30,000 characters", () => {
    const long = (n: number) => spec({ argv: [EXE, "--settings", "x".repeat(n)] });
    const fits = MAX_COMMAND_LINE - EXE.length - 3 - '"--settings" ""'.length;
    expect(buildChatLaunch(win({ spec: long(fits) })).ok).toBe(true);
    expect(buildChatLaunch(win({ spec: long(fits + 1) }))).toEqual({ ok: false, code: "terminal_cmdline_too_long", error: COMMAND_LINE_TOO_LONG });
    // Today's argv is far below it.
    const r = buildChatLaunch(win());
    expect(r.ok && (r.args as string).length).toBeLessThan(5000);
  });

  it("the environment: case-insensitive merge, the drop list, the user's CLAUDE_* kept, terminal identity, spec keys filtered", () => {
    const r = buildChatLaunch(win({ parentEnv: { ...PARENT, PATH: "C:\\dup" }, spec: spec({ env: { RG_HOOK_TOKEN: "t".repeat(64), CLAUDE_CODE_X: "1", OTHER: "no", PATH: "C:\\evil" } }) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const keys = Object.keys(r.env);
    expect(new Set(keys.map((k) => k.toUpperCase())).size).toBe(keys.length); // one entry per name
    expect(r.env.Path).toBe(PARENT.Path); // the parent's first spelling
    expect(r.env.PATH).toBeUndefined();
    for (const k of ["SystemRoot", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH", "ANTHROPIC_BASE_URL", "HTTPS_PROXY"]) {
      expect(r.env[k], k).toBe(PARENT[k as keyof typeof PARENT]);
    }
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "NODE_OPTIONS", "VITE_DEV_SERVER_URL", "REVIEWGATE_DATA_DIR", "rg_other", "=C:", "UNSET", "OTHER"]) {
      expect(r.env[k], k).toBeUndefined();
    }
    expect(r.env).toMatchObject({ TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "ReviewGate", TERM_PROGRAM_VERSION: "0.5.17", CLAUDE_CODE_NATIVE_CURSOR: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1", RG_HOOK_TOKEN: "t".repeat(64), CLAUDE_CODE_X: "1" });
    expect(keys.some((k) => /^(LANG|LC_)/.test(k))).toBe(false);

    const off = buildChatLaunch(win({ fullRepaint: false }));
    expect(off.ok && off.env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT).toBeUndefined();
  });
});

describe("buildShellLaunch (§57.10)", () => {
  it("PowerShell: pwsh when present, else Windows PowerShell; -NoLogo; no RG_* or claude terminal variables", () => {
    const pwsh = buildShellLaunch({ shell: "powershell", cwd: "C:\\work\\acme", platform: "win32", parentEnv: { ...PARENT, CLAUDE_CODE_NATIVE_CURSOR: "1" }, which: (n) => (n === "pwsh" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : null), appVersion: "0.5.17" });
    expect(pwsh).toMatchObject({ ok: true, file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: "-NoLogo", cwd: "C:\\work\\acme" });
    const ps = buildShellLaunch({ shell: "powershell", cwd: "C:\\work\\acme", platform: "win32", parentEnv: PARENT, which: () => null });
    expect(ps.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    for (const r of [pwsh, ps]) {
      expect(Object.keys(r.env).some((k) => k.toUpperCase().startsWith("RG_"))).toBe(false);
      expect(r.env.CLAUDE_CODE_NATIVE_CURSOR).toBeUndefined();
      expect(r.env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT).toBeUndefined();
      expect(r.env.TERM_PROGRAM).toBe("ReviewGate");
      expect(r.env.CLAUDE_CONFIG_DIR).toBe(PARENT.CLAUDE_CONFIG_DIR);
    }
  });

  it("Command Prompt: %ComSpec%, else System32\\cmd.exe, no arguments", () => {
    expect(buildShellLaunch({ shell: "cmd", cwd: "C:\\work\\acme", platform: "win32", parentEnv: PARENT, which: () => null })).toMatchObject({ file: "C:\\Windows\\system32\\cmd.exe", args: "" });
    const { ComSpec: _c, ...noComspec } = PARENT;
    expect(buildShellLaunch({ shell: "cmd", cwd: "C:\\work\\acme", platform: "win32", parentEnv: { ...noComspec, SystemRoot: "D:\\Win" }, which: () => null }).file).toBe("D:\\Win\\System32\\cmd.exe");
  });
});

describe("POSIX development branch", () => {
  it("execs argv directly with the Mac's Stage 1 environment (no login shell)", () => {
    const s = spec({ argv: terminalArgv({ claude: "/usr/local/bin/claude", id: ID, resume: false, settingsJson: SETTINGS }), cwd: "/work/acme" });
    const r = buildChatLaunch({ spec: s, platform: "darwin", parentEnv: { HOME: "/Users/dev", PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: "/x", ELECTRON_RUN_AS_NODE: "1", SHELL: "/bin/zsh" }, appVersion: "0.5.17", fullRepaint: false, fs: fsOf({}), which: () => null });
    expect(r).toMatchObject({ ok: true, file: "/usr/local/bin/claude", args: s.argv.slice(1), cwd: "/work/acme" });
    if (!r.ok) return;
    expect(r.env).toEqual({ HOME: "/Users/dev", PATH: "/usr/bin:/bin", SHELL: "/bin/zsh", TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "ReviewGate", TERM_PROGRAM_VERSION: "0.5.17", LANG: "en_US.UTF-8", LC_CTYPE: "en_US.UTF-8", CLAUDE_CODE_NATIVE_CURSOR: "1", RG_HOOK_TOKEN: "a".repeat(64) });
    const sh = buildShellLaunch({ shell: "powershell", cwd: "/work/acme", platform: "linux", parentEnv: { SHELL: "/bin/bash", PATH: "/usr/bin" }, which: () => null });
    expect(sh).toMatchObject({ file: "/bin/bash", args: [], cwd: "/work/acme" });
    expect(sh.env.RG_HOOK_TOKEN).toBeUndefined();
  });
});

describe("whichSync", () => {
  it("Windows tries PATHEXT in each PATH folder (case-insensitive PATH name); POSIX needs the file", () => {
    const files = new Set(["C:\\tools\\pwsh.exe", "C:\\nodejs\\node.exe", "/usr/bin/pwsh"]);
    const isFile = (p: string) => files.has(p);
    expect(whichSync("pwsh", { platform: "win32", env: { Path: "C:\\none;\"C:\\tools\"", PATHEXT: ".COM;.EXE" }, isFile })).toBe("C:\\tools\\pwsh.exe");
    expect(whichSync("node", { platform: "win32", env: { PATH: "C:\\nodejs" }, isFile })).toBe("C:\\nodejs\\node.exe");
    expect(whichSync("git", { platform: "win32", env: { PATH: "C:\\nodejs" }, isFile })).toBeNull();
    expect(whichSync("pwsh", { platform: "linux", env: { PATH: "/bin:/usr/bin" }, isFile })).toBe("/usr/bin/pwsh");
    expect(whichSync("pwsh", { platform: "linux", env: {}, isFile })).toBeNull();
  });
});
