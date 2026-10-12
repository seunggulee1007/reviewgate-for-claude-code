/**
 * Bash `tool_result` helpers (docs/PROTOCOL.md §2): the bounded output the engine keeps for
 * `tool_output`, and the `testOutcome` heuristic for recognizable test runners.
 */
import type { TestOutcome } from "../protocol.js";
import { testCommandKind } from "./testCommands.js";

/** `tool_result.preview` length. */
export const PREVIEW_CHARS = 500;
/** Bash output kept for `tool_output`: the head and the tail of anything longer (the verdict of a test run is at the end). */
export const KEPT_OUTPUT_CHARS = 20_000;
const KEPT_HEAD_CHARS = 4_000;

/** Bash output capped at `KEPT_OUTPUT_CHARS`: head + marker + tail when longer. */
export function keptOutput(text: string): { output: string; truncated: boolean } {
  if (text.length <= KEPT_OUTPUT_CHARS) return { output: text, truncated: false };
  const tail = KEPT_OUTPUT_CHARS - KEPT_HEAD_CHARS;
  const omitted = text.length - KEPT_OUTPUT_CHARS;
  return { output: `${text.slice(0, KEPT_HEAD_CHARS)}\n… [${omitted} chars omitted] …\n${text.slice(-tail)}`, truncated: true };
}

/** Failure markers of the recognized runners (`testCommands.ts`; counts must be non-zero). */
const FAIL_RE = new RegExp(
  [
    String.raw`\b[1-9]\d*\s+(?:failed|failing)\b`, // vitest / jest / pytest / mocha
    String.raw`\bTests?:\s+[1-9]\d*\s+failed\b`, // jest summary
    String.raw`\bwith\s+[1-9]\d*\s+failures?\b`, // XCTest "Executed 3 tests, with 1 failure"
    String.raw`✘\s+Test run with \d+ tests?(?: in \d+ suites?)? failed`, // swift-testing
    String.raw`^\s*FAIL\b`, // go test / jest file header
    String.raw`^--- FAIL:`, // go test
    String.raw`\btest result: FAILED\b`, // cargo
    String.raw`\*\* TEST FAILED \*\*`, // xcodebuild
    String.raw`^=+ .*\b(?:failed|error)\b.* in [\d.]+s`, // pytest footer
    String.raw`\bnpm ERR! Test failed\b`,
    // §34.9 Surefire / Maven / Gradle
    String.raw`\bTests run:\s*\d+,\s*Failures:\s*(?:[1-9]\d*,\s*Errors:\s*\d+|\d+,\s*Errors:\s*[1-9]\d*)`,
    String.raw`\bThere are test failures\b`,
    String.raw`\bBUILD FAILURE\b`,
    String.raw`\bBUILD FAILED\b`,
    String.raw`^\s*> There were failing tests\b`,
    String.raw`\b\d+ tests? completed, [1-9]\d* failed\b`,
  ].join("|"),
  "im",
);

/** Success markers (checked only when no failure marker matched). */
const PASS_RE = new RegExp(
  [
    String.raw`\b[1-9]\d*\s+passed\b`, // vitest / jest / pytest
    String.raw`\bTests?:\s+[1-9]\d*\s+passed\b`,
    String.raw`\bwith\s+0\s+failures\b`, // XCTest
    String.raw`✔\s+Test run with \d+ tests?(?: in \d+ suites?)? passed`, // swift-testing
    String.raw`^ok\s+\S+`, // go test package line
    String.raw`^PASS$`, // go test
    String.raw`\btest result: ok\b`, // cargo
    String.raw`\*\* TEST SUCCEEDED \*\*`, // xcodebuild
    // §34.9 Surefire / Maven / Gradle
    String.raw`\bTests run:\s*[1-9]\d*,\s*Failures:\s*0,\s*Errors:\s*0\b`,
    String.raw`\bBUILD SUCCESS(?:FUL)?\b`,
  ].join("|"),
  "im",
);

/**
 * §34.9: the output shows tests ran — what makes an `implicit` run (Maven `install`, Gradle `build`) a test run: a
 * Surefire / Failsafe summary or banner, a Gradle test task or its summary.
 */
const TESTS_RAN_RE = new RegExp(
  [
    String.raw`\bTests run:\s*[1-9]`,
    String.raw`\bThere are test failures\b`,
    String.raw`^\s*(?:\[\w+\]\s*)?T E S T S\b`,
    String.raw`^> Task \S*:\w*[Tt]est\w*\b`,
    String.raw`\b\d+ tests? completed\b`,
    String.raw`^\s*> There were failing tests\b`,
  ].join("|"),
  "m",
);

/**
 * `pass` / `fail` for a Bash call running a recognizable test command (`testCommands.ts`, plus the user's
 * `settings.testCommandPatterns`); undefined otherwise (or when the command went to the background, or an implicit run
 * — Maven `install`, Gradle `build` — shows no tests). A non-zero exit (`isError`) or a failure marker is `fail`; a
 * success marker — or a clean exit without any marker — is `pass`.
 */
export function detectTestOutcome(command: string, isError: boolean, output: string, background = false, patterns: readonly string[] = []): TestOutcome | undefined {
  if (background) return undefined;
  const kind = testCommandKind(command, patterns);
  if (kind === null) return undefined;
  if (kind === "implicit" && !TESTS_RAN_RE.test(output)) return undefined;
  if (isError) return "fail";
  if (FAIL_RE.test(output)) return "fail";
  if (PASS_RE.test(output)) return "pass";
  return "pass";
}

/**
 * Bash outputs kept for `tool_output` (this engine's lifetime only): oldest entries are evicted beyond
 * `maxEntries` or `maxChars` in total.
 */
export class ToolOutputStore {
  private readonly items = new Map<string, { output: string; truncated: boolean }>();
  private chars = 0;

  constructor(
    private readonly maxEntries = 100,
    private readonly maxChars = 2_000_000,
  ) {}

  set(toolUseId: string, output: string, truncated: boolean): void {
    this.delete(toolUseId);
    this.items.set(toolUseId, { output, truncated });
    this.chars += output.length;
    for (const [id] of this.items) {
      if (this.items.size <= this.maxEntries && this.chars <= this.maxChars) break;
      this.delete(id);
    }
  }

  get(toolUseId: string): { output: string; truncated: boolean } | undefined {
    return this.items.get(toolUseId);
  }

  clear(): void {
    this.items.clear();
    this.chars = 0;
  }

  private delete(toolUseId: string): void {
    const old = this.items.get(toolUseId);
    if (!old) return;
    this.items.delete(toolUseId);
    this.chars -= old.output.length;
  }
}
