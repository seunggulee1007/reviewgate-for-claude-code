import { describe, expect, it } from "vitest";
import { testCommandKind } from "../src/session/testCommands.js";
import { detectTestOutcome } from "../src/session/toolOutput.js";

/**
 * docs/PROTOCOL.md §37.7: the §12 runners (`vitest`, `jest`, `pytest`, `npm test`, `go test` …) used to count anywhere in a
 * Bash line, so a command that only reads, searches, prints or installs counted as a test run — and, exiting cleanly, as a
 * passing one: `grep -rn "jest" src`, `cat vitest.config.ts`, `npm i -D vitest` became `turn_summary.lastTest` "테스트 통과"
 * (§34.9) while no test ran. Now such a simple command is never a test run; a runner after it in the same line still is.
 */

describe("a command that only reads, searches, prints or installs runs no test (§37.7)", () => {
  it.each([
    `grep -rn "jest" src`,
    "rg -l vitest packages/",
    "cat vitest.config.ts",
    "head -20 jest.config.js",
    "ls node_modules/.bin/jest",
    `find . -name "pytest.ini"`,
    "which pytest",
    `sed -i '' 's/jest/vitest/' package.json`,
    `echo "npm test"`,
    `grep -rn "go test" Makefile`,
    "npm install --save-dev jest",
    "npm i -D vitest@3",
    "pnpm add -D vitest",
    "yarn add --dev jest",
    "bun add -d vitest",
    "pip install pytest",
    "python -m pip install pytest",
    "uv pip install pytest",
    "poetry add --group dev pytest",
    "git log --oneline --grep=jest",
    // git by its name (§20 programName): Git Bash's git.exe, any case, a quoted Windows path keeping its backslashes
    "git.exe log --oneline --grep=jest",
    "GIT.EXE commit -m 'fix the vitest config'",
    "\"C:\\Program Files\\Git\\cmd\\git.exe\" log --grep=pytest",
  ])("not a test run: %s", (cmd) => {
    expect(testCommandKind(cmd)).toBeNull();
    expect(detectTestOutcome(cmd, false, "ok")).toBeUndefined();
  });

  it.each([
    "npx vitest run",
    "cd engine && npm test",
    "npm run test:unit",
    "npm test 2>&1 | tail -50",
    "yarn test",
    "yarn jest --ci",
    "pnpm -r test",
    "bun test",
    "npm exec vitest",
    "pytest tests/ -q",
    "python -m pytest -q",
    "poetry run pytest",
    "go test ./...",
    "cargo test",
    "swift test --package-path Core",
    "xcodebuild -scheme App test",
    "grep -c jest package.json && npx jest",
    `find . -name "*.test.ts" | xargs npx vitest run`,
    `find . -name "*.spec.ts" -exec npx jest {} +`,
    `bash -c "npm test"`,
    "docker compose exec web pytest",
  ])("still a test run: %s", (cmd) => {
    expect(testCommandKind(cmd)).toBe("explicit");
  });

  it("a Gradle dry run executes no task", () => {
    expect(testCommandKind("./gradlew test --dry-run")).toBeNull();
    expect(testCommandKind("./gradlew -m check")).toBeNull();
    expect(testCommandKind("./gradlew test")).toBe("explicit");
  });
});
