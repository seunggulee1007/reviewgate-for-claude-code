import { describe, expect, it } from "vitest";
import { DEFAULT_IGNORE_PATTERNS, matchesIgnore, parseIgnorePatterns } from "../src/git/ignore.js";

describe("matchesIgnore", () => {
  const p = [...DEFAULT_IGNORE_PATTERNS];

  it("prefix patterns", () => {
    expect(matchesIgnore(".omc/state/x.json", p)).toBe(true);
    expect(matchesIgnore(".claude/settings.local.json", p)).toBe(true);
    // shared project settings stay reviewable
    expect(matchesIgnore(".claude/settings.json", p)).toBe(false);
    expect(matchesIgnore("src/omc/x.swift", p)).toBe(false);
    expect(matchesIgnore("README.md", p)).toBe(false);
    expect(matchesIgnore("hello.txt", [])).toBe(false);
  });

  it("leading slash and empty patterns", () => {
    expect(matchesIgnore(".omc/a", ["/.omc/"])).toBe(true);
    expect(matchesIgnore("anything", ["", "/"])).toBe(false);
  });

  it("glob patterns", () => {
    expect(matchesIgnore("build/out/app.log", ["*.log"])).toBe(true);
    expect(matchesIgnore("app.log", ["*.log"])).toBe(true);
    expect(matchesIgnore("app.log.txt", ["*.log"])).toBe(false);
    expect(matchesIgnore("docs/generated/x.md", ["docs/*/x.md"])).toBe(true);
    expect(matchesIgnore("a/b/c/tmp.swp", ["**/*.swp"])).toBe(true);
    expect(matchesIgnore("src/main.swift", ["*.log", "dist/"])).toBe(false);
    expect(matchesIgnore("a+b.log", ["a+b.*"])).toBe(true);
  });

  it("parse one per line", () => {
    expect(parseIgnorePatterns(" .omc/ \n\n# comment\n.claude/\n*.log\n")).toEqual([".omc/", ".claude/", "*.log"]);
    expect(parseIgnorePatterns("")).toEqual([]);
    expect(parseIgnorePatterns("dist/\r\n*.tmp")).toEqual(["dist/", "*.tmp"]);
  });
});
