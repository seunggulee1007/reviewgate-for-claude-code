import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TREE, GitCheckpoint, initRepository, openCheckpoint } from "../src/git/checkpoint.js";
import { GitCommandError, NotARepositoryError } from "../src/git/exec.js";
import { fileExists, indexFingerprint, makeRepo, makeTempDir, mode, read, removeDir, sh, write } from "./helpers/repo.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("GitCheckpoint", () => {
  it("open on a non-repo throws NotARepositoryError", async () => {
    const dir = track(makeTempDir());
    await expect(openCheckpoint(dir)).rejects.toBeInstanceOf(NotARepositoryError);
  });

  it("init and snapshot on a fresh repo without commits", async () => {
    const dir = track(makeTempDir());
    await initRepository(dir);
    const cp = await openCheckpoint(dir);
    expect(basename(cp.root)).toBe(basename(dir));
    expect(cp.root).toBe(realpathSync.native(dir)); // native form (docs/PROTOCOL.md §20), not git's C:/…
    expect(fileExists(join(cp.root, ".git"))).toBe(true);

    const empty = await cp.snapshot();
    expect(empty).toBe(EMPTY_TREE);

    write(dir, "a.txt", "a\n");
    const tree = await cp.snapshot();
    expect(tree).toHaveLength(40);
    expect(tree).not.toBe(empty);
    const changes = await cp.changes(empty, tree);
    expect(changes.map((c) => c.path)).toEqual(["a.txt"]);
    expect(changes[0]!.status).toBe("A");
    expect(changes[0]!.added).toBe(1);
    expect(changes[0]!.deleted).toBe(0);

    // snapshot never creates/touches the user's index
    expect(fileExists(join(dir, ".git", "index"))).toBe(false);
    expect(sh(dir, "status", "--porcelain")).toBe("?? a.txt\n");
  });

  it("changes, patch and revert round trip", async () => {
    const dir = track(makeRepo());
    const cp = await openCheckpoint(dir);

    const originalStatus = sh(dir, "status", "--porcelain");
    expect(originalStatus).toBe("?? untracked.txt\n");
    const indexBefore = indexFingerprint(dir);

    const a = await cp.snapshot();

    // --- the "agent turn" ---
    write(dir, "README.md", "line1\nline2 changed\nline3\nline4\n");
    write(dir, "untracked.txt", "modified untracked\n");
    write(dir, "new.txt", "brand new\n");
    write(dir, "sub/dir/deep.txt", "deep\n");
    rmSync(join(dir, "other.txt"));
    renameSync(join(dir, "tomove.txt"), join(dir, "moved.txt"));
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin/run.sh"), "#!/bin/sh\necho hi\n");
    if (posix) chmodSync(join(dir, "bin/run.sh"), 0o755);
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0xff, 0x00, 0x01]));

    const b = await cp.snapshot();
    expect(a).not.toBe(b);

    const indexAfter = indexFingerprint(dir);
    expect(indexAfter.mtimeMs).toBe(indexBefore.mtimeMs);
    expect(indexAfter.bytes.equals(indexBefore.bytes)).toBe(true);

    // --- changes ---
    const changes = await cp.changes(a, b);
    const byPath = new Map(changes.map((c) => [c.path, c]));
    expect(new Set(byPath.keys())).toEqual(
      new Set(["README.md", "untracked.txt", "new.txt", "sub/dir/deep.txt", "other.txt", "moved.txt", "bin/run.sh", "blob.bin"]),
    );

    expect(byPath.get("README.md")).toMatchObject({ status: "M", added: 2, deleted: 1, isBinary: false });
    expect(byPath.get("untracked.txt")).toMatchObject({ status: "M", added: 1, deleted: 1 });
    expect(byPath.get("new.txt")).toMatchObject({ status: "A", added: 1, deleted: 0 });
    expect(byPath.get("sub/dir/deep.txt")).toMatchObject({ status: "A" });
    expect(byPath.get("other.txt")).toMatchObject({ status: "D", added: 0, deleted: 1 });
    expect(byPath.get("moved.txt")).toMatchObject({ status: "R", oldPath: "tomove.txt", added: 0, deleted: 0 });
    expect(byPath.get("blob.bin")).toMatchObject({ status: "A", isBinary: true, added: 0, deleted: 0 });
    for (const c of changes) {
      expect(c.tools).toEqual([]);
      expect(c.state).toBe("pending");
    }

    // --- patch (raw text; the unified-diff parser has its own tests) ---
    const readmePatch = await cp.patch(a, b, "README.md");
    expect(readmePatch).toContain("--- a/README.md");
    expect(readmePatch).toContain("+++ b/README.md");
    expect(readmePatch).toContain("-line2\n+line2 changed\n line3\n+line4\n");
    expect(readmePatch.match(/^@@ /gm)).toHaveLength(1);

    const newPatch = await cp.patch(a, b, "new.txt");
    expect(newPatch).toContain("--- /dev/null");
    expect(newPatch).toContain("+++ b/new.txt");
    expect(newPatch).toContain("+brand new");

    const delPatch = await cp.patch(a, b, "other.txt");
    expect(delPatch).toContain("--- a/other.txt");
    expect(delPatch).toContain("+++ /dev/null");
    expect(delPatch).toContain("-other");

    // rename is recognized (both paths passed to git), not shown as a brand-new file
    const renamePatch = await cp.patch(a, b, "moved.txt");
    expect(renamePatch).toContain("rename from tomove.txt");
    expect(renamePatch).toContain("rename to moved.txt");
    expect(renamePatch).not.toContain("@@");
    // the explicit oldPath form yields the same patch without the extra name-status call
    expect(await cp.patch(a, b, "moved.txt", "tomove.txt")).toBe(renamePatch);

    const binPatch = await cp.patch(a, b, "blob.bin");
    expect(binPatch).toContain("Binary files /dev/null and b/blob.bin differ");

    // --- revert ---
    await cp.revert(byPath.get("new.txt")!, a);
    expect(fileExists(join(dir, "new.txt"))).toBe(false);

    await cp.revert(byPath.get("sub/dir/deep.txt")!, a);
    expect(fileExists(join(dir, "sub/dir/deep.txt"))).toBe(false);
    expect(fileExists(join(dir, "sub"))).toBe(false); // empty parents pruned
    expect(fileExists(dir)).toBe(true); // root untouched

    await cp.revert(byPath.get("untracked.txt")!, a);
    expect(read(dir, "untracked.txt")).toBe("original untracked\n");

    await cp.revert(byPath.get("README.md")!, a);
    expect(read(dir, "README.md")).toBe("line1\nline2\nline3\n");

    await cp.revert(byPath.get("other.txt")!, a);
    expect(read(dir, "other.txt")).toBe("other\n");

    await cp.revert(byPath.get("moved.txt")!, a);
    expect(fileExists(join(dir, "moved.txt"))).toBe(false);
    expect(read(dir, "tomove.txt")).toBe("move me\n");

    await cp.revert(byPath.get("bin/run.sh")!, a);
    expect(fileExists(join(dir, "bin"))).toBe(false);
    await cp.revert(byPath.get("blob.bin")!, a);
    expect(fileExists(join(dir, "blob.bin"))).toBe(false);

    // reverts never touched the index (checked before any git status call, which may refresh the stat cache)
    const indexFinal = indexFingerprint(dir);
    expect(indexFinal.mtimeMs).toBe(indexBefore.mtimeMs);
    expect(indexFinal.bytes.equals(indexBefore.bytes)).toBe(true);

    // user's original state is back
    expect(sh(dir, "status", "--porcelain")).toBe(originalStatus);
    expect(sh(dir, "diff", "--cached")).toBe("");

    const c = await cp.snapshot();
    expect(c).toBe(a);
    expect(await cp.changes(a, c)).toEqual([]);
  });

  // The executable bit does not exist on Windows file systems (core.fileMode=false); genuinely unavailable there.
  it.skipIf(!posix)("writeBlob fallback restores bytes and the executable bit", async () => {
    const dir = track(makeRepo());
    const cp = await openCheckpoint(dir);

    write(dir, "tools/script.sh", "#!/bin/sh\necho original\n");
    chmodSync(join(dir, "tools/script.sh"), 0o755);
    const a = await cp.snapshot();

    write(dir, "tools/script.sh", "#!/bin/sh\necho changed\n");
    chmodSync(join(dir, "tools/script.sh"), 0o644);
    write(dir, "untracked.txt", "changed\n");
    rmSync(join(dir, "tools"), { recursive: true });

    // direct fallback path (used when `git restore` refuses a path)
    await cp.writeBlob("tools/script.sh", a);
    await cp.writeBlob("untracked.txt", a);
    expect(read(dir, "tools/script.sh")).toBe("#!/bin/sh\necho original\n");
    expect(read(dir, "untracked.txt")).toBe("original untracked\n");
    expect(mode(join(dir, "tools/script.sh")) & 0o111).not.toBe(0);
    expect(mode(join(dir, "untracked.txt")) & 0o111).toBe(0);

    expect(sh(dir, "status", "--porcelain")).toBe("?? tools/\n?? untracked.txt\n");
    expect(sh(dir, "diff", "--cached")).toBe("");
  });

  // Same: no executable bit on Windows (the index-recorded mode is covered by engine.hunks.test.ts).
  it.skipIf(!posix)("revert of a modified executable keeps its mode", async () => {
    const dir = track(makeRepo());
    const cp = await openCheckpoint(dir);
    write(dir, "run.sh", "#!/bin/sh\necho a\n");
    chmodSync(join(dir, "run.sh"), 0o755);
    const a = await cp.snapshot();
    write(dir, "run.sh", "#!/bin/sh\necho b\n");
    const b = await cp.snapshot();
    const f = (await cp.changes(a, b)).find((c) => c.path === "run.sh");
    expect(f).toBeDefined();
    expect(f!.status).toBe("M");
    await cp.revert(f!, a);
    expect(read(dir, "run.sh")).toBe("#!/bin/sh\necho a\n");
    expect(mode(join(dir, "run.sh")) & 0o111).not.toBe(0);
  });

  it("rename with content change keeps numstat counts on the new path", async () => {
    // `numstat -z` prints renames as "added\tdeleted\t\0old\0new\0"; the counts must land on the new path.
    const dir = track(makeRepo());
    const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    write(dir, "big.txt", body);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "big");
    const cp = await openCheckpoint(dir);
    const a = await cp.snapshot();

    renameSync(join(dir, "big.txt"), join(dir, "renamed.txt"));
    write(dir, "renamed.txt", body.replace("line 3\n", "LINE THREE\nextra\n"));
    const b = await cp.snapshot();

    const renamed = (await cp.changes(a, b)).find((c) => c.path === "renamed.txt");
    expect(renamed).toMatchObject({ status: "R", oldPath: "big.txt", added: 2, deleted: 1, isBinary: false });
  });

  it("non-ASCII file names survive -z parsing and revert", async () => {
    const dir = track(makeRepo());
    const cp = await openCheckpoint(dir);
    const a = await cp.snapshot();
    write(dir, "문서/한글 파일.txt", "안녕\n");
    const b = await cp.snapshot();
    const changes = await cp.changes(a, b);
    expect(changes.map((c) => c.path)).toEqual(["문서/한글 파일.txt"]);
    expect(changes[0]).toMatchObject({ status: "A", added: 1 });
    expect((await cp.patch(a, b, "문서/한글 파일.txt")).includes("+안녕")).toBe(true);
    expect((await cp.fileContent("문서/한글 파일.txt", b)).toString("utf8")).toBe("안녕\n");
    await cp.revert(changes[0]!, a);
    expect(fileExists(join(dir, "문서"))).toBe(false);
    expect(await cp.snapshot()).toBe(a);
  });

  it("branchName and remoteURL", async () => {
    const dir = track(makeRepo());
    const cp = await openCheckpoint(dir);
    expect(await cp.branchName()).toBe(sh(dir, "rev-parse", "--abbrev-ref", "HEAD").trim());
    expect(await cp.remoteURL()).toBeNull();
    sh(dir, "remote", "add", "origin", "https://example.com/x/y.git");
    expect(await cp.remoteURL()).toBe("https://example.com/x/y.git");
    sh(dir, "checkout", "-q", "--detach");
    expect(await cp.branchName()).toBeNull();

    const fresh = track(makeTempDir());
    await initRepository(fresh);
    expect(await (await openCheckpoint(fresh)).branchName()).toBeNull(); // unborn branch
  });

  it("failed commands throw GitCommandError with stderr", async () => {
    const dir = track(makeRepo());
    const cp = await openCheckpoint(dir);
    await expect(cp.changes("deadbeef", "deadbeef")).rejects.toBeInstanceOf(GitCommandError);
    const err = await cp.fileContent("nope.txt", EMPTY_TREE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitCommandError);
    expect((err as GitCommandError).message).toMatch(/^git cat-file -p .* failed \(exit 128\)/);
    expect(new GitCheckpoint(cp.root).root).toBe(cp.root);
  });

  it("snapshot sees a same-size edit made in the second the index was written (racy git: the temp index keeps its mtime)", async () => {
    const dir = track(makeRepo());
    const cp = await openCheckpoint(dir);
    // `git add` writes the index, the file changes again right away with the same size (an IDE's git refresh, then
    // Claude's edit): its stat matches the entry, only the index's own mtime says "look again" — a copy stamped now hid it.
    write(dir, "a.txt", "a = 1\n");
    sh(dir, "add", "a.txt");
    write(dir, "a.txt", "a = 3\n");
    await new Promise((r) => setTimeout(r, 1100));
    const tree = await cp.snapshot();
    expect(sh(dir, "show", `${tree}:a.txt`)).toBe("a = 3\n");
    // The user's real index is untouched.
    expect(sh(dir, "show", ":a.txt")).toBe("a = 1\n");
  });

  it("snapshot excludes ignorePatterns from the tree via a one-off core.excludesFile", async () => {
    const dir = track(makeRepo());
    const cp = await openCheckpoint(dir);
    write(dir, "keep.txt", "keep\n");
    mkdirSync(join(dir, ".omc/state/session-end-jobs"), { recursive: true });
    writeFileSync(join(dir, ".omc/state/session-end-jobs/.result.json.tmp.1"), "{}");

    const tree = await cp.snapshot([".omc/"]);
    const names = sh(dir, "ls-tree", "-r", "--name-only", tree).split("\n").filter(Boolean);
    expect(names).toContain("keep.txt");
    expect(names.some((n) => n.startsWith(".omc/"))).toBe(false);

    // without ignorePatterns the excluded file is included as usual
    const full = await cp.snapshot();
    const fullNames = sh(dir, "ls-tree", "-r", "--name-only", full).split("\n").filter(Boolean);
    expect(fullNames.some((n) => n.startsWith(".omc/"))).toBe(true);
  });

  it("snapshot excludes an ignorePattern that is ALSO gitignored, without throwing (user's reported bug)", async () => {
    // `git add -A -- . :(exclude).omc` fails with exit 1 ("paths are ignored by one of your
    // .gitignore files") whenever the excluded path is also gitignored. The `core.excludesFile`
    // approach used by `snapshot()` must not hit that failure mode.
    const dir = track(makeRepo());
    write(dir, ".gitignore", ".omc/\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "gitignore");
    const cp = await openCheckpoint(dir);

    write(dir, "keep.txt", "keep\n");
    mkdirSync(join(dir, ".omc/state/session-end-jobs"), { recursive: true });
    writeFileSync(join(dir, ".omc/state/session-end-jobs/.result.json.tmp.1"), "{}");

    const tree = await cp.snapshot([".omc/"]);
    const names = sh(dir, "ls-tree", "-r", "--name-only", tree).split("\n").filter(Boolean);
    expect(names).toContain("keep.txt");
    expect(names).toContain(".gitignore");
    expect(names.some((n) => n.startsWith(".omc/"))).toBe(false);
  });

  it("snapshot strips a stale index entry under an ignorePattern (temp index seeded from a real index that already tracked it)", async () => {
    const dir = track(makeRepo());
    // simulate a file under the excluded prefix that was already committed before the pattern
    // was adopted, so the real index (and thus the copied temp index) already has an entry for it.
    mkdirSync(join(dir, ".omc/state"), { recursive: true });
    writeFileSync(join(dir, ".omc/state/x.json"), "{}");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "stale .omc entry");
    const cp = await openCheckpoint(dir);

    // modify the already-tracked excluded file during the "turn"
    writeFileSync(join(dir, ".omc/state/x.json"), '{"changed":true}');
    write(dir, "keep.txt", "keep\n");

    const tree = await cp.snapshot([".omc/"]);
    const names = sh(dir, "ls-tree", "-r", "--name-only", tree).split("\n").filter(Boolean);
    expect(names).toContain("keep.txt");
    expect(names.some((n) => n.startsWith(".omc/"))).toBe(false);

    // the real repo's tracked file and index are untouched
    expect(read(dir, ".omc/state/x.json")).toBe('{"changed":true}');
    expect(sh(dir, "status", "--porcelain")).toContain("M .omc/state/x.json");
  });

  it("snapshot retries `add -A` on a transient 'unable to stat' failure then succeeds", async () => {
    const dir = track(makeRepo());
    const cp = await openCheckpoint(dir);
    write(dir, "a.txt", "a\n");

    const real = cp.git.bind(cp);
    let addCalls = 0;
    const spy = vi.spyOn(cp, "git").mockImplementation((args: string[], opts) => {
      if (args[0] === "add" && addCalls++ === 0) {
        return Promise.reject(
          new GitCommandError(
            "git add -A",
            "error: unable to stat '.omc/state/session-end-jobs/x/.result.json.tmp.1': No such file or directory",
            128,
          ),
        );
      }
      return real(args, opts);
    });

    const tree = await cp.snapshot();
    expect(tree).toHaveLength(40);
    expect(addCalls).toBe(2);
    const names = sh(dir, "ls-tree", "-r", "--name-only", tree).split("\n").filter(Boolean);
    expect(names).toContain("a.txt");

    spy.mockRestore();
  });
});
