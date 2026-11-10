import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    // Windows runners start git and node processes several times slower; the git-heavy tests (400-file pathspecs,
    // worktrees) passed there in one run and timed out at 20 s in the next.
    testTimeout: process.platform === "win32" ? 60000 : 20000,
    include: ["test/**/*.test.ts"],
  },
});
