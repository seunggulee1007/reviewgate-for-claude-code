import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_REMOTE_BRANCHES, remoteBranches } from "../src/git/branches.js";
import { openCheckpoint } from "../src/git/checkpoint.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §36.12: `state.branches.remotes` — refs/remotes without `<remote>/HEAD`, newest first, at most 300. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("remoteBranches", () => {
  it("lists remote-tracking branches newest first, never <remote>/HEAD, at most 300", async () => {
    const dir = realpathSync(makeTempDir("rg-remotes"));
    dirs.push(dir);
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.email", "t@example.com");
    sh(dir, "config", "user.name", "T");
    write(dir, "a.txt", "a\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "old", "--date", "2020-01-01T00:00:00Z");
    const old = sh(dir, "rev-parse", "HEAD").trim();
    write(dir, "a.txt", "b\n");
    execFileSync("git", ["-C", dir, "commit", "-qam", "new"], { env: { ...process.env, GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z" } });
    const fresh = sh(dir, "rev-parse", "HEAD").trim();
    const lines = Array.from({ length: MAX_REMOTE_BRANCHES + 20 }, (_, i) => `create refs/remotes/origin/b-${String(i).padStart(3, "0")} ${old}`);
    lines.push(`create refs/remotes/upstream/develop ${fresh}`);
    execFileSync("git", ["-C", dir, "update-ref", "--stdin"], { input: lines.join("\n") + "\n" });
    sh(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/b-000");
    const cp = await openCheckpoint(dir);
    const list = await remoteBranches(cp);
    expect(list).toHaveLength(MAX_REMOTE_BRANCHES);
    expect(list[0]).toMatchObject({ name: "upstream/develop", remote: true, isCurrent: false, upstream: null, ahead: 0, behind: 0 });
    expect(list.every((b) => b.remote === true && !b.name.endsWith("/HEAD") && b.name !== "origin")).toBe(true);
  });
});
