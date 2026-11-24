import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addedDirOf, addedDirsInstruction, findAddedDir, MAX_ADDED_DIRS, resolveDirInput, validateAddDir, withAddedDir } from "../src/session/addedDirs.js";
import { isOutsideRoot } from "../src/session/hooks.js";
import { editScopeReason } from "../src/session/reviewScope.js";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §67.1 `/add-dir`: directories beyond the project a classic chat may work in. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});
const temp = (name: string): string => {
  const d = realpathSync(makeTempDir(name));
  dirs.push(d);
  return d;
};

function makeRepo(): string {
  const dir = temp("rg-adddir");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "a.txt", "a\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

describe("§67.1 the added directories (pure)", () => {
  it("resolves ~, quotes and a path relative to the project", () => {
    expect(resolveDirInput("~", "/work/acme", "/Users/dev")).toBe("/Users/dev");
    expect(resolveDirInput("~/lib", "/work/acme", "/Users/dev")).toBe("/Users/dev/lib");
    expect(resolveDirInput("../shared", "/work/acme", "/Users/dev")).toBe("/work/shared");
    expect(resolveDirInput('"/work/acme lib"', "/work/acme", "/Users/dev")).toBe("/work/acme lib");
    expect(resolveDirInput("  /opt/x/  ", "/work/acme", "/Users/dev")).toBe("/opt/x");
  });

  it("validates: an existing directory outside the project, not added yet, at most MAX_ADDED_DIRS", async () => {
    const root = makeRepo();
    const other = temp("rg-adddir-other");
    mkdirSync(join(other, "sub"));
    writeFileSync(join(other, "f.txt"), "x");
    await expect(validateAddDir("", root, [])).rejects.toThrow("dir_empty_path");
    await expect(validateAddDir(join(other, "missing"), root, [])).rejects.toThrow(/^dir_not_found:/);
    await expect(validateAddDir(join(other, "f.txt"), root, [])).rejects.toThrow(/^dir_not_directory:/);
    await expect(validateAddDir(root, root, [])).rejects.toThrow(/^dir_is_project:/);
    await expect(validateAddDir(".", root, [])).rejects.toThrow(/^dir_is_project:/);
    await expect(validateAddDir(join(other, "sub"), root, [other])).rejects.toThrow(`dir_already_added:${other}`);
    await expect(validateAddDir(other, root, Array.from({ length: MAX_ADDED_DIRS }, (_, i) => `/nowhere/${i}`))).rejects.toThrow("dir_too_many");
    expect(await validateAddDir(other, root, [])).toBe(other);
    // A parent folds a child already listed into it.
    expect(withAddedDir([join(other, "sub"), "/opt/x"], other)).toEqual(["/opt/x", other]);
    expect(findAddedDir([other], `${other}/`)).toBe(other);
    expect(findAddedDir([other], "/opt/none")).toBeNull();
  });

  it("an edit in an added directory keeps its card, with its own reason; the project and the rest are unchanged", () => {
    const root = makeRepo();
    const other = temp("rg-adddir-scope");
    const file = join(other, "lib.ts");
    expect(addedDirOf(file, [other])).toBe(other);
    expect(editScopeReason(file, root, isOutsideRoot, [], [], [other])).toMatchObject({ code: "added_directory", path: other });
    expect(editScopeReason(file, root, isOutsideRoot, [], [], [])).toMatchObject({ code: "outside_project" });
    expect(editScopeReason(join(root, "a.txt"), root, isOutsideRoot, [], [], [other])).toBeNull();
    expect(addedDirsInstruction([])).toBe("");
    expect(addedDirsInstruction([other])).toContain(other);
  });
});

describe("§67.1 add_dir / remove_dir", () => {
  it("adds a directory to the chat, keeps it with the chat, and restarts the CLI with it (resumed)", async () => {
    const root = makeRepo();
    const other = temp("rg-adddir-lib");
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(root);
    expect(h.engine.state.session.addedDirs).toEqual([]);
    expect(h.session().opts.settings.addedDirs).toEqual([]);
    await h.engine.request({ type: "add_dir", path: other });
    await h.waitFor((s) => s.session.open && !s.session.starting && h.sessions.length === 2, "restarted");
    expect(h.engine.state.session.addedDirs).toEqual([other]);
    expect(h.session().opts.settings.addedDirs).toEqual([other]);
    expect(h.sessions[0]!.disposed).toBe(true);
    const chat = h.engine.state.sessions.list.find((m) => m.id === h.engine.state.sessions.currentId)!;
    expect(chat.addedDirs).toEqual([other]);
    await expect(h.engine.request({ type: "add_dir", path: other })).rejects.toThrow(`dir_already_added:${other}`);
    await expect(h.engine.request({ type: "add_dir", path: root })).rejects.toThrow(/^dir_is_project:/);

    // A new chat starts without it; the first chat has it again when it comes back.
    const first = h.engine.state.sessions.currentId!;
    await h.engine.request({ type: "session_new" });
    await h.waitFor((s) => s.sessions.currentId !== first && s.session.open && !s.session.starting, "new chat");
    expect(h.engine.state.session.addedDirs).toEqual([]);
    await h.engine.request({ type: "session_open", sessionId: first });
    await h.waitFor((s) => s.sessions.currentId === first && s.session.open && !s.session.starting, "back");
    expect(h.engine.state.session.addedDirs).toEqual([other]);
    expect(h.session().opts.settings.addedDirs).toEqual([other]);

    await h.engine.request({ type: "remove_dir", path: other });
    await h.waitFor((s) => (s.session.addedDirs ?? []).length === 0 && s.session.open && !s.session.starting, "removed");
    expect(h.session().opts.settings.addedDirs).toEqual([]);
    await expect(h.engine.request({ type: "remove_dir", path: other })).rejects.toThrow(/^dir_not_added:/);
  });

  it("is refused while a turn runs (dir_busy), and without a project", async () => {
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await expect(h.engine.request({ type: "add_dir", path: "/tmp" })).rejects.toThrow("no_project");
    const root = makeRepo();
    const other = temp("rg-adddir-busy");
    await h.open(root);
    await h.engine.request({ type: "send", text: "work" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    await expect(h.engine.request({ type: "add_dir", path: other })).rejects.toThrow("dir_busy");
    expect(h.sessions).toHaveLength(1);
  });
});

describe("§67.1 the session takes them", () => {
  it("the SDK's additionalDirectories, the instruction, and an edit there on the card as added_directory", async () => {
    const root = makeRepo();
    const other = temp("rg-adddir-session");
    sh(other, "init", "-q"); // a repository: not a throwaway scratch folder (those never ask)
    let options: Options | undefined;
    const queryFn = (args: { options?: Options }): Query => {
      options = args.options;
      return {
        next: () => new Promise(() => {}),
        return: async () => ({ done: true, value: undefined }),
        [Symbol.asyncIterator]() {
          return this;
        },
        initializationResult: () => new Promise(() => {}),
      } as unknown as Query;
    };
    const events: SessionEvent[] = [];
    const s = new ClaudeSession({
      cwd: root,
      settings: { budget: { maxFiles: 0, maxLines: 0 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", addedDirs: [other] },
      claudePath: "/nonexistent/claude",
      env: {},
      platform: { killTree: async () => undefined, isWindows: false } as never,
      emit: (e) => events.push(e),
      log: () => {},
      queryFn: queryFn as never,
    });
    await s.start();
    (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true); // a turn of ours (§18)
    expect(options?.additionalDirectories).toEqual([other]);
    expect((options?.systemPrompt as { append: string }).append).toContain(other);
    const pending = options!.canUseTool!("Write", { file_path: join(other, "x.ts"), content: "x" }, { signal: new AbortController().signal, toolUseID: "toolu_1" } as never);
    const early = await Promise.race([pending, new Promise((r) => setTimeout(() => r("waiting"), 300))]);
    expect(early).toBe("waiting");
    const card = events.find((e): e is Extract<SessionEvent, { type: "permission_request" }> => e.type === "permission_request");
    expect(card?.reason).toMatchObject({ code: "added_directory", path: other });
    s.respondPermission(card!.requestId, false);
    await pending;
    await s.dispose();
  });
});
