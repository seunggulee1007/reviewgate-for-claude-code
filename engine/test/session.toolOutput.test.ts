import { describe, expect, it } from "vitest";
import { detectTestOutcome, KEPT_OUTPUT_CHARS, keptOutput, ToolOutputStore } from "../src/session/toolOutput.js";

describe("detectTestOutcome", () => {
  it("only recognizes test runners", () => {
    expect(detectTestOutcome("ls -la", false, "3 passed")).toBeUndefined();
    expect(detectTestOutcome("git status", true, "")).toBeUndefined();
    expect(detectTestOutcome("npm test", false, "", true)).toBeUndefined(); // backgrounded
  });

  it.each([
    ["npx vitest run", " Test Files  4 passed (4)\n      Tests  20 passed (20)"],
    ["npm test -w engine", "Tests:       12 passed, 12 total"],
    ["python -m pytest -q", "===== 8 passed in 0.12s ====="],
    ["swift test --package-path Core", "Executed 14 tests, with 0 failures (0 unexpected) in 0.5 seconds"],
    ["swift test", "✔ Test run with 33 tests in 6 suites passed after 0.2 seconds."],
    ["go test ./...", "ok  \texample.com/pkg\t0.01s"],
    ["cargo test", "test result: ok. 3 passed; 0 failed; 0 ignored"],
    ["xcodebuild -scheme App test", "** TEST SUCCEEDED **"],
    ["yarn test", "Done in 1s"], // clean exit without a marker
  ])("pass: %s", (cmd, out) => {
    expect(detectTestOutcome(cmd, false, out)).toBe("pass");
  });

  it.each([
    ["npx vitest run", " Test Files  1 failed | 3 passed (4)", false],
    ["npm test", "Tests:       1 failed, 11 passed, 12 total", false],
    ["pytest", "=== 1 failed, 7 passed in 0.30s ===", false],
    ["swift test", "Executed 14 tests, with 2 failures (0 unexpected)", false],
    ["go test ./...", "--- FAIL: TestX (0.00s)\nFAIL\texample.com/pkg", false],
    ["cargo test", "test result: FAILED. 2 passed; 1 failed", false],
    ["xcodebuild test -scheme App", "** TEST FAILED **", false],
    ["npm test 2>&1 | tail -5", "anything", true], // non-zero exit
  ])("fail: %s", (cmd, out, isError) => {
    expect(detectTestOutcome(cmd, isError, out)).toBe("fail");
  });
});

describe("keptOutput / ToolOutputStore", () => {
  it("keeps short output whole and head + tail of long output", () => {
    expect(keptOutput("abc")).toEqual({ output: "abc", truncated: false });
    const long = "h".repeat(10_000) + "m".repeat(50_000) + "TAIL";
    const k = keptOutput(long);
    expect(k.truncated).toBe(true);
    expect(k.output.startsWith("hhhh")).toBe(true);
    expect(k.output.endsWith("mTAIL")).toBe(true);
    expect(k.output).toContain("[40004 chars omitted]");
    expect(k.output.length).toBeLessThan(KEPT_OUTPUT_CHARS + 100);
  });

  it("evicts the oldest entries beyond the entry and size caps", () => {
    const store = new ToolOutputStore(2, 10);
    store.set("a", "1234", false);
    store.set("b", "5678", false);
    store.set("c", "9", true);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("c")).toEqual({ output: "9", truncated: true });
    store.set("d", "123456789", false);
    expect(store.get("b")).toBeUndefined();
    expect(store.get("d")?.output).toBe("123456789");
  });
});
