/**
 * wave3 check-clients — Settings › "테스트 명령 패턴" (`settings.testCommandPatterns`, docs/PROTOCOL.md §34.9), as on the
 * Mac (TestCommandSettings.swift): the user's own test commands, one glob per line, added to the runners the engine
 * recognizes by itself (session/testCommands.ts). Pure; main parses the text, the renderer shows the built-in list.
 */

/** What the engine recognizes without a pattern (§34.9 / §12) — Maven and Gradle first; shown under the box. */
export const BUILT_IN_TEST_COMMANDS =
  "mvn · mvnw · *mvn*.sh · gradle · gradlew · npm / pnpm / yarn / bun test · vitest · jest · pytest · go test · cargo test · swift test · xcodebuild test · make test / check · node --test · mocha · phpunit · dotnet test · bazel test · ctest";

/** The box's text → the patterns sent to the engine: trimmed lines, blank lines and `#` comments dropped, each once. */
export function testCommandPatternsOf(text: string | undefined): string[] {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  return [...new Set(lines)];
}
