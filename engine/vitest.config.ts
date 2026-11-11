import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    // Only a hung test waits this long — a passing one ends when it is done — so it is generous. The git-heavy tests take
    // 8–13 s on an idle 12-core Mac, timed out at 20 s on windows-latest and here under load; Windows starts git and node
    // several times slower still. test/helpers/wait.ts keeps the poll deadline under it.
    testTimeout: process.platform === "win32" ? 120_000 : 60_000,
    // afterEach (engine.dispose + removeDir, which retries for seconds on Windows) is bound by these, not by testTimeout;
    // the 10 s default failed a random test on a slow runner.
    hookTimeout: process.platform === "win32" ? 120_000 : 60_000,
    teardownTimeout: process.platform === "win32" ? 120_000 : 60_000,
    include: ["test/**/*.test.ts"],
  },
});
