import { describe, expect, it } from "vitest";
import { BUILT_IN_TEST_COMMANDS, testCommandPatternsOf } from "../shared/testCommands.js";
import { sanitizeSettingsPatch } from "./settingsGuard.js";

// wave3 check-clients — Settings › "테스트 명령 패턴" (`settings.testCommandPatterns`, docs/PROTOCOL.md §34.9).
describe("test command patterns (§34.9)", () => {
  it("one pattern per line: trimmed, blank lines and # comments dropped, each once", () => {
    expect(testCommandPatternsOf("./run-tests.sh*\n\n  # ours\n *integrationTest* \r\n./run-tests.sh*")).toEqual(["./run-tests.sh*", "*integrationTest*"]);
    expect(testCommandPatternsOf("")).toEqual([]);
    expect(testCommandPatternsOf(undefined)).toEqual([]);
  });

  it("the renderer may write the text; anything else is refused", () => {
    expect(sanitizeSettingsPatch({ testCommandPatterns: "./mvn25.sh*test*" })).toEqual({ patch: { testCommandPatterns: "./mvn25.sh*test*" }, rejected: [] });
    expect(sanitizeSettingsPatch({ testCommandPatterns: ["a"] }).rejected).toEqual(["testCommandPatterns"]);
    expect(sanitizeSettingsPatch({ testCommandPatterns: "a\0b" }).rejected).toEqual(["testCommandPatterns"]);
  });

  it("names what the engine already recognizes, Maven and Gradle first", () => {
    expect(BUILT_IN_TEST_COMMANDS.startsWith("mvn")).toBe(true);
    for (const cmd of ["*mvn*.sh", "gradlew", "vitest", "pytest", "make test", "node --test", "dotnet test"]) expect(BUILT_IN_TEST_COMMANDS).toContain(cmd);
  });
});
