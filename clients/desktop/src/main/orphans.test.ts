import { describe, expect, it } from "vitest";
import { parseProcessCsv, parsePs } from "./orphans.js";

describe("parsePs", () => {
  it("lists live children that are not Electron's", () => {
    const out = ["  10   1 S /sbin/launchd", " 200 100 S /opt/homebrew/bin/claude", " 201 100 Z git", " 202 100 S Electron Helper (Renderer)", " 203 100 R ps", " 204 100 S gh"].join("\n");
    expect(parsePs(out, 100)).toEqual(["/opt/homebrew/bin/claude", "gh"]);
  });
});

describe("parseProcessCsv", () => {
  it("reads PowerShell ConvertTo-Csv output", () => {
    const out = '"Name","ProcessId"\r\n"ReviewGate.exe","4100"\r\n"claude.exe","4200"\r\n"git.exe","4300"\r\n"conhost.exe","4400"\r\n';
    expect(parseProcessCsv(out)).toEqual(["claude.exe", "git.exe"]);
  });

  it("reads wmic /format:csv output (Node column first, blank lines)", () => {
    const out = "\r\r\nNode,Name,ProcessId\r\r\nDESKTOP-1,electron.exe,10\r\r\nDESKTOP-1,gh.exe,11\r\r\n";
    expect(parseProcessCsv(out)).toEqual(["gh.exe"]);
  });

  it("is empty without a header", () => {
    expect(parseProcessCsv("")).toEqual([]);
    expect(parseProcessCsv("No Instance(s) Available.")).toEqual([]);
  });
});
