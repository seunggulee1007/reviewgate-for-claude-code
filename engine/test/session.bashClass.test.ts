import { describe, expect, it } from "vitest";
import { isReadOnlyCommand, isRemembered, matchesAllowPattern, rememberKey, scanCommand } from "../src/session/bashClass.js";

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
    "ls 2>&1",
    "ls 2>/dev/null",
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
    "xargs cat",
    "less file",
    "more file",
    "man ls",
    "git st",
  ];
  it.each(readOnly)("read-only: %s", (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });
  it.each(notReadOnly)("NOT read-only: %j", (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false);
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
