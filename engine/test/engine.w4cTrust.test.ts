// MARK: wave4c w4c-trust — §41.2: the auto-accept rules through the engine (opt-in per repository, applied at a collection,
// marked, recorded, undone) and [되돌리기] after a reject.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-w4ctrust"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "src/main/java/a/Svc.java", "class Svc {\n  int a() { return 1; }\n}\n");
  write(dir, "src/test/java/a/SvcTest.java", "class SvcTest {\n}\n");
  write(dir, "web/package.json", '{ "name": "web", "version": "1.0.0" }\n');
  write(dir, "web/package-lock.json", '{ "name": "web", "lockfileVersion": 3 }\n');
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function opened(): Promise<{ h: Harness; dir: string }> {
  const dir = makeRepo();
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello({ budget: { maxFiles: 50, maxLines: 5000 } });
  await h.open(dir);
  return { h, dir };
}

const edit = (dir: string, id: string, rel: string) => ({ path: join(dir, rel), tools: ["Edit"], count: 1, toolUseIds: [id] });

describe("auto-accept rules (§41.2)", () => {
  it("are off by default; once on they accept, mark, record and can be put back to pending", async () => {
    const { h, dir } = await opened();
    // Off: nothing is accepted on its own.
    await h.engine.request({ type: "send", text: "reformat" });
    write(dir, "src/main/java/a/Svc.java", "class Svc {\n    int a() { return 1; }\n}\n");
    h.session().emitTurnEnd({ toolFiles: [edit(dir, "e1", "src/main/java/a/Svc.java")] });
    await h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.turnEndTree !== null, "collected");
    expect(h.engine.state.changedFiles[0]).toMatchObject({ path: "src/main/java/a/Svc.java", state: "pending", whitespaceOnly: true });
    expect(h.engine.state.autoAcceptRules).toBeUndefined();

    await h.engine.request({ type: "set_auto_accept", rules: { whitespace: true, tests: true } });
    expect(h.engine.state.autoAcceptRules).toEqual({ whitespace: true, tests: true });
    // Kept for the repository (its common git dir).
    expect(JSON.parse(readFileSync(join(dir, ".git", "reviewgate", "auto-accept.json"), "utf8")).rules).toEqual({ whitespace: true, tests: true });
    // From the next collection: an answer turn that edits the test and runs it after the edit.
    await h.engine.request({ type: "send", text: "add a test" });
    const s = h.session();
    write(dir, "src/test/java/a/SvcTest.java", "class SvcTest {\n  void a() {}\n}\n");
    s.emit({ type: "tool_use", id: "e2", name: "Edit", input: { file_path: join(dir, "src/test/java/a/SvcTest.java") }, file: join(dir, "src/test/java/a/SvcTest.java") });
    s.emit({ type: "tool_result", toolUseId: "e2", isError: false, preview: "ok" });
    s.emit({ type: "tool_use", id: "t1", name: "Bash", input: { command: "./mvnw -q test" } });
    s.emit({ type: "tool_result", toolUseId: "t1", isError: false, preview: "", testOutcome: "pass" });
    s.emitTurnEnd({ toolFiles: [edit(dir, "e2", "src/test/java/a/SvcTest.java")] });
    await h.waitFor((st) => st.gate.phase !== "running" && st.gate.phase !== "collecting" && st.changedFiles.some((f) => f.path.endsWith("SvcTest.java")), "collected again");
    await h.settle();
    const files = h.engine.state.changedFiles;
    expect(files.find((f) => f.path.endsWith("Svc.java") && !f.path.endsWith("SvcTest.java"))).toMatchObject({ state: "accepted", autoAccepted: "whitespace" });
    expect(files.find((f) => f.path.endsWith("SvcTest.java"))).toMatchObject({ state: "accepted", autoAccepted: "tests" });
    expect(h.ofType("turn_summary").at(-1)?.autoAccepted).toEqual([
      { path: "src/main/java/a/Svc.java", rule: "whitespace" },
      { path: "src/test/java/a/SvcTest.java", rule: "tests" },
    ]);

    // [모두 대기로]: pending again, the mark gone, nothing on disk changed.
    await h.engine.request({ type: "auto_accept_undo" });
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state, f.autoAccepted])).toEqual([
      ["src/main/java/a/Svc.java", "pending", undefined],
      ["src/test/java/a/SvcTest.java", "pending", undefined],
    ]);
    expect(readFileSync(join(dir, "src/test/java/a/SvcTest.java"), "utf8")).toContain("void a()");
  });

  it("a lockfile follows its manifest when the user accepts it; Bash-written lockfiles and rejected files never", async () => {
    const { h, dir } = await opened();
    await h.engine.request({ type: "set_auto_accept", rules: { lockfile: true, whitespace: true } });
    await h.engine.request({ type: "send", text: "bump" });
    write(dir, "web/package.json", '{ "name": "web", "version": "1.0.1" }\n');
    write(dir, "web/package-lock.json", '{ "name": "web", "version": "1.0.1", "lockfileVersion": 3 }\n');
    h.session().emitTurnEnd({ toolFiles: [edit(dir, "e1", "web/package.json"), edit(dir, "e2", "web/package-lock.json")] });
    await h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.turnEndTree !== null, "collected");
    expect(h.engine.state.changedFiles.map((f) => f.state)).toEqual(["pending", "pending"]);
    await h.engine.request({ type: "accept", paths: ["web/package.json"] });
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state, f.autoAccepted])).toEqual([
      ["web/package-lock.json", "accepted", "lockfile"],
      ["web/package.json", "accepted", undefined],
    ]);
    // The round records the rule; history keeps it.
    await h.engine.request({ type: "commit", message: "bump", paths: ["web/package.json", "web/package-lock.json"] });
    const hist = (await h.engine.request({ type: "review_history" })) as unknown as { entries: { files: { path: string; autoAccepted?: string }[] }[] };
    expect(hist.entries[0]!.files.find((f) => f.path === "web/package-lock.json")?.autoAccepted).toBe("lockfile");

    // A file rejected once is never accepted by a rule again (here: a whitespace-only redo of a rejected change).
    await h.engine.request({ type: "send", text: "reformat" });
    write(dir, "src/main/java/a/Svc.java", "class Svc {\n    int a() { return 1; }\n}\n");
    h.session().emitTurnEnd({ toolFiles: [edit(dir, "e3", "src/main/java/a/Svc.java")] });
    await h.waitFor((s) => s.changedFiles.length === 1 && s.gate.turnEndTree !== null && s.gate.phase !== "running" && s.gate.phase !== "collecting", "a whitespace change");
    expect(h.engine.state.changedFiles[0]).toMatchObject({ state: "accepted", autoAccepted: "whitespace" });
    await h.engine.request({ type: "auto_accept_undo", paths: ["src/main/java/a/Svc.java"] });
    await h.engine.request({ type: "reject", paths: ["src/main/java/a/Svc.java"] });
    await h.engine.request({ type: "send", text: "again" });
    write(dir, "src/main/java/a/Svc.java", "class Svc {\n      int a() { return 1; }\n}\n");
    h.session().emitTurnEnd({ toolFiles: [edit(dir, "e4", "src/main/java/a/Svc.java")] });
    await h.waitFor((s) => s.changedFiles.length === 1 && s.gate.phase === "reviewing", "redone");
    expect(h.engine.state.changedFiles[0]).toMatchObject({ state: "pending", whitespaceOnly: true });
    expect(h.engine.state.changedFiles[0]!.autoAccepted).toBeUndefined();
  });
});

describe("[되돌리기] after a reject (§41.2)", () => {
  async function reviewOfTwo(): Promise<{ h: Harness; dir: string }> {
    const { h, dir } = await opened();
    await h.engine.request({ type: "send", text: "change" });
    write(dir, "src/main/java/a/Svc.java", "class Svc {\n  int a() { return 2; }\n}\n");
    write(dir, "src/main/java/a/New.java", "class New {}\n");
    h.session().emitTurnEnd({ toolFiles: [edit(dir, "e1", "src/main/java/a/Svc.java"), { path: join(dir, "src/main/java/a/New.java"), tools: ["Write"], count: 1, toolUseIds: ["w1"] }] });
    await h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.turnEndTree !== null, "collected");
    return { h, dir };
  }

  it("puts the proposal back on disk and in the review, its note too; a second reject replaces the offer", async () => {
    const { h, dir } = await reviewOfTwo();
    await h.engine.request({ type: "add_note", path: "src/main/java/a/Svc.java", line: 2, side: "new", excerpt: "return 2", body: "why 2?" });
    await h.engine.request({ type: "reject", paths: ["src/main/java/a/Svc.java"] });
    expect(readFileSync(join(dir, "src/main/java/a/Svc.java"), "utf8")).toContain("return 1");
    expect(h.engine.state.gate.rejectUndo).toEqual({ path: "src/main/java/a/Svc.java", oldPath: null, status: "M", available: true });
    await h.engine.request({ type: "reject_undo", path: "src/main/java/a/Svc.java" });
    expect(readFileSync(join(dir, "src/main/java/a/Svc.java"), "utf8")).toContain("return 2");
    const s = h.engine.state;
    expect(s.gate.rejectUndo).toBeUndefined();
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([
      ["src/main/java/a/New.java", "pending"],
      ["src/main/java/a/Svc.java", "pending"],
    ]);
    expect(s.reviewNotes.map((n) => n.body)).toEqual(["why 2?"]);
    expect(s.gate.lastReviewSummary).toBeNull();
    // An added file: the reject deletes it, [되돌리기] writes it again; another reject ends the first offer.
    await h.engine.request({ type: "reject", paths: ["src/main/java/a/New.java"] });
    expect(existsSync(join(dir, "src/main/java/a/New.java"))).toBe(false);
    await h.engine.request({ type: "reject", paths: ["src/main/java/a/Svc.java"] });
    expect(h.engine.state.gate.rejectUndo?.path).toBe("src/main/java/a/Svc.java");
    await expect(h.engine.request({ type: "reject_undo", path: "src/main/java/a/New.java" })).rejects.toThrow(/reject_undo_unavailable/);
  });

  it("is disabled once the file changed after the reject, and gone when the next turn starts", async () => {
    const { h, dir } = await reviewOfTwo();
    await h.engine.request({ type: "reject", paths: ["src/main/java/a/Svc.java"] });
    write(dir, "src/main/java/a/Svc.java", "class Svc {\n  int a() { return 3; }\n}\n");
    await h.engine.request({ type: "refresh", scope: ["review"] });
    expect(h.engine.state.gate.rejectUndo).toMatchObject({ available: false, reason: "changed_on_disk" });
    await expect(h.engine.request({ type: "reject_undo", path: "src/main/java/a/Svc.java" })).rejects.toThrow(/reject_undo_changed_on_disk/);
    expect(readFileSync(join(dir, "src/main/java/a/Svc.java"), "utf8")).toContain("return 3");
    await h.engine.request({ type: "send", text: "next" });
    expect(h.engine.state.gate.rejectUndo).toBeUndefined();
  });

  it("the reject of the last file completed the round: [되돌리기] reopens it (the history entry goes again)", async () => {
    const { h, dir } = await reviewOfTwo();
    await h.engine.request({ type: "reject", paths: ["src/main/java/a/New.java"] });
    await h.engine.request({ type: "reject", paths: ["src/main/java/a/Svc.java"] });
    expect(h.engine.state.changedFiles).toEqual([]);
    type Hist = { entries: unknown[]; current?: { files: { path: string; verdict: string }[] } };
    let hist = (await h.engine.request({ type: "review_history" })) as unknown as Hist;
    expect(hist.entries).toHaveLength(1);
    await h.engine.request({ type: "reject_undo", path: "src/main/java/a/Svc.java" });
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["src/main/java/a/Svc.java", "pending"]]);
    expect(h.engine.state.gate.phase).toBe("reviewing");
    hist = (await h.engine.request({ type: "review_history" })) as unknown as Hist;
    expect(hist.entries).toHaveLength(0);
    expect(hist.current?.files.map((f) => [f.path, f.verdict])).toEqual([
      ["src/main/java/a/New.java", "rejected"],
      ["src/main/java/a/Svc.java", "pending"],
    ]);
    expect(readFileSync(join(dir, "src/main/java/a/Svc.java"), "utf8")).toContain("return 2");
  });
});
