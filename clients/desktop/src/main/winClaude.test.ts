import { describe, expect, it } from "vitest";
import { resolveWindowsClaude, shimTarget } from "./winClaude.js";

const NPM = "C:\\Users\\홍 길동\\AppData\\Roaming\\npm";
const SHIM_JS = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`;
const SHIM_EXE = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`;

const fsOf = (files: Record<string, string>) => ({ exists: (p: string) => p in files, read: (p: string) => files[p] ?? null });
const env = { USERPROFILE: "C:\\Users\\홍 길동" };

describe("shimTarget", () => {
  it("finds the program an npm cmd-shim runs", () => {
    expect(shimTarget(SHIM_JS)).toBe("node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(shimTarget(SHIM_EXE)).toBe("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
    expect(shimTarget(`"%~dp0\\..\\lib\\claude.exe" %*`)).toBe("..\\lib\\claude.exe");
    expect(shimTarget("@echo hi")).toBeNull();
  });
});

describe("resolveWindowsClaude", () => {
  it("leaves a native claude.exe alone", () => {
    expect(resolveWindowsClaude("C:\\Users\\a\\.local\\bin\\claude.exe", fsOf({}), env)).toBe("C:\\Users\\a\\.local\\bin\\claude.exe");
  });

  it("uses the .exe the shim launches", () => {
    const exe = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    expect(resolveWindowsClaude(`${NPM}\\claude.cmd`, fsOf({ [`${NPM}\\claude.cmd`]: SHIM_EXE, [exe]: "" }), env)).toBe(exe);
  });

  it("prefers a native exe in the package over the cli.js shim", () => {
    const exe = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\claude.exe`;
    const files = { [`${NPM}\\claude.cmd`]: SHIM_JS, [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`]: "", [exe]: "" };
    expect(resolveWindowsClaude(`${NPM}\\claude.cmd`, fsOf(files), env)).toBe(exe);
  });

  it("keeps a cli.js shim for the engine's Electron-as-node path", () => {
    const files = { [`${NPM}\\claude.cmd`]: SHIM_JS, [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`]: "" };
    expect(resolveWindowsClaude(`${NPM}\\claude.cmd`, fsOf(files), env)).toBe(`${NPM}\\claude.cmd`);
  });

  it("falls back to the native installer's claude.exe", () => {
    const files = { [`${NPM}\\claude.cmd`]: "@echo broken", "C:\\Users\\홍 길동\\.local\\bin\\claude.exe": "" };
    expect(resolveWindowsClaude(`${NPM}\\claude.cmd`, fsOf(files), env)).toBe("C:\\Users\\홍 길동\\.local\\bin\\claude.exe");
  });
});
