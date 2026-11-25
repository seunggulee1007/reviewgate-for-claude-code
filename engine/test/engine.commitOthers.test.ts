// MARK: git-sync — §68.5 committing files outside the review along with the accepted ones.
import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { OtherChange } from "../src/protocol.js";
import { COMMIT_SUBJECT_MAX, suggestOthersMessage } from "../src/review/commitMessage.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-others"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "readme\n");
  write(dir, "other.txt", "other\n");
  write(dir, "old-name.txt", "rename me\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});
function setup(): { repo: string; h: Harness } {
  const repo = makeRepo();
  dirs.push(repo);
  const h = makeHarness();
  harnesses.push(h);
  return { repo, h };
}

async function fakeTurn(h: Harness, mutate: () => void): Promise<void> {
  await h.engine.handle({ type: "send", text: "do it" });
  mutate();
  h.session().emitTurnEnd();
  await h.waitFor((s) => s.gate.turnEndTree !== null && s.gate.phase !== "collecting", "turn collection");
  await h.waitFor((s) => s.branches.list.length > 0, "refresh after turn");
}

const headFiles = (repo: string): string[] => sh(repo, "show", "--name-status", "--format=", "HEAD").trim().split("\n").filter(Boolean).map((l) => l.replace(/\t/g, " "));

describe("§68.5 the suggested message of a commit of only other changes", () => {
  const change = (path: string, status: OtherChange["status"] = "M", oldPath: string | null = null) =>
    ({ path, oldPath, status, untracked: status === "?" });
  it("names one file by what happened to it, counts more, and never says 'accepted'", () => {
    expect(suggestOthersMessage([change("docs/README.md")])).toBe("Update README.md");
    expect(suggestOthersMessage([change("src/money.ts", "R", "src/format.ts")])).toBe("Rename format.ts to money.ts");
    expect(suggestOthersMessage([change("src/old.ts", "D")])).toBe("Delete old.ts");
    expect(suggestOthersMessage([change("notes.md", "?")])).toBe("Add notes.md");
    // The tracked files lead (untracked ones are listed only on request); untracked alone are counted too.
    expect(suggestOthersMessage([change("README.md"), change("notes.md", "?"), change("seed.ts", "?")])).toBe("Update README.md");
    expect(suggestOthersMessage([change("a.md", "?"), change("b.md", "?")])).toBe("Update 2 files");
    expect(suggestOthersMessage([change("a.ts"), change("b.ts"), change("c.ts", "A")])).toBe("Update 3 files");
    expect(suggestOthersMessage([])).toBe("Update files");
    expect(suggestOthersMessage([change(`${"x".repeat(90)}.ts`)]).length).toBeLessThanOrEqual(COMMIT_SUBJECT_MAX);
  });
});

describe("§68.5 commit_others / commit.extraPaths", () => {
  it("lists the changes outside the review; commits the ticked ones with the accepted files; the pending file keeps its review", async () => {
    const { repo, h } = setup();
    await h.hello({ ignorePatterns: [".omc/"] });
    await h.open(repo);
    // The user's own work before the turn: a tracked edit, a rename, an untracked note, a tool folder the app ignores.
    write(repo, "other.txt", "other — my edit\n");
    sh(repo, "mv", "old-name.txt", "new-name.txt");
    write(repo, "notes.md", "my notes\n");
    write(repo, ".omc/state.json", "{}\n");
    await fakeTurn(h, () => {
      write(repo, "a.txt", "a\n");
      write(repo, "b.txt", "b\n");
    });
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    await h.waitFor((x) => x.commit.otherChanges?.tracked === 2, "branches refreshed after the turn");
    expect(h.engine.state.commit.otherChanges).toEqual({ tracked: 2, untracked: 2 });

    const others = await h.engine.request({ type: "commit_others" });
    expect(others).toMatchObject({ type: "commit_others", truncated: false, suggestedMessage: "Update 2 files" });
    // The message follows the ticked files; unlisted or no paths: every file.
    expect((await h.engine.request({ type: "commit_others", paths: ["other.txt"] })).suggestedMessage).toBe("Update other.txt");
    expect((await h.engine.request({ type: "commit_others", paths: ["new-name.txt"] })).suggestedMessage).toBe("Rename old-name.txt to new-name.txt");
    expect((await h.engine.request({ type: "commit_others", paths: ["nope.txt"] })).suggestedMessage).toBe("Update 2 files");
    expect(others.files).toEqual([
      { path: ".omc/state.json", oldPath: null, status: "?", untracked: true, hidden: true },
      { path: "new-name.txt", oldPath: "old-name.txt", status: "R", untracked: false },
      { path: "notes.md", oldPath: null, status: "?", untracked: true },
      { path: "other.txt", oldPath: null, status: "M", untracked: false },
    ]);

    // A review file is never an extra (accept it instead), nor is an unchanged path.
    await h.engine.request({ type: "accept", paths: ["a.txt"] });
    await expect(h.engine.request({ type: "commit", message: "x", extraPaths: ["b.txt"] })).rejects.toThrow("invalid_extra:b.txt");
    await expect(h.engine.request({ type: "commit", message: "x", extraPaths: ["README.md"] })).rejects.toThrow("invalid_extra:README.md");
    expect(sh(repo, "log", "--oneline").trim().split("\n")).toHaveLength(1);

    const reply = await h.engine.request({ type: "commit", message: "a and my edits", extraPaths: ["other.txt", "new-name.txt"] });
    expect(reply.type).toBe("committed");
    expect(headFiles(repo).sort()).toEqual(["A a.txt", "M other.txt", "R100 old-name.txt new-name.txt"]);
    const s = h.engine.state;
    expect(s.commit.lastCommit!.files).toEqual(["a.txt", "other.txt", "new-name.txt"]);
    // Nothing became accepted that was not: b.txt is still pending, unstaged; the note stays untracked.
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["b.txt", "pending"]]);
    expect(sh(repo, "status", "--porcelain").trimEnd().split("\n").sort()).toEqual(["?? .omc/", "?? b.txt", "?? notes.md"]);
    expect(s.gate.lastReviewSummary).toBe("[Review gate] Accepted: a.txt."); // Claude hears only of the review's files
    expect(s.commit.otherChanges).toEqual({ tracked: 0, untracked: 2 });

    // The committed extras never come up in the review afterwards: not after a refresh, not after the next turn.
    await h.engine.request({ type: "refresh", scope: ["review"] });
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual(["b.txt"]);
    const diff = await h.engine.request({ type: "select_file", path: "b.txt" });
    expect(diff.diff.hunks.flatMap((hk) => hk.lines).filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["b"]);
  });

  it("a file the user edited after the turn (not refreshed into the review) commits along and stays out of the review", async () => {
    const { repo, h } = setup();
    await h.hello();
    await h.open(repo);
    await fakeTurn(h, () => write(repo, "a.txt", "a\n"));
    write(repo, "other.txt", "edited after the turn\n");
    expect((await h.engine.request({ type: "commit_others" })).files.map((f) => f.path)).toEqual(["other.txt"]);
    await h.engine.request({ type: "accept", paths: ["a.txt"] });
    await h.engine.request({ type: "commit", message: "both", extraPaths: ["other.txt"] });
    expect(headFiles(repo).sort()).toEqual(["A a.txt", "M other.txt"]);
    expect(h.engine.state.changedFiles).toEqual([]);
    await h.engine.request({ type: "refresh", scope: ["review"] });
    expect(h.engine.state.changedFiles).toEqual([]);
  });

  it("extras alone: with a pending review file, and with no review at all", async () => {
    const { repo, h } = setup();
    await h.hello();
    await h.open(repo);
    // No review: a commit of the user's own file only.
    write(repo, "other.txt", "mine\n");
    expect(h.engine.state.gate.phase).toBe("idle");
    await h.engine.request({ type: "branches" });
    expect(h.engine.state.commit).toMatchObject({ canCommit: false, otherChanges: { tracked: 1, untracked: 0 } });
    await expect(h.engine.request({ type: "commit", message: "nothing" })).rejects.toThrow("nothing_to_commit");
    await h.engine.request({ type: "commit", message: "mine", extraPaths: ["other.txt"] });
    expect(headFiles(repo)).toEqual(["M other.txt"]);
    expect(h.engine.state.gate.phase).toBe("idle");

    // A pending review file stays pending and unstaged when only an extra is committed.
    write(repo, "README.md", "readme — mine\n");
    await fakeTurn(h, () => write(repo, "a.txt", "a\n"));
    await h.engine.request({ type: "commit", message: "readme", extraPaths: ["README.md"] });
    expect(headFiles(repo)).toEqual(["M README.md"]);
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["a.txt", "pending"]]);
    expect(sh(repo, "status", "--porcelain").trimEnd()).toBe("?? a.txt");
    await h.engine.request({ type: "refresh", scope: ["review"] });
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual(["a.txt"]);
  });
});
