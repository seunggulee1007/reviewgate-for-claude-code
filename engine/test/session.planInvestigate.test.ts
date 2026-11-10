import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode } from "../src/protocol.js";
import { BudgetState } from "../src/session/budget.js";
import { ASK_REASON, buildHooks, PLAN_MODE_BASH_REASON, planModeBlocked, READ_ONLY_BASH_REASON, type HookContext } from "../src/session/hooks.js";
import { defaultScratchDirs } from "../src/session/reviewScope.js";
import { clearlyWrites } from "../src/session/shellWrites.js";
import { bashPath, makeRepo, makeTempDir, removeDir } from "./helpers/repo.js";

/**
 * M19 — docs/PROTOCOL.md §19.4: plan mode can investigate. Only a command that clearly writes (a file, packages, the
 * repository) is denied; the rest goes the usual way — read-only runs, anything else is a card in plan mode from the
 * default mode and the CLI's classifier in plan mode from auto (§44.1). CLI 2.1.318 has no Grep / Glob tool: planning
 * searches with Bash.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const opts = { signal: new AbortController().signal };

function ctx(root: string, prePlanMode: PermissionMode): HookContext {
  return {
    budget: new BudgetState({ maxFiles: 0, maxLines: 0 }),
    cwd: root,
    root,
    ignorePatterns: [],
    autoAllowTools: new Set(),
    autoAllowReadOnlyBash: true,
    permissionMode: "plan",
    prePlanMode,
    scratchDirs: defaultScratchDirs(),
    emit: () => {},
    log: () => {},
  };
}

async function bash(c: HookContext, command: string): Promise<{ decision?: string; reason?: string }> {
  const hook = buildHooks(c).PreToolUse![1]!.hooks[0]!;
  const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: "s", transcript_path: "", cwd: c.cwd, tool_use_id: "t1", permission_mode: "plan" } as unknown as HookInput;
  const h = (await hook(input, "t1", opts)) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  return { decision: h.hookSpecificOutput?.permissionDecision, reason: h.hookSpecificOutput?.permissionDecisionReason };
}

/** The audit's denied investigations the read-only rule (§19.3, M03) takes now: they run at once, from either mode. */
const READ_ONLY = [
  "cd module && grep -rn health src",
  "find . -name '*.java' | xargs grep -l Discount",
  "grep -rn TODO src 2>/dev/null | head",
  "git log --oneline -20 2>&1 | head -5",
  "gh pr view 42 --json title,body",
];

/** What else investigating looks like: not read-only by the app's rule, not writing either. */
const INVESTIGATE = [
  "./mvnw -q dependency:tree",
  "awk -F: '{print NF}' README.md",
  "npm test",
  "curl -s https://tasks.example.com/api/acme/42",
  "python3 -c \"import json; print(json.load(open('package.json'))['name'])\"",
  "mvn dependency:tree > /tmp/acme-tree.txt",
];

/** Commands that clearly change something: denied in plan mode, from either mode. */
const WRITES = [
  "echo x > a.txt",
  "cat <<'EOF' >> notes.md\nx\nEOF",
  "sed -i '' s/line1/x/ README.md",
  "sort other.txt | tee sorted.txt",
  "rm -rf build",
  "mv other.txt b.txt",
  "cp other.txt b.txt",
  "touch new.txt",
  "mkdir -p src/acme",
  "chmod +x run.sh",
  "ln -s other.txt link.txt",
  "find . -name '*.orig' -delete",
  "find . -name '*.orig' -exec rm {} +",
  "git ls-files | xargs rm",
  "bash -c 'echo x > a.txt'",
  "npm install",
  "npm i -D vitest",
  "yarn",
  "pip install requests",
  "python3 -m pip install requests",
  "brew install jq",
  "git commit -am x",
  "git add -A",
  "git checkout -b feature/acme-42",
  "git stash",
  "git pull",
  "git reset --hard",
  "git apply fix.patch",
  "git worktree add ../acme-42",
  "gh pr checkout 42",
  "patch -p1 < fix.patch",
];

describe("plan mode can investigate (M19, §19.4)", () => {
  it.each(READ_ONLY)("%s: runs at once, from either mode", async (command) => {
    const root = realpathSync(makeRepo());
    dirs.push(root);
    mkdirSync(join(root, "module", "src"), { recursive: true });
    for (const mode of ["default", "auto"] as const) expect(await bash(ctx(root, mode), command), mode).toEqual({ decision: "allow", reason: READ_ONLY_BASH_REASON });
  });

  it.each(INVESTIGATE)("%s: a card in plan mode from the default mode, the CLI's call in plan mode from auto", async (command) => {
    const root = realpathSync(makeRepo());
    dirs.push(root);
    mkdirSync(join(root, "module"), { recursive: true });
    expect(await bash(ctx(root, "default"), command)).toEqual({ decision: "ask", reason: ASK_REASON });
    expect(await bash(ctx(root, "auto"), command)).toEqual({ decision: undefined, reason: undefined });
  });

  it.each(WRITES)("%s: denied, from either mode", async (command) => {
    const root = realpathSync(makeRepo());
    dirs.push(root);
    for (const mode of ["default", "auto"] as const) expect(await bash(ctx(root, mode), command), mode).toEqual({ decision: "deny", reason: PLAN_MODE_BASH_REASON });
  });

  it("a read-only command still runs at once; a write into a temporary folder is not clearly a change of the work", async () => {
    const root = realpathSync(makeRepo());
    dirs.push(root);
    for (const mode of ["default", "auto"] as const) {
      expect(await bash(ctx(root, mode), "git status"), mode).toEqual({ decision: "allow", reason: READ_ONLY_BASH_REASON });
      expect(await bash(ctx(root, mode), "ls -la && cat README.md"), mode).toEqual({ decision: "allow", reason: READ_ONLY_BASH_REASON });
    }
    const scratch = realpathSync(makeTempDir("rg-plan-scratch"));
    dirs.push(scratch);
    const isScratch = (abs: string) => abs.startsWith(scratch);
    expect(clearlyWrites(`git diff > ${bashPath(scratch)}/diff.txt`, root, isScratch)).toBe(false);
    expect(clearlyWrites(`mkdir -p ${bashPath(scratch)}/x && touch ${bashPath(scratch)}/x/y`, root, isScratch)).toBe(false);
    expect(clearlyWrites(`git diff > ${bashPath(scratch)}/diff.txt && echo x > a.txt`, root, isScratch)).toBe(true);
    // A device is no file.
    expect(clearlyWrites("grep -rn x src 2>/dev/null >/dev/stderr", root)).toBe(false);
  });

  it("the canUseTool rule is the same function: an investigating command is not denied there either", () => {
    const root = "/work/acme";
    const c = { permissionMode: "plan" as const, cwd: root };
    expect(planModeBlocked("Bash", { command: "cd module && grep -rn x ." }, c)).toBeUndefined();
    expect(planModeBlocked("Bash", { command: "echo x > a.txt" }, c)).toBe(PLAN_MODE_BASH_REASON);
    expect(planModeBlocked("Bash", { command: "npm test" }, { ...c, permissionMode: "default" })).toBeUndefined();
  });

  it("a program is known by its name, as git's is (§20): Git Bash's `sed.exe -i`, `gh.exe pr merge`, `PIP install` write", () => {
    const root = "/work/acme";
    expect(clearlyWrites("sed.exe -i s/a/b/ src/cart.ts", root)).toBe(true);
    expect(clearlyWrites("\"C:\\Program Files\\GitHub CLI\\gh.exe\" pr merge 42", root)).toBe(true);
    expect(clearlyWrites("PIP install requests", root)).toBe(true);
    expect(clearlyWrites("gh.exe pr view 42", root)).toBe(false);
    expect(clearlyWrites("sed.exe -n 1,5p src/cart.ts", root)).toBe(false);
  });
});
