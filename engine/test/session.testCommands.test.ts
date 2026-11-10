import { describe, expect, it } from "vitest";
import { simpleCommands, testCommandKind } from "../src/session/testCommands.js";
import { detectTestOutcome } from "../src/session/toolOutput.js";

describe("simpleCommands (§34.9)", () => {
  it("splits on && || ; | & and newlines outside quotes, collapsing whitespace", () => {
    expect(simpleCommands(`cd api &&  ./mvn-ci.sh -q -o test 2>&1 | tail -50; echo "a && b" || true\nmake check &`)).toEqual([
      "cd api",
      "./mvn-ci.sh -q -o test 2>&1",
      "tail -50",
      `echo "a && b"`,
      "true",
      "make check",
    ]);
  });
});

describe("testCommandKind (§34.9)", () => {
  it.each([
    // Maven: test-running goals, wrappers and *mvn*.sh scripts
    ["./mvn-ci.sh -q -o test", "explicit"],
    ["cd api && ./mvn-ci.sh -q -o test -pl settlement -Dtest=SettlementServiceTest 2>&1 | tail -80", "explicit"],
    ["mvn verify", "explicit"],
    ["./mvnw -B clean test", "explicit"],
    ["mvnd -T 4 test", "explicit"],
    ["bash ./scripts/run-mvn.sh test", "explicit"],
    ["mvn -f api/pom.xml surefire:test", "explicit"],
    ["mvn org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test", "explicit"],
    ["mvn -Dtest=FooTest install", "explicit"],
    ["mvn clean install", "implicit"],
    ["mvn package", "implicit"],
    // Gradle
    ["./gradlew test", "explicit"],
    ["./gradlew :app:testDebugUnitTest --tests 'com.x.*'", "explicit"],
    ["gradle check", "explicit"],
    ["./gradlew integrationTest -x lint", "explicit"],
    ["./gradlew build", "implicit"],
    // Others of §34.9
    ["make test", "explicit"],
    ["make -C engine check", "explicit"],
    ["node --test test/", "explicit"],
    ["npx mocha 'test/**/*.spec.js'", "explicit"],
    ["vendor/bin/phpunit --filter UserTest", "explicit"],
    ["php vendor/bin/phpunit", "explicit"],
    ["dotnet test Api.Tests", "explicit"],
    ["bazel --output_base=/tmp/b test //api/...", "explicit"],
    ["ctest --output-on-failure", "explicit"],
    ["time ./gradlew test", "explicit"],
    ["JAVA_HOME=/opt/jdk21 ./mvn-ci.sh -o test", "explicit"],
    // The built-in runners of §12 still count
    ["npx vitest run", "explicit"],
    ["cd engine && npm test", "explicit"],
  ])("%s → %s", (cmd, kind) => {
    expect(testCommandKind(cmd)).toBe(kind);
  });

  it.each([
    "mvn compile",
    "./mvn-ci.sh -q -o test-compile",
    "mvn -DskipTests install",
    "mvn -Dmaven.test.skip=true package",
    "mvn dependency:tree",
    "./gradlew assemble",
    "./gradlew testClasses",
    "./gradlew compileTestJava",
    "./gradlew build -x test",
    "./gradlew test -x test",
    "make build",
    "make TEST=1 all",
    "node scripts/build.mjs",
    "dotnet build",
    "bazel build //...",
    "grep -r 'mvn test' docs",
    "echo make test",
    "cat mvnw.sh",
  ])("not a test run: %s", (cmd) => {
    expect(testCommandKind(cmd)).toBeNull();
  });

  it("settings.testCommandPatterns: a glob per simple command (* any run, ? one char, whitespace collapsed)", () => {
    expect(testCommandKind("./mvn-ci.sh   -q -o verify-all", ["./mvn-ci.sh*verify*"])).toBe("explicit");
    expect(testCommandKind("cd x && ./run-tests.sh unit", ["./run-tests.sh *"])).toBe("explicit");
    expect(testCommandKind("./run-tests.sh", ["./run-tests.sh *"])).toBeNull();
    expect(testCommandKind("./t?.sh", ["./t?.sh"])).toBe("explicit");
    expect(testCommandKind("echo ./run-tests.sh unit", ["./run-tests.sh *"])).toBeNull();
    // Regex metacharacters in a pattern are literal.
    expect(testCommandKind("ci (unit)", ["ci (unit)"])).toBe("explicit");
    expect(testCommandKind("ci unit", ["ci (unit)"])).toBeNull();
    expect(testCommandKind("ls", ["", "  "])).toBeNull();
  });
});

describe("detectTestOutcome — Maven / Gradle markers (§34.9)", () => {
  const MVN_PASS = [
    "[INFO] -------------------------------------------------------",
    "[INFO]  T E S T S",
    "[INFO] Running com.example.settlement.SettlementServiceTest",
    "[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 1, Time elapsed: 0.84 s - in com.example.settlement.SettlementServiceTest",
    "[INFO] Results:",
    "[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 1",
    "[INFO] BUILD SUCCESS",
  ].join("\n");
  const MVN_FAIL = [
    "[INFO]  T E S T S",
    "[ERROR] Tests run: 12, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.9 s <<< FAILURE! - in com.example.SettlementServiceTest",
    "[ERROR] Failures:",
    "[ERROR]   SettlementServiceTest.closesDay:42 expected: <1> but was: <2>",
    "[ERROR] Tests run: 12, Failures: 1, Errors: 0, Skipped: 0",
    "[INFO] BUILD FAILURE",
    "[ERROR] There are test failures.",
  ].join("\n");
  const MVN_ERRORS = "[ERROR] Tests run: 3, Failures: 0, Errors: 2, Skipped: 0\n[INFO] BUILD FAILURE";
  const GRADLE_PASS = "> Task :app:test\n\nBUILD SUCCESSFUL in 14s\n7 actionable tasks: 2 executed, 5 up-to-date";
  const GRADLE_FAIL = "> Task :app:test FAILED\n\n12 tests completed, 2 failed\n\nFAILURE: Build failed with an exception.\n* What went wrong:\nExecution failed for task ':app:test'.\n> There were failing tests. See the report at: file:///x/build/reports/tests/test/index.html\n\nBUILD FAILED in 9s";

  it("Surefire / Maven", () => {
    expect(detectTestOutcome("./mvn-ci.sh -o test", false, MVN_PASS)).toBe("pass");
    expect(detectTestOutcome("./mvn-ci.sh -o test 2>&1 | tail -40", false, MVN_FAIL)).toBe("fail"); // the pipe hides the exit code
    expect(detectTestOutcome("mvn test", false, MVN_ERRORS)).toBe("fail");
    expect(detectTestOutcome("mvn test", false, "[ERROR] There are test failures.")).toBe("fail");
    expect(detectTestOutcome("mvn test", false, "[INFO] BUILD FAILURE")).toBe("fail");
    // `-q` prints nothing on success: a clean exit passes, a non-zero one fails.
    expect(detectTestOutcome("./mvn-ci.sh -q -o test", false, "")).toBe("pass");
    expect(detectTestOutcome("./mvn-ci.sh -q -o test", true, "Exit code 1")).toBe("fail");
  });

  it("Gradle", () => {
    expect(detectTestOutcome("./gradlew test", false, GRADLE_PASS)).toBe("pass");
    expect(detectTestOutcome("./gradlew test || true", false, GRADLE_FAIL)).toBe("fail");
    expect(detectTestOutcome("./gradlew test", false, "BUILD FAILED in 2s")).toBe("fail");
  });

  it("an implicit run (mvn install / gradle build) counts only when the output shows tests ran", () => {
    expect(detectTestOutcome("mvn clean install", false, MVN_PASS)).toBe("pass");
    expect(detectTestOutcome("mvn clean install", false, "[INFO] Tests are skipped.\n[INFO] BUILD SUCCESS")).toBeUndefined();
    expect(detectTestOutcome("mvn install", true, "[ERROR] COMPILATION ERROR :\n[INFO] BUILD FAILURE")).toBeUndefined();
    expect(detectTestOutcome("./gradlew build", false, GRADLE_PASS)).toBe("pass");
    expect(detectTestOutcome("./gradlew build", false, "BUILD SUCCESSFUL in 3s")).toBeUndefined();
    expect(detectTestOutcome("./gradlew build", true, GRADLE_FAIL)).toBe("fail");
  });

  it("the other runners and the user's patterns; a backgrounded call is never a verdict", () => {
    expect(detectTestOutcome("node --test", false, "# tests 4\n# pass 4\n# fail 0")).toBe("pass");
    expect(detectTestOutcome("node --test", true, "# tests 4\n# pass 3\n# fail 1")).toBe("fail");
    expect(detectTestOutcome("npx mocha", false, "  3 passing (12ms)\n  1 failing")).toBe("fail");
    expect(detectTestOutcome("ctest", false, "100% tests passed, 0 tests failed out of 8")).toBe("pass");
    expect(detectTestOutcome("./ci.sh unit", false, "ok", false, ["./ci.sh *"])).toBe("pass");
    expect(detectTestOutcome("./ci.sh unit", false, "ok")).toBeUndefined();
    expect(detectTestOutcome("./mvn-ci.sh -o test", false, MVN_PASS, true)).toBeUndefined();
    expect(detectTestOutcome("mvn compile", false, "[INFO] BUILD SUCCESS")).toBeUndefined();
  });
});
