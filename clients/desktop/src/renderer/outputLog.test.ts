/**
 * MARK: c-panel — §57.18: the bottom panel's Output on Windows — the line limit (oldest dropped), the source filter and
 * search, a Bash block, and the store's events feeding it (a cut preview replaced by the kept full output).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { appendOutput, bashBlock, clearOutputLog, EMPTY_OUTPUT, filterOutput, OUTPUT_LIMIT, outputLogLine, outputText, outputToolResult, outputToolUse, useOutputLog } from "./outputLog";

describe("the output buffer (§57.18)", () => {
  beforeEach(() => initI18n("en", "win32"));

  it("drops the oldest lines past the limit", () => {
    let b = appendOutput(EMPTY_OUTPUT, "reviewGate", "one\ntwo", 3);
    b = appendOutput(b, "claude", "three\r\nfour\n", 3);
    expect(b.lines.map((l) => l.text)).toEqual(["two", "three", "four"]);
    b = appendOutput(b, "reviewGate", Array.from({ length: 10 }, (_, i) => String(i + 1)).join("\n"), 3);
    expect(b.lines.map((l) => l.text)).toEqual(["8", "9", "10"]);
    expect(new Set(b.lines.map((l) => l.id)).size).toBe(3);
    expect(OUTPUT_LIMIT).toBe(5000);
  });

  it("filters by source and search", () => {
    let b = appendOutput(EMPTY_OUTPUT, "reviewGate", "[info] engine started");
    b = appendOutput(b, "claude", "$ ./gradlew test\nBUILD SUCCESSFUL");
    b = appendOutput(b, "reviewGate", "[warn] Build cache is cold");
    expect(filterOutput(b.lines, "claude", "").map((l) => l.text)).toEqual(["$ ./gradlew test", "BUILD SUCCESSFUL"]);
    expect(filterOutput(b.lines, "all", " build ").map((l) => l.text)).toEqual(["BUILD SUCCESSFUL", "[warn] Build cache is cold"]);
    expect(outputText(filterOutput(b.lines, "reviewGate", ""))).toBe("[info] engine started\n[warn] Build cache is cold");
  });

  it("a Bash block has its command, output and ending", () => {
    expect(bashBlock("npm test", "1 passed\n", false, false)).toBe("$ npm test\n1 passed");
    expect(bashBlock("make\nmake install", "", true, true)).toBe("$ make\n  make install\n… (the output was cut)\n✗ The command failed");
  });

  it("the store's log lines and Claude's Bash calls reach it; a cut preview waits for the kept output", async () => {
    clearOutputLog();
    outputLogLine("[warn] acme warning");
    outputToolUse("t1", "Bash", { command: "./mvnw test" });
    outputToolUse("t2", "Read", { file_path: "C:\\work\\acme\\a.txt" });
    outputToolResult({ toolUseId: "t2", isError: false, preview: "file text" }, async () => ({ output: null, truncated: false }));
    outputToolResult({ toolUseId: "t1", isError: false, preview: "Tests run: 3" }, async () => ({ output: null, truncated: false }));
    outputToolResult({ toolUseId: "t9", isError: false, preview: "restored" }, async () => ({ output: null, truncated: false }));
    outputToolUse("t3", "Bash", { command: "npm test" });
    let fetched = "";
    outputToolResult({ toolUseId: "t3", isError: true, preview: "head…", truncated: true }, async (id) => ((fetched = id), { output: "head…\n…tail: 1 failed", truncated: false }));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetched).toBe("t3");
    const lines = useOutputLog.getState().lines;
    expect(filterOutput(lines, "reviewGate", "").map((l) => l.text)).toEqual(["[warn] acme warning"]);
    expect(filterOutput(lines, "claude", "").map((l) => l.text)).toEqual(["$ ./mvnw test", "Tests run: 3", "$ npm test", "head…", "…tail: 1 failed", "✗ The command failed"]);
    clearOutputLog();
    expect(useOutputLog.getState().lines).toEqual([]);
  });
});
