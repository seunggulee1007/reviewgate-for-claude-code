import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesIgnore } from "../src/git/ignore.js";
import { BudgetState, countLines, estimateEditLines } from "../src/session/budget.js";
import { GIT_MUTATING_RE, READ_ONLY_TOOLS, needsAsk } from "../src/session/hooks.js";

const assert = {
  equal: (a: unknown, b: unknown, msg?: string) => expect(a, msg).toBe(b),
  deepEqual: (a: unknown, b: unknown) => expect(a).toEqual(b),
};

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rg-budget-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("countLines", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb\nc"), 3);
  assert.equal(countLines("a\nb\nc\n"), 3);
});

test("Edit: lines(old)+lines(new)", () => {
  withTmp((dir) => {
    const est = estimateEditLines(
      "Edit",
      { file_path: "x.txt", old_string: "a\nb", new_string: "c\nd\ne" },
      dir,
    );
    assert.equal(est, 5);
  });
});

test("Edit replace_all multiplies by occurrence count from the file", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "x.txt"), "foo\nbar\nfoo\nbaz\nfoo\n");
    const est = estimateEditLines(
      "Edit",
      { file_path: join(dir, "x.txt"), old_string: "foo", new_string: "qux", replace_all: true },
      dir,
    );
    assert.equal(est, 2 * 3);
  });
});

test("Edit replace_all with missing file falls back to single occurrence", () => {
  withTmp((dir) => {
    const est = estimateEditLines(
      "Edit",
      { file_path: "missing.txt", old_string: "foo", new_string: "qux", replace_all: true },
      dir,
    );
    assert.equal(est, 2);
  });
});

test("Write: new file counts content lines", () => {
  withTmp((dir) => {
    const est = estimateEditLines("Write", { file_path: "new.txt", content: "1\n2\n3\n" }, dir);
    assert.equal(est, 3);
  });
});

test("Write: existing file counts added+removed via diffLines", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "e.txt"), "a\nb\nc\n");
    // b → B (1 removed, 1 added), d appended (1 added) => 3
    const est = estimateEditLines("Write", { file_path: "e.txt", content: "a\nB\nc\nd\n" }, dir);
    assert.equal(est, 3);
  });
});

test("Write: unchanged content is 0", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "e.txt"), "a\nb\n");
    assert.equal(estimateEditLines("Write", { file_path: "e.txt", content: "a\nb\n" }, dir), 0);
  });
});

test("MultiEdit sums edits", () => {
  withTmp((dir) => {
    const est = estimateEditLines(
      "MultiEdit",
      {
        file_path: "m.txt",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c\nd", new_string: "" },
        ],
      },
      dir,
    );
    assert.equal(est, 2 + 2);
  });
});

test("NotebookEdit counts new_source lines", () => {
  assert.equal(estimateEditLines("NotebookEdit", { notebook_path: "n.ipynb", new_source: "x\ny" }, "/"), 2);
});

test("unknown tool estimates 0", () => {
  assert.equal(estimateEditLines("Read", { file_path: "a" }, "/"), 0);
});

test("BudgetState hard/soft thresholds and reset", () => {
  const b = new BudgetState({ maxFiles: 2, maxLines: 10 });
  assert.equal(b.hardMultiplier, 1.5);
  assert.equal(b.wouldExceedHard(3, 0), false); // 3 <= 2*1.5
  assert.equal(b.wouldExceedHard(4, 0), true);
  assert.equal(b.wouldExceedHard(0, 15), false);
  assert.equal(b.wouldExceedHard(0, 16), true);
  assert.equal(b.exceedsSoft(), false);
  b.lines = 10;
  assert.equal(b.exceedsSoft(), true);
  b.setBudget({ maxFiles: 2, maxLines: 10, hardMultiplier: 2 });
  assert.equal(b.wouldExceedHard(0, 20), false);
  assert.equal(b.wouldExceedHard(0, 21), true);
  b.denied = true;
  b.callsAfterDeny = 3;
  b.files.add("/x");
  b.reset();
  assert.deepEqual(b.snapshot(), { files: 0, lines: 0, denied: false });
  assert.equal(b.callsAfterDeny, 0);
});

test("matchesIgnore: prefix, leading slash, globs (same cases as CheckpointIgnoreTests)", () => {
  const p = [".omc/", ".claude/"];
  assert.equal(matchesIgnore(".omc/state/x.json", p), true);
  assert.equal(matchesIgnore(".claude/settings.local.json", p), true);
  assert.equal(matchesIgnore("src/omc/x.swift", p), false);
  assert.equal(matchesIgnore("README.md", p), false);
  assert.equal(matchesIgnore("hello.txt", []), false);
  assert.equal(matchesIgnore(".omc/a", ["/.omc/"]), true);
  assert.equal(matchesIgnore("anything", ["", "/"]), false);
  assert.equal(matchesIgnore("build/out/app.log", ["*.log"]), true);
  assert.equal(matchesIgnore("app.log", ["*.log"]), true);
  assert.equal(matchesIgnore("app.log.txt", ["*.log"]), false);
  assert.equal(matchesIgnore("docs/generated/x.md", ["docs/*/x.md"]), true);
  assert.equal(matchesIgnore("a/b/c/tmp.swp", ["**/*.swp"]), true);
  assert.equal(matchesIgnore("src/main.swift", ["*.log", "dist/"]), false);
  assert.equal(matchesIgnore("a+b.log", ["a+b.*"]), true);
});

test("GIT_MUTATING_RE catches option groups between git and the verb", () => {
  for (const cmd of [
    "git commit -m x",
    "git -C /tmp/repo commit -m x",
    "git -c user.name=me reset --hard",
    "git --no-pager -C sub checkout main",
    "cd x && git -C . --git-dir=.git stash",
    "git -c core.a=1 -c core.b=2 merge main",
    "git merge --abort",
    "git pull --rebase origin develop",
    "git cherry-pick abc123",
    "git revert HEAD",
    "git stash",
    "git stash pop",
    "git stash push -m wip",
  ]) {
    assert.equal(GIT_MUTATING_RE.test(cmd), true, cmd);
  }
  for (const cmd of [
    "git status",
    "git -C x log --oneline",
    "git diff --stat",
    "echo commit",
    // read-only verbs that only start like a mutating one
    "git merge-tree --write-tree main develop",
    "git merge-base HEAD develop",
    "git --no-pager merge-base --is-ancestor a b",
    "git cherry -v develop",
    "git stash list",
    "git stash show -p stash@{0}",
  ]) {
    assert.equal(GIT_MUTATING_RE.test(cmd), false, cmd);
  }
});

test("needsAsk: edit tools and read-only tools never ask", () => {
  const none = new Set<string>();
  for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.equal(needsAsk(t, none), false, t);
  for (const t of READ_ONLY_TOOLS) assert.equal(needsAsk(t, none), false, t);
});

test("needsAsk: everything else asks unless auto-allowed", () => {
  const none = new Set<string>();
  assert.equal(needsAsk("Skill", none), false, "Skill only loads instructions; the tools it uses are gated individually");
  for (const t of ["Bash", "WebFetch", "WebSearch", "Agent", "Task", "mcp__github__list_issues", "Unknown"]) {
    assert.equal(needsAsk(t, none), true, t);
  }
  const auto = new Set(["Bash"]);
  assert.equal(needsAsk("Bash", auto), false);
  assert.equal(needsAsk("WebFetch", auto), true);
  // prefix/suffix look-alikes are not edit tools
  assert.equal(needsAsk("EditFoo", none), true);
  assert.equal(needsAsk("ReadAll", none), true);
});
