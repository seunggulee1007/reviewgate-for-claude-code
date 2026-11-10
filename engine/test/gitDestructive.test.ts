import { mkdirSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  destructiveGitReason,
  entriesSince,
  gitInvocations,
  gitProbe,
  isOwnCommitSubject,
  movesHead,
  parseCommands,
  shellCommands,
  stashesWork,
  type GitProbe,
} from "../src/session/gitDestructive.js";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import { rememberKey } from "../src/session/bashClass.js";
import { ASK_REASON, buildHooks, GIT_ASK_REASON, REMEMBERED_REASON, type HookContext } from "../src/session/hooks.js";
import { bashPath, makeRepo, removeDir, sh, write } from "./helpers/repo.js";

/**
 * MARK: r1-git — docs/PROTOCOL.md §46: only a git command that throws away uncommitted work or rewrites the remote keeps the
 * card; everything else runs as in the terminal.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

/** A probe that must not be asked: the decision of these commands never depends on the repository. */
const noProbe: GitProbe = {
  isRef: async () => {
    throw new Error("isRef asked");
  },
  isDirty: async () => {
    throw new Error("isDirty asked");
  },
};

const ROOT = "/work/acme";
const at = (command: string, reviewPaths: string[] = [], probe: GitProbe = noProbe, cwd = ROOT) =>
  destructiveGitReason(command, { cwd, root: ROOT, reviewPaths: new Set(reviewPaths), probe });

describe("destructiveGitReason: what never asks", () => {
  it.each([
    "git commit -am x",
    "git add -A && git commit -m 'feat: acme'",
    "git checkout -b feature/acme-7",
    "git checkout -b feature/acme-7 origin/main",
    "git switch -c feature/acme-7",
    "git checkout main",
    "git checkout -",
    "git pull",
    "git pull --rebase origin main",
    "git stash",
    "git stash push -m wip",
    "git stash pop",
    "git push",
    "git push -u origin feature/acme-7",
    "git push origin HEAD:refs/heads/acme",
    "git config user.email dev@acme.example",
    "git rebase main",
    "git merge --no-edit develop",
    "git reset HEAD~1",
    "git reset --soft HEAD~1",
    "git branch -d done",
    "git branch feature/x",
    "git clean -n",
    "git clean -nd",
    "git clean --dry-run -d",
    "git worktree remove ../wt2",
    "git restore --staged a.txt",
    "git restore -S a.txt",
    "grep -rn \"git checkout\" docs/",
    "echo \"git reset --hard\" >> NOTES",
    "echo 'git push --force' | tee -a NOTES.md",
    "rg 'git clean -fd' src",
    "npm test && mvn -q verify",
    // another program whose name only starts or ends like git's
    "gitk --all",
    "legit reset --hard",
    "git-lfs.exe push --force",
    "echo GIT.EXE reset --hard",
  ])("%s → null", async (command) => {
    expect(await at(command)).toBeNull();
  });

  it("a commit message in a here-document is text, whatever it says", async () => {
    const command = [
      "git add -A && git commit -m \"$(cat <<'EOF'",
      "Fix the parser (\"quoted\")",
      "",
      "Do not run git push --force or git reset --hard here.",
      "EOF",
      ")\"",
    ].join("\n");
    expect(await at(command)).toBeNull();
    expect(await at("cat > deploy.sh <<'EOF'\ngit reset --hard origin/main\ngit clean -fdx\nEOF\nchmod +x deploy.sh")).toBeNull();
    expect(await at("cat <<-EOF > notes.txt\n\tgit stash drop\n\tEOF\n")).toBeNull();
  });
});

describe("destructiveGitReason: what always asks", () => {
  it.each([
    "git reset --hard",
    "git reset --hard origin/main",
    "git reset --merge",
    "git reset --har HEAD",
    "git clean -fd",
    "git clean -fdx",
    "git clean -d",
    "git clean --force",
    "git branch -D x",
    "git branch -df x",
    "git branch --delete --force x",
    "git branch -M old new",
    "git branch -C old new",
    "git branch -f main origin/main",
    "git stash drop",
    "git stash drop stash@{1}",
    "git stash clear",
    "git push --force",
    "git push -f",
    "git push -uf origin f",
    "git push --force-with-lease",
    "git push --force-with-lease=main:abc123 origin main",
    "git push --force-if-includes",
    "git push --mirror",
    "git push --delete origin x",
    "git push origin --delete x",
    "git push -d origin x",
    "git push --prune origin",
    "git push origin :x",
    "git push origin +main",
    "git push origin +HEAD:main",
    "git worktree remove --force w",
    "git worktree remove -f w",
    "git checkout -f main",
    "git checkout --force main",
    "git switch --discard-changes main",
    "git switch -f main",
    "git -C ../wt reset --hard",
    "git -c core.pager=cat --no-pager reset --hard",
    "/usr/bin/git reset --hard",
    "\"git\" reset --hard",
    // git by its name (§20 programName): Git Bash's git.exe, any case, a full path in either spelling
    "git.exe reset --hard",
    "GIT reset --hard",
    "Git.EXE push --force",
    "/mingw64/bin/git.exe clean -fd",
    "\"/c/Program Files/Git/cmd/git.exe\" reset --hard",
    "\"C:\\Program Files\\Git\\cmd\\git.exe\" stash clear",
    "'C:\\Program Files\\Git\\cmd\\GIT.EXE' -C ../wt branch -D x",
  ])("%s → git_command", async (command) => {
    expect(await at(command)).toMatchObject({ code: "git_command" });
  });

  it("wherever the command hides: chains, pipes, redirections, subshells, wrappers, scripts and substitutions", async () => {
    for (const command of [
      "npm test && git reset --hard",
      "git status; git stash clear",
      "git reset --hard 2>&1 | tail -5",
      "git reset --hard > /dev/null 2>&1",
      "(cd ../wt && git stash drop)",
      "{ git clean -fd; }",
      "if git diff --quiet; then git reset --hard; fi",
      "for b in a b; do git branch -D $b; done",
      "git branch --merged | grep -v main | xargs -n1 git branch -D",
      "time -p git clean -fd",
      "sudo -u dev git push -f",
      "env GIT_TRACE=1 git push --force",
      "nohup git push --force &",
      "bash -c 'git reset --hard'",
      "sh -ec \"git push origin +main\"",
      "eval git stash clear",
      "echo $(git stash drop)",
      "echo \"$(git stash drop)\"",
      "echo `git reset --hard`",
      // the shells and wrappers by their name too (Git Bash's bash.exe, env.exe, xargs.exe, find.exe)
      "bash.exe -c 'git.exe reset --hard'",
      "BASH -c 'git reset --hard'",
      "env.exe GIT_TRACE=1 git.exe push --force",
      "git.exe branch --merged | xargs.exe -n1 git.exe branch -D",
      "find.exe . -name '*.orig' -exec git.exe clean -f {} +",
    ]) {
      expect(await at(command), command).toMatchObject({ code: "git_command" });
    }
  });

  it("what git runs itself, and a script a shell reads on stdin", async () => {
    for (const command of [
      // git runs these: in every submodule (nested repositories the review never sees), after each rebase step, at each bisect step
      "git submodule foreach --recursive 'git reset --hard'",
      "git submodule foreach 'git clean -fdx'",
      "git submodule --quiet foreach git stash clear",
      "git submodule foreach 'git checkout -- .'",
      "git rebase --exec 'git reset --hard HEAD~1' main",
      "git rebase -x 'git clean -fd' main",
      "git rebase --exec='git push --force' main",
      "git bisect run sh -c 'git reset --hard'",
      // a shell's script on stdin: a here-document, a here-string, a pipe, a file it cannot be read from
      "bash <<'EOF'\ngit reset --hard origin/main\nEOF",
      "sudo -u dev sh -s <<-EOF\n\tgit stash drop\n\tEOF",
      "bash <<< 'git clean -fd'",
      "echo 'git reset --hard' | sh",
      "printf 'git status\\ngit reset --hard\\n' | bash",
      "cat <<'EOF' | bash\ngit push --force\nEOF",
      "bash -c \"$(cat <<'EOF'\ngit reset --hard\nEOF\n)\"",
    ]) {
      expect(await at(command), command).toMatchObject({ code: "git_command" });
    }
    for (const command of [
      "git submodule foreach git pull",
      "git submodule foreach 'git status --short'",
      "git rebase --exec 'npm test' main",
      "git bisect run npm test",
      "bash <<'EOF'\nnpm test\ngit status\nEOF",
      "curl -fsSL https://tasks.example.com/install.sh | bash",
      "bash scripts/build.sh",
      "cat <<'EOF' > deploy.sh\ngit reset --hard origin/main\nEOF",
    ]) {
      expect(await at(command), command).toBeNull();
    }
  });
});

describe("destructiveGitReason: checkout / restore over files", () => {
  function repo(): string {
    const d = realpathSync(makeRepo());
    dirs.push(d);
    // a.txt: under review; b.txt: clean; c.txt: changed, not reviewed; src/A.java: under review
    write(d, "a.txt", "a\n");
    write(d, "b.txt", "b\n");
    write(d, "c.txt", "c\n");
    write(d, "src/A.java", "class A {}\n");
    sh(d, "add", "-A");
    sh(d, "commit", "-qm", "files");
    write(d, "a.txt", "a changed by claude\n");
    write(d, "c.txt", "c changed by the user\n");
    write(d, "src/A.java", "class A { int x; }\n");
    return d;
  }
  const review = ["a.txt", "src/A.java"];
  const run = (root: string, command: string, cwd = root, reviewPaths = review) =>
    destructiveGitReason(command, { cwd, root, reviewPaths: new Set(reviewPaths) });

  it("a target that holds a file under review or uncommitted work asks; a clean one does not", async () => {
    const root = repo();
    expect(await run(root, "git checkout -- a.txt")).toMatchObject({ code: "git_command" });
    expect(await run(root, "git checkout -- b.txt")).toBeNull();
    expect(await run(root, "git checkout -- c.txt")).toMatchObject({ code: "git_command" }); // dirty, not reviewed
    expect(await run(root, "git checkout HEAD -- b.txt")).toBeNull();
    expect(await run(root, "git checkout HEAD~0 a.txt")).toMatchObject({ code: "git_command" });
    expect(await run(root, "git checkout b.txt")).toBeNull();
    expect(await run(root, "git checkout a.txt")).toMatchObject({ code: "git_command" });
    expect(await run(root, "git checkout .")).toMatchObject({ code: "git_command" });
    expect(await run(root, "git checkout -- src")).toMatchObject({ code: "git_command" });
    expect(await run(root, "git checkout -- '*.java'")).toMatchObject({ code: "git_command" });
    expect(await run(root, "git checkout --ours a.txt")).toMatchObject({ code: "git_command" });
    expect(await run(root, "git checkout --theirs -- b.txt")).toBeNull();
    // git by its name: the same decisions
    expect(await run(root, "git.exe checkout -- c.txt")).toMatchObject({ code: "git_command" });
    expect(await run(root, "GIT.EXE restore a.txt")).toMatchObject({ code: "git_command" });
    expect(await run(root, "\"C:\\Program Files\\Git\\cmd\\git.exe\" checkout -- b.txt")).toBeNull();
  });

  it("an absolute path, as the shell spells it (§20: /c/… in Git Bash), names the same file — for the review and for git", async () => {
    const root = repo();
    const abs = (rel: string) => bashPath(join(root, rel));
    expect(await run(root, `git checkout -- ${abs("a.txt")}`)).toMatchObject({ code: "git_command" }); // under review
    expect(await run(root, `git checkout -- ${abs("b.txt")}`, root, ["b.txt"])).toMatchObject({ code: "git_command" }); // under review, clean
    expect(await run(root, `git checkout -- ${abs("b.txt")}`)).toBeNull(); // clean: git reads the file the shell names
    expect(await run(root, `git checkout -- ${abs("c.txt")}`, root, [])).toMatchObject({ code: "git_command" }); // uncommitted
    expect(await run(root, `git -C ${abs("src")} restore ${abs("b.txt")}`)).toBeNull();
    expect(await run(root, `git -C ${abs("src")} restore ${abs("a.txt")}`)).toMatchObject({ code: "git_command" });
  });

  it("~ and $HOME are put in as the shell does — for the review and for git", async () => {
    const root = repo();
    const name = basename(root);
    const me = userInfo().username;
    // The home folder is the repository's parent (os.homedir() reads HOME, on Windows USERPROFILE).
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = dirname(root);
    try {
      // Before, git was handed `~/…` as written — a path relative to the shell's folder that names nothing — so an
      // uncommitted file there was thrown away without a card.
      expect(await run(root, `git checkout -- ~/${name}/c.txt`, root, [])).toMatchObject({ code: "git_command" });
      expect(await run(root, `git restore ~/${name}/c.txt`, root, [])).toMatchObject({ code: "git_command" });
      expect(await run(root, `git checkout ~/${name}/c.txt`, root, [])).toMatchObject({ code: "git_command" });
      expect(await run(root, `git checkout HEAD ~/${name}/c.txt`, root, [])).toMatchObject({ code: "git_command" });
      expect(await run(root, `git checkout -- ~/${name}/a.txt`)).toMatchObject({ code: "git_command" }); // under review
      expect(await run(root, `git checkout -- ~/${name}/b.txt`)).toBeNull(); // clean
      for (const home of ["$HOME", "${HOME}", `~${me}`]) {
        expect(await run(root, `git restore ${home}/${name}/c.txt`, root, []), home).toMatchObject({ code: "git_command" });
        // Before, `$HOME/…` stood for the whole tree (a variable): a clean file asked because another one was changed.
        expect(await run(root, `git checkout -- ${home}/${name}/b.txt`), home).toBeNull();
        expect(await run(root, `git -C ${home}/${name} checkout -- b.txt`, dirname(root)), home).toBeNull();
        expect(await run(root, `cd ${home}/${name}/src && git checkout -- A.java`, dirname(root)), home).toMatchObject({ code: "git_command" });
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("restore: the working tree is what counts — --staged alone never touches it", async () => {
    const root = repo();
    expect(await run(root, "git restore --staged a.txt")).toBeNull();
    expect(await run(root, "git restore a.txt")).toMatchObject({ code: "git_command" });
    expect(await run(root, "git restore c.txt", root, [])).toMatchObject({ code: "git_command" }); // dirty
    expect(await run(root, "git restore b.txt")).toBeNull();
    expect(await run(root, "git restore -SW b.txt")).toBeNull();
    expect(await run(root, "git restore --staged --worktree a.txt")).toMatchObject({ code: "git_command" });
    expect(await run(root, "git restore --source=HEAD~0 -- .")).toMatchObject({ code: "git_command" });
    expect(await run(root, "git restore")).toBeNull(); // git refuses: no paths
  });

  it("paths are where the command runs: a cd / git -C moves them", async () => {
    const root = repo();
    mkdirSync(join(root, "docs"), { recursive: true });
    expect(await run(root, "git checkout -- A.java", join(root, "src"))).toMatchObject({ code: "git_command" });
    expect(await run(root, "cd src && git checkout -- A.java")).toMatchObject({ code: "git_command" });
    expect(await run(root, "git -C src checkout -- ../b.txt")).toBeNull();
    expect(await run(root, "cd docs && git checkout -- ../a.txt")).toMatchObject({ code: "git_command" });
  });

  it("a branch that is also a folder name is a branch", async () => {
    const root = repo();
    sh(root, "branch", "src");
    expect(await run(root, "git checkout src")).toBeNull();
  });

  it("paths only the run knows — a substitution, a variable, another user's ~, a brace expansion, xargs, find -exec — stand for the whole tree", async () => {
    const root = repo();
    const fromRun = [
      "git checkout -- $(git diff --name-only)",
      "git diff --name-only | xargs git checkout --",
      "git restore $(git ls-files -m)",
      'for f in $(git diff --name-only); do git checkout -- "$f"; done',
      "git ls-files -m | xargs -I{} git checkout -- {}",
      "git diff --name-only | xargs git restore",
      "git diff --name-only | parallel git checkout --",
      "git checkout $(git diff --name-only)",
      "git checkout `git diff --name-only`",
      'git checkout "$f"',
      "git restore ${FILES}",
      "git checkout -- {a,c}.txt",
      "find . -name '*.java' -exec git checkout -- {} +",
      "find src -name '*.java' -exec git restore {} \\;",
      "git diff --name-only | xargs sh -c 'git checkout -- \"$@\"' _",
      // another user's home, the shell's ~+ / ~-: only the run knows the folder
      "git checkout -- ~acme-nobody/proj/c.txt",
      "git restore ~+/c.txt",
      "git checkout ~-/c.txt",
      // a first word only the run knows may be a path as well as a commit
      'git checkout "$REV" b.txt',
      "git checkout ~acme-nobody/proj/c.txt b.txt",
    ];
    for (const command of [...fromRun, "git checkout HEAD -- $(git diff --name-only)"]) {
      expect(await run(root, command), command).toMatchObject({ code: "git_command" });
    }
    // Nothing to lose — no uncommitted change, nothing under review — nothing asks (a branch in a variable included).
    sh(root, "checkout", "-q", "--", ".");
    for (const command of [...fromRun, 'git checkout "$BRANCH"']) expect(await run(root, command, root, []), command).toBeNull();
  });
});

describe("destructiveGitReason: calling off a merge, rebase, cherry-pick, revert or am", () => {
  it("asks while the tree holds work — a conflict Claude resolved and left unstaged — and runs once nothing is left", async () => {
    const root = realpathSync(makeRepo());
    dirs.push(root);
    const main = sh(root, "rev-parse", "--abbrev-ref", "HEAD").trim();
    write(root, "App.java", "class App { int a; }\n");
    sh(root, "add", "App.java");
    sh(root, "commit", "-qm", "base");
    sh(root, "checkout", "-q", "-b", "develop");
    write(root, "App.java", "class App { int dev; }\n");
    sh(root, "commit", "-qam", "develop");
    sh(root, "checkout", "-q", main);
    write(root, "App.java", "class App { int main; }\n");
    sh(root, "commit", "-qam", "main");
    expect(() => sh(root, "merge", "-q", "develop")).toThrow(); // the conflict
    write(root, "App.java", "class App { int main; int dev; }\n"); // Claude's resolution, not added
    const run = (command: string, reviewPaths: string[]) => destructiveGitReason(command, { cwd: root, root, reviewPaths: new Set(reviewPaths) });
    const callOff = ["git merge --abort", "git rebase --abort", "git rebase --skip", "git cherry-pick --abort", "git cherry-pick --skip", "git revert --abort", "git revert --skip", "git am --abort", "git am --skip"];
    for (const command of callOff) {
      expect(await run(command, ["App.java"]), command).toMatchObject({ code: "git_command" });
      expect(await run(command, []), command).toMatchObject({ code: "git_command" }); // unmerged and changed: work all the same
    }
    // Going on keeps what was done; so does a merge of its own (and `--quit`, which leaves the tree as it is).
    for (const command of ["git merge --continue", "git rebase --continue", "git cherry-pick --quit", "git merge --quit", "git merge develop", "git merge --no-edit develop"]) {
      expect(await run(command, ["App.java"]), command).toBeNull();
    }
    sh(root, "merge", "--abort");
    for (const command of callOff) expect(await run(command, []), command).toBeNull(); // nothing to lose (untracked files stay)
  });
});

describe("destructiveGitReason: a checkout that recurses into a submodule with work of its own (release-2 review)", () => {
  /** `app` with the submodule `lib`, whose committed f.txt has an uncommitted change. */
  function superproject(): { app: string; lib: string } {
    const lib = realpathSync(makeRepo());
    const app = realpathSync(makeRepo());
    dirs.push(lib, app);
    write(lib, "f.txt", "acme\n");
    sh(lib, "add", "f.txt");
    sh(lib, "commit", "-qm", "f");
    sh(app, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib");
    sh(app, "commit", "-qm", "lib");
    write(join(app, "lib"), "f.txt", "acme changed by claude\n");
    return { app, lib: join(app, "lib") };
  }
  const recursing = (on: boolean): GitProbe => ({ ...gitProbe, recursesSubmodules: async () => on });
  const run = (app: string, command: string, probe: GitProbe) => destructiveGitReason(command, { cwd: app, root: app, reviewPaths: new Set(), probe });

  it("asks when it may recurse — --recurse-submodules, -c submodule.recurse, the user's submodule.recurse — and not when it cannot", async () => {
    const { app, lib } = superproject();
    for (const command of ["git checkout --recurse-submodules -- .", "git -c submodule.recurse=true restore .", "git -c submodule.recurse checkout -- lib", "git restore --recurse-submodules lib"]) {
      expect(await run(app, command, recursing(false)), command).toMatchObject({ code: "git_command" });
    }
    // A plain checkout recurses when the user's configuration says so (submodule.recurse=true, a common global setting).
    expect(await run(app, "git checkout -- .", recursing(true))).toMatchObject({ code: "git_command" });
    // Without recursion git leaves the submodule's files alone: nothing to lose there.
    expect(await run(app, "git checkout -- .", recursing(false))).toBeNull();
    expect(await run(app, "git checkout --no-recurse-submodules -- .", recursing(true))).toBeNull();
    expect(await run(app, "git -c submodule.recurse=false checkout -- .", recursing(true))).toBeNull();
    // Paths that hold no submodule, and a clean submodule, ask nothing.
    write(app, "README.md", "x\n");
    sh(app, "add", "README.md");
    sh(app, "commit", "-qm", "readme");
    expect(await run(app, "git checkout --recurse-submodules -- README.md", recursing(false))).toBeNull();
    sh(lib, "checkout", "-q", "--", ".");
    expect(await run(app, "git checkout --recurse-submodules -- .", recursing(false))).toBeNull();
    // The real probe reads submodule.recurse where the command runs.
    sh(app, "config", "submodule.recurse", "true");
    expect(await gitProbe.recursesSubmodules!(app)).toBe(true);
    sh(app, "config", "submodule.recurse", "false");
    expect(await gitProbe.recursesSubmodules!(app)).toBe(false);
  });

  it("the repro: what the card protects is really lost by the command", async () => {
    const { app, lib } = superproject();
    expect(await run(app, "git checkout --recurse-submodules -- .", recursing(false))).toMatchObject({ code: "git_command" });
    sh(app, "checkout", "--recurse-submodules", "--", ".");
    expect(sh(lib, "status", "--porcelain")).toBe("");
  });
});

describe("gitInvocations / shellCommands", () => {
  it("reads only commands — never the words of echo, grep or a here-document", () => {
    expect(shellCommands("echo \"git reset --hard\" >> NOTES && git status")).toEqual([["echo", "git reset --hard"], ["git", "status"]]);
    expect(shellCommands("git log --oneline 2>&1 | head -3")).toEqual([["git", "log", "--oneline"], ["head", "-3"]]);
    expect(shellCommands("cat <<EOF\ngit push -f\nEOF\ngit status")).toEqual([["cat"], ["git", "status"]]);
    expect(shellCommands("git status # git reset --hard")).toEqual([["git", "status"]]);
    expect(shellCommands("x=$(git rev-parse HEAD); echo $x")[0]).toEqual(["git", "rev-parse", "HEAD"]);
  });

  it("keeps what each command reads on stdin: a here-document, a here-string, a pipe or a file", () => {
    expect(parseCommands("cat <<'EOF' | bash\ngit status\nEOF\nls")).toEqual([
      { words: ["cat"], input: "git status" },
      { words: ["bash"], stdinElsewhere: true },
      { words: ["ls"] },
    ]);
    expect(parseCommands("sh <<< 'git status' && sh < run.sh 2> err.txt")).toEqual([
      { words: ["sh"], input: "git status" },
      { words: ["sh"], stdinElsewhere: true, writes: ["err.txt"] },
    ]);
    expect(parseCommands("a || b 2<&1")).toEqual([{ words: ["a"] }, { words: ["b"] }]);
    // What its redirections write (§40.1): `>`, `>>`, `>|`, `&>`; never a stream (`2>&1`).
    expect(parseCommands("echo x > .git/HEAD 2>&1 && make &>> build.log >| out.txt").map((c) => c.writes)).toEqual([[".git/HEAD"], ["build.log", "out.txt"]]);
  });

  it("knows where each git command runs", () => {
    const inv = gitInvocations("cd ../wt && git -C sub status && git -c a=b --no-pager log", "/work/acme");
    // Native folders (§20): `/work/wt/sub` here, `D:\work\wt\sub` on Windows (the drive the engine runs on).
    expect(inv.map((g) => [g.dir, g.verb])).toEqual([
      [resolve("/work/wt/sub"), "status"],
      [resolve("/work/wt"), "log"],
    ]);
    // git by its name (§20 programName): git.exe, any case, a quoted Windows path. A git command without `cd` / `-C` runs in
    // the folder the engine is given — native, as the CLI's cwd is (`D:\work\acme` on Windows).
    const named = gitInvocations("\"C:\\Program Files\\Git\\cmd\\git.exe\" -C sub status && GIT.EXE log && gitk", resolve("/work/acme"));
    expect(named.map((g) => [g.dir, g.verb])).toEqual([
      [resolve("/work/acme/sub"), "status"],
      [resolve("/work/acme"), "log"],
    ]);
  });

  it("movesHead / stashesWork: what the hooks watch around a command", () => {
    for (const c of ["git commit -m x", "git add -A && git commit --amend --no-edit", "git checkout -b f", "git pull", "git merge develop", "git reset --hard", "gh pr checkout 42", "git branch -m new"]) {
      expect(movesHead(c, ROOT), c).toBe(true);
    }
    // git and gh by their name (§20 programName)
    for (const c of ["git.exe commit -m x", "GIT pull", "gh.exe pr merge 7", "GH pr checkout 42", "\"C:\\Program Files\\GitHub CLI\\gh.exe\" pr checkout 42"]) {
      expect(movesHead(c, ROOT), c).toBe(true);
    }
    for (const c of ["git status", "git push", "git stash", "git branch -d x", "echo git commit"]) expect(movesHead(c, ROOT), c).toBe(false);
    for (const c of ["git stash", "git stash push -m wip", "git stash -u", "git stash save wip", "GIT.EXE stash"]) expect(stashesWork(c, ROOT), c).toBe(true);
    for (const c of ["git stash pop", "git stash list", "git stash drop", "git status"]) expect(stashesWork(c, ROOT), c).toBe(false);
  });

  it("own commits are the reflog's commit entries after the command's marker", () => {
    expect(isOwnCommitSubject("commit: feat: acme")).toBe(true);
    expect(isOwnCommitSubject("commit (amend): feat: acme")).toBe(true);
    expect(isOwnCommitSubject("commit (initial): init")).toBe(true);
    expect(isOwnCommitSubject("commit (merge): Merge branch 'develop'")).toBe(false);
    expect(isOwnCommitSubject("pull: Fast-forward")).toBe(false);
    expect(isOwnCommitSubject("checkout: moving from main to f")).toBe(false);
    const marker = { sha: "a".repeat(40), at: 100, subject: "commit: before" };
    const entries = [
      { sha: "c".repeat(40), at: 200, subject: "commit: mine" },
      { sha: "b".repeat(40), at: 199, subject: "checkout: moving from main to f" },
      marker,
      { sha: "9".repeat(40), at: 50, subject: "commit: older" },
    ];
    expect(entriesSince(entries, marker, 0).map((e) => e.subject)).toEqual(["commit: mine", "checkout: moving from main to f"]);
    expect(entriesSince(entries, null, 0)).toHaveLength(4);
    expect(entriesSince(entries.slice(0, 2), marker, 199).map((e) => e.at)).toEqual([200, 199]); // marker gone: by time
  });
});

describe("the PreToolUse Bash hook (§46)", () => {
  const opts = { signal: new AbortController().signal };
  function hook(root: string, over: Partial<HookContext> = {}): { preBash: (command: string, id?: string, mode?: string) => Promise<unknown>; ctx: HookContext } {
    const ctx: HookContext = { budget: new BudgetState({ maxFiles: 0, maxLines: 0 }), cwd: root, root, ignorePatterns: [], autoAllowTools: new Set(), emit: () => {}, log: () => {}, ...over };
    const h = buildHooks(ctx).PreToolUse![1]!.hooks[0]!;
    return {
      ctx,
      preBash: (command, id = "t1", mode) =>
        h({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: "s", transcript_path: "", cwd: root, tool_use_id: id, ...(mode ? { permission_mode: mode } : {}) } as unknown as HookInput, id, opts),
    };
  }
  const decision = (out: unknown) => {
    const h = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
    return { decision: h?.permissionDecision, reason: h?.permissionDecisionReason };
  };
  function repo(): string {
    const d = realpathSync(makeRepo());
    dirs.push(d);
    return d;
  }

  it("auto mode: a commit, a branch, a stash, a pull and a push are the CLI's (no decision); reset --hard asks with the reason", async () => {
    const root = repo();
    const { preBash, ctx } = hook(root, { permissionMode: "auto" });
    for (const command of ["git add -A && git commit -m x", "git checkout -b feature/acme-7", "git stash", "git pull --rebase", "git push -u origin feature/acme-7"]) {
      expect(await preBash(command, "t1", "auto"), command).toEqual({});
    }
    expect(decision(await preBash("git reset --hard origin/main", "r1", "auto"))).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
    expect(ctx.scopeReasons?.get("r1")).toMatchObject({ code: "git_command" });
  });

  it("default mode: a commit is the ordinary card (no reason: it can be remembered as `Bash:git commit`)", async () => {
    const root = repo();
    const remembered = new Set<string>();
    const { preBash, ctx } = hook(root, { permissionMode: "default", rememberedAllows: remembered });
    expect(decision(await preBash("git commit -m x", "c1"))).toEqual({ decision: "ask", reason: ASK_REASON });
    expect(ctx.scopeReasons?.get("c1")).toBeUndefined();
    expect(rememberKey("Bash", { command: "git commit -m x" })).toBe("Bash:git commit");
    remembered.add("Bash:git commit");
    expect(decision(await preBash("git commit -m y", "c2"))).toEqual({ decision: "allow", reason: REMEMBERED_REASON });
    expect(decision(await preBash("git clean -fd", "c3"))).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
  });

  it("a remembered `Bash:git push` never answers a force push: the reason comes first", async () => {
    const root = repo();
    const { preBash, ctx } = hook(root, { rememberedAllows: new Set(["Bash:git push"]) });
    expect(decision(await preBash("git push origin main", "p1"))).toEqual({ decision: "allow", reason: REMEMBERED_REASON });
    for (const [id, command] of [["p2", "git push --force origin main"], ["p3", "git push origin +main"], ["p4", "git push --delete origin old"]] as const) {
      expect(decision(await preBash(command, id)), command).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
      expect(ctx.scopeReasons?.get(id)?.code).toBe("git_command");
    }
  });

  it("a remembered `Bash:git merge` never answers `git merge --abort` while the tree holds work: the reason comes first", async () => {
    const root = repo();
    write(root, "README.md", "a resolution in progress\n");
    const { preBash, ctx } = hook(root, { permissionMode: "default", rememberedAllows: new Set(["Bash:git merge"]) });
    expect(decision(await preBash("git merge develop", "m1"))).toEqual({ decision: "allow", reason: REMEMBERED_REASON });
    expect(decision(await preBash("git merge --abort", "m2"))).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
    expect(ctx.scopeReasons?.get("m2")?.code).toBe("git_command");
    const auto = hook(root, { permissionMode: "auto" });
    expect(decision(await auto.preBash("git rebase --abort", "m3", "auto"))).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
    expect(await auto.preBash("git rebase --continue", "m4", "auto")).toEqual({});
  });

  it("git by its name — git.exe, any case, a full Windows path, inside bash.exe — asks like git (§20 programName)", async () => {
    const root = repo();
    const { preBash, ctx } = hook(root, { permissionMode: "auto" });
    for (const [id, command] of [
      ["w1", "GIT.EXE reset --hard"],
      ["w2", "\"C:\\Program Files\\Git\\cmd\\git.exe\" push --force"],
      ["w3", "bash.exe -c 'git.exe clean -fdx'"],
    ] as const) {
      expect(decision(await preBash(command, id, "auto")), command).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
      expect(ctx.scopeReasons?.get(id)?.code).toBe("git_command");
    }
  });

  it("checkout over a file under review asks; the review's paths come from the engine", async () => {
    const root = repo();
    const review = new Set<string>();
    const { preBash } = hook(root, { permissionMode: "auto", reviewPaths: () => review });
    expect(await preBash("git checkout -- README.md", "k1", "auto")).toEqual({});
    review.add("README.md");
    expect(decision(await preBash("git checkout -- README.md", "k2", "auto"))).toEqual({ decision: "ask", reason: GIT_ASK_REASON });
  });
});
