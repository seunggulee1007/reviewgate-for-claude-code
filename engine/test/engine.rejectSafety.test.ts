import { realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolFileEntry } from "../src/session/events.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { fileExists, makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-rejsafe"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "a.txt", "a\n");
  write(dir, "b.txt", "b\n");
  write(dir, "gone.txt", "gone\n");
  write(dir, "old.txt", "rename me\nwith enough lines\nto be detected\nas a rename\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

async function reviewing(dir: string, mutate: () => void): Promise<Harness> {
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  await h.engine.handle({ type: "send", text: "edit" });
  mutate();
  h.session().emitTurnEnd({ toolFiles: claudesFiles(dir) });
  await h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.turnEndTree !== null, "reviewing");
  return h;
}

/** Every path the turn changed, as Claude's Write calls: `reject_all` reverts only Claude's changes (§31). */
function claudesFiles(dir: string): ToolFileEntry[] {
  const tracked = sh(dir, "diff", "--name-only", "--no-renames", "-z", "HEAD").split("\0");
  const untracked = sh(dir, "ls-files", "-z", "-o", "--exclude-standard").split("\0");
  const paths = [...new Set([...tracked, ...untracked].filter(Boolean))];
  return paths.map((p, i) => ({ path: join(dir, p), tools: ["Write"], count: 1, toolUseIds: [`w${i}`] }));
}

/** The raw `result` reply (code / paths included) of one command. */
async function resultOf(h: Harness, cmd: Parameters<Harness["engine"]["handle"]>[0]): Promise<Record<string, unknown>> {
  await h.engine.handle({ ...cmd, id: "q1" });
  const r = h.ofType("result").filter((e) => e.id === "q1").at(-1);
  expect(r).toBeDefined();
  return r as unknown as Record<string, unknown>;
}

describe("whole-file reject never silently overwrites the user's own edits", () => {
  it("reject refuses an edited file (file_changed_since_review) and keeps it; force reverts it", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => write(dir, "a.txt", "claude\n"));
    write(dir, "a.txt", "claude\nmine\n");
    const r = await resultOf(h, { type: "reject", paths: ["a.txt"] });
    expect(r).toMatchObject({ ok: false, error: "file_changed_since_review:a.txt", code: "file_changed_since_review", paths: ["a.txt"] });
    expect(read(dir, "a.txt")).toBe("claude\nmine\n");
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["a.txt", "pending"]]);
    expect(h.ofType("error")).toEqual([]);
    expect(h.engine.state.gate.phase).toBe("reviewing");

    await h.engine.request({ type: "reject", paths: ["a.txt"], force: true });
    expect(read(dir, "a.txt")).toBe("a\n");
    expect(h.engine.state.changedFiles).toEqual([]);
  });

  it("reject_all lists every edited file and reverts nothing; force reverts all", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => {
      write(dir, "a.txt", "claude a\n");
      write(dir, "b.txt", "claude b\n");
      write(dir, "c.txt", "claude c\n");
    });
    write(dir, "a.txt", "mine a\n");
    rmSync(join(dir, "c.txt")); // deleted by the user: the revert (removal) loses nothing
    write(dir, "b.txt", "claude b\n");
    write(dir, "b.txt", "mine b\n");
    const r = await resultOf(h, { type: "reject_all" });
    expect(r).toMatchObject({ ok: false, code: "file_changed_since_review", paths: ["a.txt", "b.txt"] });
    expect(read(dir, "a.txt")).toBe("mine a\n");
    expect(read(dir, "b.txt")).toBe("mine b\n");
    expect(h.engine.state.gate.pendingCount).toBe(3);

    await h.engine.request({ type: "reject_all", force: true });
    expect(read(dir, "a.txt")).toBe("a\n");
    expect(read(dir, "b.txt")).toBe("b\n");
    expect(fileExists(join(dir, "c.txt"))).toBe(false);
    expect(h.engine.state.changedFiles).toEqual([]);
  });

  it("unchanged files, and files the user already put back to the turn-start content, revert without force", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => {
      write(dir, "a.txt", "claude a\n");
      write(dir, "b.txt", "claude b\n");
      write(dir, "new.txt", "new\n");
    });
    write(dir, "b.txt", "b\n"); // already the A content
    rmSync(join(dir, "new.txt")); // already absent in A
    await h.engine.request({ type: "reject_all" });
    expect(read(dir, "a.txt")).toBe("a\n");
    expect(h.engine.state.changedFiles).toEqual([]);
  });

  it("a modified file the user deleted is refused (the revert would resurrect content they removed)", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => write(dir, "a.txt", "claude\n"));
    rmSync(join(dir, "a.txt"));
    await expect(h.engine.request({ type: "reject", paths: ["a.txt"] })).rejects.toThrow("file_changed_since_review:a.txt");
    expect(fileExists(join(dir, "a.txt"))).toBe(false);
  });

  it("a file Claude deleted that the user re-created is refused; force restores the original", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => rmSync(join(dir, "gone.txt")));
    write(dir, "gone.txt", "my new content\n");
    await expect(h.engine.request({ type: "reject", paths: ["gone.txt"] })).rejects.toThrow("file_changed_since_review:gone.txt");
    expect(read(dir, "gone.txt")).toBe("my new content\n");
    await h.engine.request({ type: "reject", paths: ["gone.txt"], force: true });
    expect(read(dir, "gone.txt")).toBe("gone\n");
  });

  it("an added file the user kept editing is refused (the revert would delete it)", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => write(dir, "new.txt", "claude\n"));
    write(dir, "new.txt", "claude\nmine\n");
    await expect(h.engine.request({ type: "reject", paths: ["new.txt"] })).rejects.toThrow("file_changed_since_review:new.txt");
    expect(read(dir, "new.txt")).toBe("claude\nmine\n");
  });

  it("a rename whose old path the user re-used is refused", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => sh(dir, "mv", "old.txt", "new.txt"));
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.status, f.oldPath])).toEqual([["new.txt", "R", "old.txt"]]);
    write(dir, "old.txt", "something else of mine\n");
    await expect(h.engine.request({ type: "reject", paths: ["new.txt"] })).rejects.toThrow("file_changed_since_review:new.txt");
    expect(read(dir, "old.txt")).toBe("something else of mine\n");
    expect(fileExists(join(dir, "new.txt"))).toBe(true);
  });

  it("an untouched rename and an untouched symlink revert without force", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => {
      sh(dir, "mv", "old.txt", "new.txt");
      symlinkSync("a.txt", join(dir, "link"));
    });
    await h.engine.request({ type: "reject_all" });
    expect(fileExists(join(dir, "new.txt"))).toBe(false);
    expect(fileExists(join(dir, "link"))).toBe(false);
    expect(read(dir, "old.txt")).toContain("rename me");
    expect(h.engine.state.changedFiles).toEqual([]);
  });

  it("the check goes through the clean filters (an eol-only difference the filter normalizes is no edit)", async () => {
    const dir = makeRepo();
    write(dir, ".gitattributes", "*.txt text eol=lf\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "attrs");
    const h = await reviewing(dir, () => write(dir, "a.txt", "claude\n"));
    write(dir, "a.txt", "claude\r\n"); // git add would store "claude\n" — the reviewed blob
    await h.engine.request({ type: "reject", paths: ["a.txt"] });
    expect(read(dir, "a.txt")).toBe("a\n");
  });
});
