import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { GIT_INTERNAL_REASON } from "../src/session/hooks.js";
import { makeRepo, removeDir } from "./helpers/repo.js";
import { WAIT_MS } from "./helpers/wait.js";

/**
 * M23 — docs/PROTOCOL.md §4, §33.3: an edit in `.git/` other than git's own data or ReviewGate's state ("install a pre-push
 * hook", "add AGENTS.md to .git/info/exclude") reaches the outside-the-project card instead of a deny, should the CLI ask
 * `canUseTool` (the PreToolUse hook answered `ask` in the default mode); git's own data stays denied there too.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function session(root: string): { s: ClaudeSession; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const s = new ClaudeSession({
    cwd: root,
    settings: { budget: { maxFiles: 0, maxLines: 0 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
  });
  return { s, events };
}

describe("canUseTool and .git/ (M23)", () => {
  it("a hook or info/exclude gets the card with outside_project (approved, it is listed outside the review); HEAD is denied", async () => {
    const root = realpathSync(makeRepo());
    dirs.push(root);
    const { s, events } = session(root);
    (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
    const canUseTool = (s as unknown as { canUseTool: CanUseTool }).canUseTool;
    const opts = (id: string) => ({ signal: new AbortController().signal, toolUseID: id }) as never;

    const head = await canUseTool("Write", { file_path: join(root, ".git", "HEAD"), content: "x" }, opts("w0"));
    expect(head).toEqual({ behavior: "deny", message: GIT_INTERNAL_REASON });
    // Release-2 review: the configuration and info/attributes too — a filter driver planted there ran in the engine's own
    // `git add -A` before any review; `git config` through Bash is judged like any command.
    for (const [id, rel, content] of [["c1", "config", '[filter "x"]\n\tclean = sh -c "touch /tmp/pwned"\n'], ["c2", "config.worktree", "[core]\n"], ["c3", "info/attributes", "* filter=x\n"]] as const) {
      expect(await canUseTool("Write", { file_path: join(root, ".git", ...rel.split("/")), content }, opts(id)), rel).toEqual({ behavior: "deny", message: GIT_INTERNAL_REASON });
    }

    void canUseTool("Write", { file_path: join(root, ".git", "hooks", "pre-push"), content: "#!/bin/sh\nnpm test\n" }, opts("w1"));
    void canUseTool("Edit", { file_path: join(root, ".git", "info", "exclude"), old_string: "#", new_string: "AGENTS.md" }, opts("w2"));
    for (const end = Date.now() + WAIT_MS; Date.now() < end && events.filter((e) => e.type === "permission_request").length < 2; ) await new Promise((r) => setTimeout(r, 10));
    const reqs = events.filter((e): e is Extract<SessionEvent, { type: "permission_request" }> => e.type === "permission_request");
    expect(reqs.map((r) => [r.toolName, r.reason?.code])).toEqual([
      ["Write", "outside_project"],
      ["Edit", "outside_project"],
    ]);
    // No "always allow" for a card with a reason.
    expect(reqs.every((r) => r.allowPatterns === undefined)).toBe(true);
    await s.dispose();
  });
});
