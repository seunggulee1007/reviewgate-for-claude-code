import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesIgnore } from "../src/git/ignore.js";
import { BudgetState, budgetIsOn, countLines, estimateEditLines } from "../src/session/budget.js";
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

test("Edit / MultiEdit count the lines that change, not the context the strings carry (§54: it was ~5× git's numstat)", () => {
  withTmp((dir) => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    writeFileSync(join(dir, "f.txt"), lines.join("\n") + "\n");
    // Five lines of context around one changed line: 1 removed + 1 added, as git counts it (the old estimate: 10).
    const old5 = lines.slice(3, 8).join("\n");
    const new5 = [...lines.slice(3, 5), "line 5 changed", ...lines.slice(6, 8)].join("\n");
    assert.equal(estimateEditLines("Edit", { file_path: "f.txt", old_string: old5, new_string: new5 }, dir), 2);
    // An added line inside the context: 1.
    const grown = [...lines.slice(3, 5), "inserted", ...lines.slice(5, 8)].join("\n");
    assert.equal(estimateEditLines("Edit", { file_path: "f.txt", old_string: old5, new_string: grown }, dir), 1);
    // MultiEdit: the edits applied in order to the file, then one diff.
    const multi = {
      file_path: "f.txt",
      edits: [
        { old_string: "line 1\nline 2\nline 3", new_string: "line 1\nline TWO\nline 3" },
        { old_string: "line 10\nline 11", new_string: "line 10\nline 11\nline 11b" },
      ],
    };
    assert.equal(estimateEditLines("MultiEdit", multi, dir), 3);
    // An old_string the file does not have: the strings' own diff — the shared context still counts nothing.
    assert.equal(estimateEditLines("Edit", { file_path: "f.txt", old_string: "a\nb\nc", new_string: "a\nB\nc" }, dir), 2);
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
  b.warned = true;
  b.files.add("/x");
  b.reset();
  assert.deepEqual(b.snapshot(), { files: 0, lines: 0, denied: false });
  assert.equal(b.warned, false);
});

test("§54: a budget without limits (0, the default) is off; 0 on one count is no limit on that count", () => {
  assert.equal(budgetIsOn({ maxFiles: 0, maxLines: 0 }), false);
  assert.equal(budgetIsOn({ maxFiles: -1, maxLines: Number.NaN }), false);
  assert.equal(budgetIsOn({ maxFiles: 10, maxLines: 0 }), true);
  const off = new BudgetState({ maxFiles: 0, maxLines: 0, hardMultiplier: 2 });
  assert.equal(off.active, false);
  assert.equal(off.wouldExceedHard(1000, 1_000_000), false);
  off.lines = 1_000_000;
  assert.equal(off.exceedsSoft(), false);
  const linesOnly = new BudgetState({ maxFiles: 0, maxLines: 10, hardMultiplier: 2 });
  assert.equal(linesOnly.active, true);
  assert.equal(linesOnly.wouldExceedHard(500, 20), false);
  assert.equal(linesOnly.wouldExceedHard(500, 21), true);
  linesOnly.files.add("/a");
  assert.equal(linesOnly.exceedsSoft(), false);
  linesOnly.lines = 10;
  assert.equal(linesOnly.exceedsSoft(), true);
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
    "git -C /tmp/repo checkout -- a.txt",
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
    // git and gh by their name (§20 programName): any case, .exe, a full path in either spelling
    "git.exe merge main",
    "GIT checkout -- a.txt",
    "Git.EXE -C sub stash",
    "/mingw64/bin/git.exe pull",
    "\"C:\\Program Files\\Git\\cmd\\git.exe\" rebase main",
    "'/c/Program Files/Git/cmd/git.exe' -c core.a=1 reset --hard",
    "gh.exe pr checkout 42",
    "GH pr merge 7",
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
    // MARK: r1-git — a commit changes no file: what the same line edited is Claude's
    "git commit -m x",
    "sed -i '' s/a/b/ App.java && git add App.java && git commit -m fix",
    // by its name: a read is still a read; another program is not git; git's verbs keep their case
    "git.exe status",
    "GIT.EXE stash list",
    "git.exe commit -m x",
    "gitk --all",
    "git.exe.bak merge main",
    "git MERGE main",
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
