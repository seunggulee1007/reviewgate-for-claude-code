import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isReadOnlyCommand, isRemembered, matchesAllowPattern, rememberKey, scanCommand, type ReadOnlyContext } from "../src/session/bashClass.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

/** Read-only Bash classifier (docs/M16-FRICTION.md §1). */
describe("isReadOnlyCommand", () => {
  const readOnly = [
    "ls",
    "ls -la src",
    "cat README.md",
    "head -n 20 file.txt",
    "tail -f log.txt",
    "wc -l *.ts",
    "pwd",
    "which node",
    "type git",
    "echo hi",
    "printf '%s\\n' a b",
    "grep -rn 'TODO' src",
    "rg --files",
    "find . -name '*.ts' -type f",
    "fd -e ts",
    "stat package.json",
    "file bin/x",
    "env",
    "env | sort",
    "date",
    "whoami",
    "tree -L 2",
    "du -sh .",
    "df -h",
    "ps aux",
    "id",
    "uname -a",
    "sort -u names.txt",
    "uniq -c sorted.txt",
    "cut -d, -f1 data.csv",
    "sed -n '1,10p' file.txt",
    "sed -ne '/x/p' file.txt",
    "tr a-z A-Z",
    "jq '.name' package.json",
    "node --version",
    "node -v",
    "npm ls",
    "npm view react version",
    "npm -v",
    "python3 --version",
    "git status",
    "git status --porcelain",
    "git log --oneline -5",
    "git --no-pager diff HEAD~1",
    "git show HEAD:README.md",
    "git branch -a",
    "git branch --show-current",
    "git branch --list 'feature/*'",
    "git rev-parse --abbrev-ref HEAD",
    "git remote -v",
    "git remote show origin",
    "git ls-files",
    "git blame -L 1,10 src/x.ts",
    "git describe --tags",
    "git tag -l 'v*'",
    // pipelines / chains of read-only commands
    "cat a.txt | grep foo | wc -l",
    "git status && git diff --stat",
    "ls; pwd",
    "git log --oneline || echo none",
    "LC_ALL=C git log -1",
    "/usr/bin/git status",
    // quotes hide operators and dangerous words
    "grep 'rm -rf' notes.txt",
    "echo 'a > b'",
    'echo "a | b && rm x"',
    "grep -e '$(rm x)' file",
    "echo 'it''s'",
    "grep \\> file",
    "ls # > not a redirect",
    // tightened classifier (release review H1): these stay read-only
    "sed -n '/x/{p;q}' file",
    "sed -n -e 's/a/b/gp' -e '$p' file",
    "sed -nE '1~2p;10q' file",
    "git --no-pager log -p",
    "git log --no-ext-diff -p",
    "git log --oneline --output-indicator-new=+",
    "env -u HOME",
    "env LC_ALL=C git status",
    "date +%Y-%m-%d",
    "date -u",
    "rg -n foo src",
    "sort -u -k2 file",
    "cat *.ts",
    "echo $HOME",
    "file -b x",
    // §19.3: a redirection into /dev/null or onto another stream writes no file
    "ls 2>&1",
    "ls 2>/dev/null",
    "grep -rn X src 2>/dev/null | head",
    "cat a 2>&1 | tail",
    "git status >/dev/null 2>&1",
    "ls &>/dev/null",
    "ls 2>> /dev/null",
    "echo done >&2",
    "ls 1>&2 | cat",
    "ls>/dev/null",
    // §19.3: git reads beyond the first set
    "git grep -n TODO -- src",
    "git ls-tree -r HEAD --name-only",
    "git merge-base HEAD origin/main",
    "git rev-list --count HEAD",
    "git show-ref --heads",
    "git for-each-ref --format='%(refname:short)' refs/heads",
    "git cat-file -p HEAD:README.md",
    "git cat-file -t HEAD",
    "git stash list",
    "git stash show -p stash@{0}",
    "git worktree list --porcelain",
    "git config --get user.email",
    "git config --get-all remote.origin.fetch",
    "git config --get-regexp '^remote\\.'",
    "git config --list",
    "git config -l --show-origin",
    "git config --global user.email",
    "git config user.email",
    "git config -f .gitmodules --get submodule.lib.path",
    "git config get user.email",
    "git config list",
    // §19.3: tests, no-ops, GitHub reads, xargs into a command whose options are all harmless
    "test -f .git/hooks/pre-push && echo y",
    "[ -d src ] && ls src",
    "test -n x || echo empty",
    "true",
    "false || echo no",
    "gh pr view 42",
    "gh pr view 42 --comments --json body",
    "gh pr list --state open",
    "gh pr diff 42",
    "gh pr checks 42",
    "gh pr status",
    "gh issue view 7",
    "gh issue list --label bug",
    "gh repo view acme/acme",
    "gh run view 1234 --log",
    "gh run list -L 5",
    "gh api repos/o/r/pulls/1/comments",
    "gh api -X GET repos/o/r/issues --jq '.[].title'",
    "gh api --method=GET repos/o/r",
    "gh api --paginate repos/o/r/pulls",
    "find . -name '*.java' | xargs grep -l Foo",
    "xargs cat",
    "find . -print0 | xargs -0 -n 20 wc -l",
    "git ls-files | xargs -I{} grep -l x {}",
    "ls | xargs -I {} cat {}",
    "xargs",
  ];
  const notReadOnly = [
    "",
    "   ",
    "ls > x",
    "ls >> x",
    "cat < in.txt",
    "cat a | tee b",
    "git status && rm x",
    "git status; rm -rf x",
    "ls || rm x",
    "echo $(rm x)",
    'echo "$(rm x)"',
    "echo `rm x`",
    'echo "`rm x`"',
    "diff <(ls a) <(ls b)",
    "(ls)",
    "{ ls; }",
    "ls &",
    "ls |& cat",
    "sed -i 's/a/b/' file",
    "sed -i.bak 's/a/b/' file",
    "sed -ni 's/a/b/p' file",
    "sed --in-place=.bak 's/a/b/' file",
    "sed 's/a/b/' file", // no -n
    "npm test",
    "npm install",
    "npm run build",
    "node script.js",
    "node -e 'process.exit()'",
    "python3 script.py",
    "sudo ls",
    "rm x",
    "mv a b",
    "cp a b",
    "touch x",
    "mkdir x",
    "xargs rm",
    "find . -name x | xargs rm",
    "eval ls",
    "exec ls",
    "git commit -m x",
    "git checkout main",
    "git push",
    "git add .",
    "git branch new-branch",
    "git branch -d old",
    "git branch -D old",
    "git branch -m a b",
    "git branch --set-upstream-to=origin/main",
    "git tag v1.0",
    "git tag -d v1.0",
    "git tag -a v1.0 -m x",
    "git remote add origin url",
    "git remote remove origin",
    "git remote set-url origin url",
    "git log --output=log.txt",
    "git -C /tmp/repo commit -m x",
    "find . -delete",
    "find . -name x -exec rm {} \\;",
    "find . -execdir rm {} \\;",
    "fd -x rm",
    "fd --exec rm",
    "sort -o out.txt in.txt",
    "uniq in.txt out.txt",
    "tree -o out.txt",
    "date -s '2020-01-01'",
    "env rm x",
    "awk '{print > \"out\"}' in",
    "awk 'BEGIN{system(\"rm x\")}'",
    "awk '{print | \"sh\"}' in",
    "./ls",
    "ls 'unterminated",
    'ls "unterminated',
    "curl https://x",
    "make",
    "cat a\nrm b",
    // release review H1: options / words that execute or write behind a read-only command name
    "git -c core.fsmonitor='rm -rf x' status",
    "git -c diff.external=./x diff",
    "git -c core.pager=cat diff --stat",
    "git -C /tmp/repo log --oneline",
    "git --git-dir=/tmp/x/.git log",
    "git --work-tree=/tmp status",
    "git --exec-path=/tmp status",
    "git --config-env=core.pager=X log",
    "git diff --ext-diff",
    "git log -p --textconv",
    "git show --out=x",
    "git diff --ext",
    "rg --pre ./evil.sh foo",
    "rg --pre=./evil.sh foo",
    "rg --pre-glob '*' --pre x foo",
    "rg --hostname-bin=./x foo",
    "sort --compress-program=./x big.txt",
    "sort --comp=./x big.txt",
    "sort --output=out in",
    "sort --out=out in",
    "sort -uo out in",
    "sed -n 'w out' file",
    "sed -n '1w out' file",
    "sed -n 's/a/b/w out' file",
    "sed -n 's/a/b/e' file",
    "sed -n 'e rm x' file",
    "sed -n '1e rm x' file",
    "sed -n 'r /etc/passwd' file",
    "sed -n 'W out' file",
    "sed -n -f script.sed file",
    "sed -nf script.sed file",
    "sed --quiet --file=script.sed file",
    "sed -n -I '' 's/a/b/p' file",
    "sed -n --in-pl 's/a/b/p' file",
    "sed -n -e p -e 'w out' file",
    "awk '{print $1}' data.txt",
    "awk -f prog.awk data.txt",
    "awk '{f=\"system\"; @f(\"rm x\")}'",
    "env -S 'rm x'",
    "env --split-string='rm x'",
    "env -i rm x",
    "env LC_ALL=C rm x",
    "env NODE_OPTIONS=--require=./x.js node --version",
    "NODE_OPTIONS=--require=./x.js node --version",
    "GIT_EXTERNAL_DIFF=./x git diff",
    "PAGER=./x git log",
    "LD_PRELOAD=./x.so ls",
    "X=1",
    "find . -fprint out",
    "fd -Hx rm",
    "fd -X rm",
    "fd --exec-batch=rm",
    "rg foo *",
    "sort $OPTS in",
    "git log $X",
    "date 0101000020",
    "date --set=now",
    "date --se=now",
    "file -C -m magic",
    "/tmp/bin/ls",
    "/Users/me/repo/node_modules/.bin/ls",
    "tee out",
    "less file",
    "more file",
    "man ls",
    "git st",
    // §19.3: redirections that write a file, commands that are not read-only behind a harmless redirection
    "ls > out.txt",
    "./x 2>&1 | tail",
    "ls 2>/dev/nullx",
    "ls 2>/dev/null/x",
    "ls >&out.txt",
    "ls 2>&1x",
    "ls 2>'/dev/null'",
    "ls >| /dev/null",
    "cat <<EOF",
    // §19.3: git that writes, opens an editor or a pager, or prints through configured programs
    "git config user.email a@b",
    "git config --add x.y z",
    "git config --unset user.email",
    "git config --unset-a x.y",
    "git config --replace-all x.y z",
    "git config --edit",
    "git config -e",
    "git config --ed",
    "git config --rename-section a b",
    "git config --remove-section a",
    "git config set user.email a@b",
    "git config unset user.email",
    "git config edit",
    "git config",
    "git grep -O x",
    "git grep --open-files-in-pager=vim x",
    "git cat-file --batch",
    "git cat-file --textconv HEAD:x",
    "git cat-file --filters HEAD:x",
    "git cat-file blob HEAD:x",
    "git stash",
    "git stash pop",
    "git stash drop",
    "git worktree add ../x",
    "git worktree remove ../x",
    "git worktree prune",
    // tests that can run code, GitHub writes
    "test -v 'a[$(rm x)]'",
    "[ -v x ]",
    "[ -f x",
    "[[ -f x ]]",
    "test -f $F",
    "gh pr checkout 42",
    "gh pr merge 42",
    "gh pr comment 42 -b hi",
    "gh pr create",
    "gh issue create",
    "gh repo clone acme/acme",
    "gh run rerun 1",
    "gh api -X POST repos/o/r/issues",
    "gh api -XDELETE repos/o/r",
    "gh api --method PATCH repos/o/r",
    "gh api -f a=b repos/o/r/issues",
    "gh api -F a=@file repos/o/r/issues",
    "gh api --field a=b repos/o/r",
    "gh api --raw-field a=b repos/o/r",
    "gh api --input body.json repos/o/r",
    "gh api -if a=b repos/o/r",
    "gh api",
    "gh",
    "gh pr",
    "gh pr view $N",
    // xargs into anything but a command whose options are all harmless
    "xargs rm",
    "xargs sed -n p",
    "xargs git log",
    "xargs xargs cat",
    "xargs -p cat",
    "xargs --max-args=1 cat",
    "xargs -I {} sh -c 'cat {}'",
    "xargs $CMD",
    "awk '{print}' f",
    // cd / pushd / git -C without a context
    "cd src && git status",
    "cd src",
    "pushd src && ls",
    "git -C src log",
  ];
  it.each(readOnly)("read-only: %s", (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });
  it.each(notReadOnly)("NOT read-only: %j", (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false);
  });

  it("scanCommand keeps refusing every redirection and `{}` (allow patterns and remembered keys, §19.3)", () => {
    expect(scanCommand("ls 2>&1")).toBeNull();
    expect(scanCommand("ls 2>/dev/null")).toBeNull();
    expect(scanCommand("find . -exec cat {} +")).toBeNull();
  });

  it("scanCommand splits segments with quotes awareness", () => {
    expect(scanCommand("cat 'a b' | grep \"c d\" && ls")).toEqual({ segments: [["cat", "a b"], ["grep", "c d"], ["ls"]] });
    expect(scanCommand("ls;")).toEqual({ segments: [["ls"]] });
    expect(scanCommand("ls > x")).toBeNull();
    expect(scanCommand("echo $(x)")).toBeNull();
  });

  it("scanCommand: inside double quotes a backslash escapes only $ ` \" \\ and a newline, like bash (a Windows path in Git Bash keeps its backslashes)", () => {
    expect(scanCommand('cd "C:\\Users\\me\\wt" && npm test')).toEqual({ segments: [["cd", "C:\\Users\\me\\wt"], ["npm", "test"]] });
    expect(scanCommand('echo "a\\"b" "c\\\\d" "\\$HOME" "e\\`f" "g\\\nh"')).toEqual({ segments: [["echo", 'a"b', "c\\d", "$HOME", "e`f", "gh"]] });
    // Unquoted, the shell drops them: that word names another directory.
    expect(scanCommand("cd C:\\Users\\me")).toEqual({ segments: [["cd", "C:Usersme"]] });
    expect(isReadOnlyCommand('cat "C:\\Users\\me\\a.txt"')).toBe(true);
  });
});

/** §19.3: where a command runs — `cd` / `pushd` / `git -C` count as read-only only into the repository. */
describe("isReadOnlyCommand with a context", () => {
  // <tmp>/acme (the root: sub/deeper, src, vendor/lib — a nested clone), <tmp>/acme-42 (another worktree: src), <tmp>/other
  const base = realpathSync(makeTempDir("rg-roctx"));
  afterAll(() => removeDir(base));
  const root = join(base, "acme");
  const sibling = join(base, "acme-42");
  const vendor = join(root, "vendor", "lib");
  for (const d of [join(root, "sub", "deeper"), join(root, "src"), vendor, join(sibling, "src"), join(base, "other")]) mkdirSync(d, { recursive: true });
  const ctx: ReadOnlyContext = { cwd: root, root, sameRepoDirs: [sibling], foreignDir: (d) => d === vendor || d.startsWith(vendor + "/") };

  it("a cd into the root or one of the repository's worktrees is neutral; it moves where later segments run", () => {
    for (const cmd of [
      `cd ${root}/sub && git status`,
      "cd sub && git status",
      `cd ${sibling} && ls`,
      "cd ../acme-42 && ls && git log --oneline -1",
      "cd ../acme-42 && git -C src log --oneline -3",
      `pushd ${sibling} && git status`,
      "cd -P ../acme-42 && ls",
      "cd -- sub && ls",
      "cd sub",
      "cd sub/deeper && ls",
      `git -C ${sibling} log --oneline -3`,
      "git -C ../acme-42 status",
      "git -C . -C sub status",
      "git -C ../acme-42 config --get user.email",
    ]) {
      expect(isReadOnlyCommand(cmd, ctx), cmd).toBe(true);
      if (/\bcd\b|pushd|-C/.test(cmd)) expect(isReadOnlyCommand(cmd), `${cmd} (no context)`).toBe(false);
    }
  });

  it("anywhere else a cd / pushd / git -C is not read-only — a foreign repository's config can run programs on git status", () => {
    for (const cmd of [
      "cd /elsewhere/repo && git status",
      "cd missing && git status", // not there: CDPATH decides where the shell goes
      "cd .. && ls",
      "cd ../other && git status",
      "cd && ls",
      "cd - && ls",
      "cd $HOME && ls",
      "cd ~ && ls",
      "cd ~/acme && ls",
      "cd ~dev && ls",
      "cd a b && ls",
      "pushd +1",
      "cd vendor/lib && git status",
      "git -C /elsewhere log",
      "git -C .. log",
      "git -C vendor/lib status",
      "git -C $DIR status",
      "git -C",
      "cd sub && git -C .. -C .. log",
      // a cd that fails, or one in a pipeline, leaves the shell where it was: the next -C must be safe from both
      "cd sub || git -C .. log",
      "cd sub; cd ..; ls",
      "cd ../acme-42 | git -C ../acme-42/.. log",
      "cd sub && rm x",
      `"cd" sub && ls`,
    ]) {
      expect(isReadOnlyCommand(cmd, ctx), cmd).toBe(false);
    }
  });

  it("an unquoted `~` is the home folder; a quoted one is a folder named ~ where the shell is", () => {
    mkdirSync(join(root, "~"), { recursive: true });
    const inHome: ReadOnlyContext = { cwd: homedir(), root: homedir(), sameRepoDirs: [] };
    expect(isReadOnlyCommand("cd ~ && ls", inHome)).toBe(true);
    expect(isReadOnlyCommand("cd ~ && ls", ctx)).toBe(false);
    expect(isReadOnlyCommand("cd '~' && ls", ctx)).toBe(true);
  });
});

/** Claude-style allow patterns (docs/M16-FRICTION.md §2). */
describe("matchesAllowPattern", () => {
  it("prefix patterns (`:*`) match at a word boundary", () => {
    expect(matchesAllowPattern("Bash(npm test:*)", "npm test")).toBe(true);
    expect(matchesAllowPattern("Bash(npm test:*)", "npm test -- --watch")).toBe(true);
    expect(matchesAllowPattern("Bash(npm test:*)", "npm  test  x")).toBe(true); // whitespace collapsed
    expect(matchesAllowPattern("Bash(npm test:*)", "npm testing")).toBe(false);
    expect(matchesAllowPattern("Bash(npm test:*)", "npm run test")).toBe(false);
    expect(matchesAllowPattern("Bash(git:*)", "gitk")).toBe(false);
    expect(matchesAllowPattern("Bash(git:*)", "git push")).toBe(true);
  });
  it("glob patterns match the whole command; plain patterns match exactly", () => {
    expect(matchesAllowPattern("Bash(git *)", "git push origin main")).toBe(true);
    expect(matchesAllowPattern("Bash(git *)", "git")).toBe(false);
    expect(matchesAllowPattern("Bash(git *)", "gitk x")).toBe(false);
    expect(matchesAllowPattern("Bash(* --version)", "node --version")).toBe(true);
    expect(matchesAllowPattern("Bash(make)", "make")).toBe(true);
    expect(matchesAllowPattern("Bash(make)", "make clean")).toBe(false);
    expect(matchesAllowPattern("Bash(a.b)", "axb")).toBe(false); // `.` is literal
  });
  it("bare patterns are accepted; other tools' patterns never match", () => {
    expect(matchesAllowPattern("npm test:*", "npm test")).toBe(true);
    expect(matchesAllowPattern("WebFetch(domain:x)", "npm test")).toBe(false);
    expect(matchesAllowPattern("Bash()", "")).toBe(false);
  });
});

describe("rememberKey", () => {
  it("Bash: first two words; other tools: the tool name", () => {
    expect(rememberKey("Bash", { command: "echo hi > x.txt" })).toBe("Bash:echo hi");
    expect(rememberKey("Bash", { command: "  echo   hi again" })).toBe("Bash:echo hi");
    expect(rememberKey("Bash", { command: "make" })).toBe("Bash:make");
    expect(rememberKey("Bash", {})).toBe("Bash:");
    expect(rememberKey("WebFetch", { url: "https://x" })).toBe("WebFetch:WebFetch");
    expect(rememberKey("mcp__x__y", {})).toBe("mcp__x__y:mcp__x__y");
  });
});

describe("allow patterns and remembered allows only cover whole simple commands", () => {
  const chained = [
    "npm test && rm -rf x",
    "npm test; rm -rf x",
    "npm test || rm -rf x",
    "npm test | sh",
    "npm test\nrm -rf x",
    "npm test $(rm -rf x)",
    "npm test `rm -rf x`",
    "npm test > /etc/passwd",
    "npm test < x",
    "npm test 2>&1",
    "npm test &",
    "npm test & rm -rf x",
    "(npm test)",
    "{ npm test; }",
    "npm test \"$(rm -rf x)\"",
    "npm test |& tee x",
    "npm test 'unterminated",
  ];
  it("a chained / redirected / substituted command never matches a prefix or glob pattern", () => {
    for (const c of chained) {
      expect(matchesAllowPattern("Bash(npm test:*)", c), c).toBe(false);
      expect(matchesAllowPattern("Bash(npm *)", c), c).toBe(false);
    }
  });
  it("a chain matches when every segment matches on its own", () => {
    expect(matchesAllowPattern("Bash(npm test:*)", "npm test -- a && npm test -- b")).toBe(true);
    expect(matchesAllowPattern("Bash(git *)", "git status; git log -1")).toBe(true);
    expect(matchesAllowPattern("Bash(git *)", "git status | grep x")).toBe(false);
    expect(matchesAllowPattern("Bash(npm test:*)", "npm test # && rm -rf x")).toBe(true); // a comment runs nothing
  });
  it("quoted arguments are one word; a quoted command name never looks like two words", () => {
    expect(matchesAllowPattern("Bash(npm test:*)", "npm test -- 'a && b'")).toBe(true);
    expect(matchesAllowPattern("Bash(npm test:*)", "\"npm test\" x")).toBe(false);
    expect(matchesAllowPattern("Bash(git commit:*)", 'git commit -m "fix: a; b"')).toBe(true);
  });
  it("remembered keys: every segment's key must be remembered; redirections / substitutions never are", () => {
    const set = new Set([rememberKey("Bash", { command: "npm test -- x" })]);
    expect([...set]).toEqual(["Bash:npm test"]);
    expect(isRemembered("Bash", { command: "npm test" }, set)).toBe(true);
    expect(isRemembered("Bash", { command: "npm  test --watch" }, set)).toBe(true);
    expect(isRemembered("Bash", { command: "npm test && npm test -- y" }, set)).toBe(true);
    for (const c of chained) expect(isRemembered("Bash", { command: c }, set), c).toBe(false);
    expect(isRemembered("Bash", { command: "npm testing" }, set)).toBe(false);
    expect(isRemembered("Bash", {}, set)).toBe(false);
    expect(isRemembered("WebFetch", { url: "x" }, new Set(["WebFetch:WebFetch"]))).toBe(true);
    expect(isRemembered("WebFetch", { url: "x" }, undefined)).toBe(false);
  });
  it("rememberKey honours quotes when the line tokenizes", () => {
    expect(rememberKey("Bash", { command: 'echo "a b" c' })).toBe("Bash:echo a b");
    expect(rememberKey("Bash", { command: "cd x && npm test" })).toBe("Bash:cd x");
  });
});
