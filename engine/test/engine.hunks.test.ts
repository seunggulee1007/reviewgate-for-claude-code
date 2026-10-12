import { chmodSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hunkRanges, revertHunks, splitLinesKeepEol } from "../src/diff/hunks.js";
import { parseUnifiedDiff } from "../src/diff/parse.js";
import { openCheckpoint } from "../src/git/checkpoint.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** 30 numbered lines: three hunks are far enough apart (> 6 lines) to stay separate. */
const BASE = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const text = (lines: string[], eol = "\n", finalEol = true) => lines.join(eol) + (finalEol ? eol : "");
const edited = (lines: string[]) => lines.map((l, i) => (i === 1 ? "two!" : i === 14 ? "fifteen!" : i === 27 ? "twenty-eight!" : l));

function makeRepo(files: Record<string, string | Buffer> = {}, config: [string, string][] = []): string {
  const dir = realpathSync(makeTempDir("rg-hunks"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  // Git for Windows defaults to core.symlinks=false (symlinks checked out as files); these tests expect real ones.
  if (process.platform === "win32" && CAN_SYMLINK) sh(dir, "config", "core.symlinks", "true");
  write(dir, "f.txt", text(BASE));
  write(dir, "gone.txt", "bye\n");
  write(dir, "bin.dat", Buffer.from([0, 1, 2, 3, 0, 5]));
  for (const [k, v] of Object.entries(files)) write(dir, k, v);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  for (const [k, v] of config) sh(dir, "config", k, v);
  return dir;
}

async function reviewing(dir: string, mutate: () => void): Promise<Harness> {
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  await h.engine.handle({ type: "send", text: "edit" });
  mutate();
  h.session().emitTurnEnd();
  await h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.turnEndTree !== null, "reviewing");
  return h;
}

const raw = (dir: string, rel: string) => readFileSync(join(dir, rel));

/** Capability probes (Windows runners: symlinks need the privilege; chmod cannot set the exec bit). */
function probe(fn: (dir: string) => boolean): boolean {
  const dir = makeTempDir("rg-probe");
  try {
    return fn(dir);
  } catch {
    return false;
  } finally {
    removeDir(dir);
  }
}
const CAN_SYMLINK = probe((d) => {
  writeFileSync(join(d, "t"), "x");
  symlinkSync("t", join(d, "l"));
  return lstatSync(join(d, "l")).isSymbolicLink();
});
const CAN_CHMOD = probe((d) => {
  writeFileSync(join(d, "t"), "x");
  chmodSync(join(d, "t"), 0o755);
  return (statSync(join(d, "t")).mode & 0o111) !== 0;
});

describe("hunk splice (pure)", () => {
  it("hunk header ranges and line splitting keep every byte", () => {
    expect(hunkRanges("@@ -3,7 +3,8 @@ ctx")).toEqual([3, 7, 3, 8]);
    expect(hunkRanges("@@ -1 +1 @@")).toEqual([1, 1, 1, 1]);
    expect(hunkRanges("@@ -0,0 +1,2 @@")).toEqual([0, 0, 1, 2]);
    expect(splitLinesKeepEol(Buffer.from("a\r\nb\nc")).map((b) => b.toString())).toEqual(["a\r\n", "b\n", "c"]);
    expect(splitLinesKeepEol(Buffer.alloc(0))).toEqual([]);
  });

  it("pure insertion / deletion hunks (zero counts) revert at the right place", () => {
    const oldBuf = Buffer.from(text(BASE));
    const lines = [...BASE];
    lines.splice(3, 0, "inserted");
    lines.splice(21, 1);
    const newBuf = Buffer.from(text(lines));
    const patch = `@@ -3,0 +4 @@\n+inserted\n@@ -21 +21,0 @@\n-line 21\n`;
    const diff = parseUnifiedDiff(patch);
    expect(revertHunks(oldBuf, newBuf, diff.hunks, new Set([0])).toString()).toBe(text(BASE.filter((_, i) => i !== 20)));
    const keepInsert = [...BASE];
    keepInsert.splice(3, 0, "inserted");
    expect(revertHunks(oldBuf, newBuf, diff.hunks, new Set([1])).toString()).toBe(text(keepInsert));
    expect(revertHunks(oldBuf, newBuf, diff.hunks, new Set([0, 1])).toString()).toBe(text(BASE));
  });

  it("a diff that does not describe the contents is refused", () => {
    const diff = parseUnifiedDiff("@@ -2 +2 @@\n-line 2\n+two!\n");
    expect(() => revertHunks(Buffer.from(text(BASE)), Buffer.from(text(BASE)), diff.hunks, new Set([0]))).toThrow(/new side/);
  });
});

describe("reject_hunks (§17)", () => {
  it("reverts only the selected hunk; the file stays pending + partial with a refreshed diff", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => write(dir, "f.txt", text(edited(BASE))));
    const before = await h.engine.request({ type: "select_file", path: "f.txt" });
    expect(before.diff.hunks).toHaveLength(3);
    const endBefore = h.engine.state.gate.turnEndTree!;
    // The diff names the B it was computed for: what the client echoes as expectedEndTree.
    expect(before.endTree).toBe(endBefore);

    await h.engine.request({ type: "reject_hunks", path: "f.txt", hunks: [1], expectedEndTree: endBefore });
    const expected = edited(BASE);
    expected[14] = "line 15";
    expect(raw(dir, "f.txt").toString()).toBe(text(expected));
    const s = h.engine.state;
    expect(s.gate.turnEndTree).not.toBe(endBefore);
    expect(s.gate.phase).toBe("reviewing");
    expect(s.changedFiles).toHaveLength(1);
    expect(s.changedFiles[0]).toMatchObject({ path: "f.txt", state: "pending", partial: true, rejectedHunks: 1, added: 2, deleted: 2 });
    const after = await h.engine.request({ type: "select_file", path: "f.txt" });
    expect(after.endTree).toBe(s.gate.turnEndTree);
    expect(after.diff.hunks.map((x) => x.lines.filter((l) => l.kind === "add").map((l) => l.text))).toEqual([["two!"], ["twenty-eight!"]]);
    expect(s.gate.lastReviewSummary).toBe("[Review gate] Partially rejected (some hunks reverted on disk, do not redo them unless asked): f.txt.");

    // A stale diff reference is refused; accept is unchanged.
    await expect(h.engine.request({ type: "reject_hunks", path: "f.txt", hunks: [0], expectedEndTree: endBefore })).rejects.toThrow("stale_diff");
    await h.engine.handle({ type: "accept", paths: ["f.txt"] });
    expect(h.engine.state.changedFiles[0]).toMatchObject({ state: "accepted", partial: true });
    await expect(h.engine.request({ type: "reject_hunks", path: "f.txt", hunks: [0] })).rejects.toThrow("not_pending:f.txt");
    await h.engine.request({ type: "commit", message: "kept part" });
    expect(sh(dir, "show", "HEAD:f.txt")).toBe(text(expected));
    // The review round (§14) records the partial reject.
    const [entry] = (await h.engine.request({ type: "review_history" })).entries;
    expect(entry!.files).toEqual([expect.objectContaining({ path: "f.txt", verdict: "accepted", rejectedHunks: 1, committed: true, adds: 2, dels: 2 })]);
  });

  it("selecting every hunk is a whole-file reject", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => write(dir, "f.txt", text(edited(BASE))));
    await h.engine.request({ type: "reject_hunks", path: "f.txt", hunks: [2, 0, 1, 1] });
    expect(raw(dir, "f.txt").toString()).toBe(text(BASE));
    expect(h.engine.state.changedFiles).toEqual([]);
    expect(h.engine.state.gate.phase).toBe("idle");
    expect(h.engine.state.gate.lastReviewSummary).toBe("[Review gate] Rejected (reverted on disk, do not redo unless asked): f.txt.");
  });

  it("refuses binary, added, deleted files, unknown / empty hunk lists — nothing is written", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => {
      write(dir, "f.txt", text(edited(BASE)));
      write(dir, "bin.dat", Buffer.from([0, 9, 9, 9, 0, 5]));
      write(dir, "added.txt", "a\nb\n");
      removeDir(join(dir, "gone.txt"));
    });
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.status, f.isBinary])).toEqual([
      ["added.txt", "A", false],
      ["bin.dat", "M", true],
      ["f.txt", "M", false],
      ["gone.txt", "D", false],
    ]);
    const tree = h.engine.state.gate.turnEndTree;
    await expect(h.engine.request({ type: "reject_hunks", path: "bin.dat", hunks: [0] })).rejects.toThrow("binary_file");
    await expect(h.engine.request({ type: "reject_hunks", path: "added.txt", hunks: [0] })).rejects.toThrow("partial_reject_unsupported:A");
    await expect(h.engine.request({ type: "reject_hunks", path: "gone.txt", hunks: [0] })).rejects.toThrow("partial_reject_unsupported:D");
    await expect(h.engine.request({ type: "reject_hunks", path: "f.txt", hunks: [7] })).rejects.toThrow("unknown_hunk:7");
    await expect(h.engine.request({ type: "reject_hunks", path: "f.txt", hunks: [] })).rejects.toThrow("no_hunks");
    await expect(h.engine.request({ type: "reject_hunks", path: "nope.txt", hunks: [0] })).rejects.toThrow("not_a_changed_file:nope.txt");
    expect(raw(dir, "f.txt").toString()).toBe(text(edited(BASE)));
    expect(h.engine.state.gate.turnEndTree).toBe(tree);
    expect(h.ofType("error")).toEqual([]);
  });

  // Skipped only where the OS cannot create a symlink (Windows without the privilege); a mode-only change
  // then comes from the index (core.fileMode=false), see the test below.
  it.skipIf(!CAN_SYMLINK)("refuses symlinks, submodules and mode-only changes (the file type is never rewritten)", async () => {
    const dir = makeRepo({ "m.sh": text(BASE) });
    symlinkSync("f.txt", join(dir, "link"));
    const sub = join(dir, "sub");
    sh(dir, "init", "-q", "sub");
    sh(sub, "config", "user.email", "t@e.com");
    sh(sub, "config", "user.name", "T");
    write(sub, "s.txt", "1\n");
    sh(sub, "add", "-A");
    sh(sub, "commit", "-qm", "s1");
    sh(dir, "-c", "advice.addEmbeddedRepo=false", "add", "-A");
    sh(dir, "commit", "-qm", "link + sub");
    expect(sh(dir, "ls-tree", "HEAD", "link", "sub").split("\n").map((l) => l.split(" ")[0])).toEqual(["120000", "160000", ""]);
    const h = await reviewing(dir, () => {
      rmSync(join(dir, "link"));
      symlinkSync("gone.txt", join(dir, "link"));
      write(sub, "s.txt", "2\n");
      sh(sub, "commit", "-qam", "s2");
      if (CAN_CHMOD) chmodSync(join(dir, "m.sh"), 0o755);
    });
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.status])).toEqual([
      ["link", "M"],
      ...(CAN_CHMOD ? [["m.sh", "M"]] : []),
      ["sub", "M"],
    ]);
    const tree = h.engine.state.gate.turnEndTree;
    await expect(h.engine.request({ type: "reject_hunks", path: "link", hunks: [0] })).rejects.toThrow("partial_reject_unsupported:symlink");
    await expect(h.engine.request({ type: "reject_hunks", path: "sub", hunks: [0] })).rejects.toThrow("partial_reject_unsupported:submodule");
    if (CAN_CHMOD) await expect(h.engine.request({ type: "reject_hunks", path: "m.sh", hunks: [0] })).rejects.toThrow("partial_reject_unsupported:mode");
    expect(lstatSync(join(dir, "link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "link"))).toBe("gone.txt");
    expect(h.engine.state.gate.turnEndTree).toBe(tree);

    // The whole-file reject restores the symlink itself (old target), not a file holding the target text.
    await h.engine.handle({ type: "reject", paths: CAN_CHMOD ? ["link", "m.sh"] : ["link"] });
    expect(lstatSync(join(dir, "link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "link"))).toBe("f.txt");
    if (CAN_CHMOD) expect(statSync(join(dir, "m.sh")).mode & 0o777).toBe(0o644);
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual(["sub"]);
    expect(h.ofType("error")).toEqual([]);
  });

  it("a mode-only change git records from the index (core.fileMode=false, as on Windows) is refused too", async () => {
    const dir = makeRepo({ "m.sh": text(BASE) }, [["core.fileMode", "false"]]);
    const h = await reviewing(dir, () => sh(dir, "update-index", "--chmod=+x", "m.sh"));
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.status])).toEqual([["m.sh", "M"]]);
    const tree = h.engine.state.gate.turnEndTree;
    await expect(h.engine.request({ type: "reject_hunks", path: "m.sh", hunks: [0] })).rejects.toThrow("partial_reject_unsupported:mode");
    expect(h.engine.state.gate.turnEndTree).toBe(tree);
    expect(raw(dir, "m.sh").toString()).toBe(text(BASE));
  });

  it.skipIf(!CAN_SYMLINK)("writeBlob (the restore fallback) recreates a symlink entry as a symlink", async () => {
    const dir = makeRepo();
    symlinkSync("f.txt", join(dir, "link"));
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "link");
    const cp = await openCheckpoint(dir);
    const tree = sh(dir, "rev-parse", "HEAD^{tree}").trim();
    expect(await cp.treeMode(tree, "link")).toBe("120000");
    expect(await cp.treeMode(tree, "f.txt")).toBe("100644");
    expect(await cp.treeMode(tree, "nope")).toBeNull();
    rmSync(join(dir, "link"));
    write(dir, "link", "not a link");
    await cp.writeBlob("link", tree);
    expect(lstatSync(join(dir, "link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "link"))).toBe("f.txt");
    await expect(cp.writeWorktreeContent("link", Buffer.from("x"))).rejects.toThrow(/not a regular file/);
    expect(readlinkSync(join(dir, "link"))).toBe("f.txt");
  });

  it("refuses when the file was edited after the review was collected (no data loss)", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => write(dir, "f.txt", text(edited(BASE))));
    const mine = text([...edited(BASE), "my own edit"]);
    write(dir, "f.txt", mine);
    await expect(h.engine.request({ type: "reject_hunks", path: "f.txt", hunks: [0] })).rejects.toThrow("file_changed_since_review:f.txt");
    expect(raw(dir, "f.txt").toString()).toBe(mine);
    expect(h.engine.state.changedFiles[0]).not.toHaveProperty("partial");
    expect(h.engine.state.gate.phase).toBe("reviewing");
  });

  it("refused while a turn runs (the H3 lock)", async () => {
    const dir = makeRepo();
    const h = await reviewing(dir, () => write(dir, "f.txt", text(edited(BASE))));
    await h.engine.handle({ type: "send", text: "a question" });
    await expect(h.engine.request({ type: "reject_hunks", path: "f.txt", hunks: [0] })).rejects.toThrow("session_running");
  });

  it("CRLF files keep their line endings byte for byte", async () => {
    const dir = makeRepo({ "w.txt": text(BASE, "\r\n") });
    const h = await reviewing(dir, () => write(dir, "w.txt", text(edited(BASE), "\r\n")));
    await h.engine.request({ type: "reject_hunks", path: "w.txt", hunks: [0, 2] });
    const expected = [...BASE];
    expected[14] = "fifteen!";
    expect(raw(dir, "w.txt").equals(Buffer.from(text(expected, "\r\n")))).toBe(true);
  });

  it("a missing final newline survives; reverting the last hunk restores the original ending", async () => {
    const dir = makeRepo({ "n.txt": text(BASE, "\n", false) });
    const changed = edited(BASE);
    changed[29] = "thirty!";
    const h = await reviewing(dir, () => write(dir, "n.txt", text(changed, "\n", true)));
    const d = await h.engine.request({ type: "select_file", path: "n.txt" });
    expect(d.diff.hunks).toHaveLength(3);
    await h.engine.request({ type: "reject_hunks", path: "n.txt", hunks: [0] });
    const keep = [...changed];
    keep[1] = "line 2";
    expect(raw(dir, "n.txt").toString()).toBe(text(keep, "\n", true));
    await h.engine.request({ type: "reject_hunks", path: "n.txt", hunks: [1] });
    const keep2 = [...keep];
    keep2[27] = "line 28";
    keep2[29] = "line 30";
    expect(raw(dir, "n.txt").toString()).toBe(text(keep2, "\n", false));
    expect(h.engine.state.changedFiles[0]).toMatchObject({ partial: true, rejectedHunks: 2 });
  });

  it("core.autocrlf=true: the worktree keeps CRLF while the blobs are LF; the mode is kept", async () => {
    const dir = makeRepo({ "x.sh": text(BASE) }, [["core.autocrlf", "true"]]);
    chmodSync(join(dir, "x.sh"), 0o755);
    sh(dir, "add", "x.sh");
    // Where chmod cannot set the bit (Windows, core.fileMode=false) the mode lives in the index only.
    if (!CAN_CHMOD) sh(dir, "update-index", "--chmod=+x", "x.sh");
    sh(dir, "commit", "-qm", "exec");
    // As a checkout with autocrlf would leave it.
    write(dir, "x.sh", text(BASE, "\r\n"));
    chmodSync(join(dir, "x.sh"), 0o755);
    // Same blob once cleaned (git status may still flag the stat change).
    expect(sh(dir, "hash-object", "--path=x.sh", "x.sh")).toBe(sh(dir, "rev-parse", "HEAD:x.sh"));
    const h = await reviewing(dir, () => {
      write(dir, "x.sh", text(edited(BASE), "\r\n"));
      chmodSync(join(dir, "x.sh"), 0o755);
    });
    await h.engine.request({ type: "reject_hunks", path: "x.sh", hunks: [1] });
    const expected = edited(BASE);
    expected[14] = "line 15";
    expect(raw(dir, "x.sh").toString()).toBe(text(expected, "\r\n"));
    if (CAN_CHMOD) expect(statSync(join(dir, "x.sh")).mode & 0o777).toBe(0o755);
    expect(sh(dir, "ls-tree", h.engine.state.gate.turnEndTree!, "x.sh").split(" ")[0]).toBe("100755");
    expect(h.engine.state.changedFiles[0]).toMatchObject({ path: "x.sh", partial: true, added: 2, deleted: 2 });
  });

  it(".gitattributes eol=crlf + a clean/smudge filter: the partial revert round-trips through both", async () => {
    const dir = makeRepo();
    // Repository form: LF, "@KEY@"; worktree form: CRLF, "SECRET" (like a keyword-expansion filter).
    // A byte-exact filter in node (MSYS sed on Windows runners is not CR-preserving), outside the repo.
    const tools = realpathSync(makeTempDir("rg-hunks-filter"));
    dirs.push(tools);
    const kw = join(tools, "kw.cjs");
    writeFileSync(
      kw,
      'const [from, to] = process.argv[2] === "clean" ? ["SECRET", "@KEY@"] : ["@KEY@", "SECRET"];\n' +
        "const chunks = [];\n" +
        'process.stdin.on("data", (c) => chunks.push(c));\n' +
        'process.stdin.on("end", () => process.stdout.write(Buffer.from(Buffer.concat(chunks).toString("latin1").split(from).join(to), "latin1")));\n',
    );
    const node = `"${process.execPath.replace(/\\/g, "/")}" "${kw.replace(/\\/g, "/")}"`;
    sh(dir, "config", "filter.kw.clean", `${node} clean`);
    sh(dir, "config", "filter.kw.smudge", `${node} smudge`);
    write(dir, ".gitattributes", "w.txt text eol=crlf filter=kw\n");
    const lines = BASE.map((l, i) => (i % 10 === 4 ? `${l} SECRET` : l));
    write(dir, "w.txt", text(lines, "\r\n"));
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "filtered");
    expect(sh(dir, "cat-file", "-p", "HEAD:w.txt")).toBe(text(lines.map((l) => l.replace("SECRET", "@KEY@"))));
    const changed = edited(lines);
    const h = await reviewing(dir, () => write(dir, "w.txt", text(changed, "\r\n")));
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.added, f.deleted])).toEqual([["w.txt", 3, 3]]);
    await h.engine.request({ type: "reject_hunks", path: "w.txt", hunks: [1] });
    const expected = [...changed];
    expected[14] = lines[14]!; // "line 15 SECRET" — smudged back, CRLF
    expect(raw(dir, "w.txt").equals(Buffer.from(text(expected, "\r\n")))).toBe(true);
    // The worktree file cleans to exactly the new B blob: nothing looks edited, the next reject_hunks is allowed.
    const end = h.engine.state.gate.turnEndTree!;
    expect(sh(dir, "hash-object", "--path=w.txt", "w.txt")).toBe(sh(dir, "rev-parse", `${end}:w.txt`));
    expect(sh(dir, "cat-file", "-p", `${end}:w.txt`)).toBe(text(expected.map((l) => l.replace("SECRET", "@KEY@"))));
    expect(h.engine.state.changedFiles[0]).toMatchObject({ partial: true, added: 2, deleted: 2 });
    await h.engine.request({ type: "reject_hunks", path: "w.txt", hunks: [0] });
    const expected2 = [...expected];
    expected2[1] = lines[1]!;
    expect(raw(dir, "w.txt").equals(Buffer.from(text(expected2, "\r\n")))).toBe(true);
    expect(h.engine.state.changedFiles[0]).toMatchObject({ partial: true, rejectedHunks: 2, added: 1, deleted: 1 });
  });

  it("the partial mark and the summary survive a restart", async () => {
    const dir = makeRepo();
    const a = await reviewing(dir, () => write(dir, "f.txt", text(edited(BASE))));
    await a.engine.request({ type: "reject_hunks", path: "f.txt", hunks: [0] });
    await a.settle();
    await new Promise((r) => setTimeout(r, 200));
    await a.engine.dispose();
    const b = makeHarness();
    harnesses.push(b);
    await b.hello();
    const s = await b.open(dir);
    expect(s.gate.restored).toBe(true);
    expect(s.changedFiles[0]).toMatchObject({ path: "f.txt", partial: true, rejectedHunks: 1, state: "pending" });
    expect(s.gate.lastReviewSummary).toContain("Partially rejected");
  });
});
