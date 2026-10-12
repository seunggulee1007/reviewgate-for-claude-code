// MARK: wave4c w4c-trust — §41.2 (comp-21): the auto-accept rules as one pure function — each rule, and everything no rule
// may ever accept.
import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/git/checkpoint.js";
import type { LastTest } from "../src/protocol.js";
import { autoAcceptBlock, lockfileManifests, normalizeAutoAcceptRules, planAutoAccept, type TrustContext } from "../src/review/trust.js";

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  oldPath: null,
  status: "M",
  added: 3,
  deleted: 1,
  isBinary: false,
  tools: ["Edit"],
  toolUseIds: ["t1"],
  state: "pending",
  ...over,
});

const passed: LastTest = { verdict: "pass", command: "./mvnw -q test", toolUseId: "b1", at: "2026-10-24T00:00:00Z", afterLastEdit: true, runs: 1 };
const all = { whitespace: true, lockfile: true, tests: true };
const ctx = (over: Partial<TrustContext> = {}): TrustContext => ({ rules: all, lastTest: passed, rejectedBefore: new Set(), noted: new Set(), ...over });

describe("planAutoAccept — the rules (§41.2)", () => {
  it("accepts a whitespace-only file", () => {
    expect(planAutoAccept([file("src/main/java/a/Svc.java", { whitespaceOnly: true })], ctx())).toEqual([{ path: "src/main/java/a/Svc.java", rule: "whitespace" }]);
  });

  it("does not take whitespace for nothing where it carries meaning (Python, YAML, Makefile) or in a rename", () => {
    for (const p of ["tools/gen.py", "deploy/values.yaml", "conf/app.yml", "Makefile", "build/rules.mk", "ui/page.pug"]) {
      expect(planAutoAccept([file(p, { whitespaceOnly: true })], ctx()), p).toEqual([]);
    }
    expect(planAutoAccept([file("src/B.java", { status: "R", oldPath: "src/A.java", whitespaceOnly: true })], ctx())).toEqual([]);
  });

  it("accepts a test file when the turn's last test passed after its last edit", () => {
    const files = [file("src/test/java/a/SvcTest.java"), file("src/test/java/a/SvcTests.java"), file("web/a.test.ts"), file("web/b.spec.ts"), file("src/main/java/a/Svc.java")];
    expect(planAutoAccept(files, ctx()).map((f) => [f.path, f.rule])).toEqual([
      ["src/test/java/a/SvcTest.java", "tests"],
      ["src/test/java/a/SvcTests.java", "tests"],
      ["web/a.test.ts", "tests"],
      ["web/b.spec.ts", "tests"],
    ]);
  });

  it("keeps a test file when the test failed, ran before the last edit, or did not run", () => {
    const t = [file("src/test/java/a/SvcTest.java")];
    expect(planAutoAccept(t, ctx({ lastTest: { ...passed, verdict: "fail" } }))).toEqual([]);
    expect(planAutoAccept(t, ctx({ lastTest: { ...passed, afterLastEdit: false } }))).toEqual([]);
    expect(planAutoAccept(t, ctx({ lastTest: null }))).toEqual([]);
  });

  it("accepts a lockfile with its accepted manifest in the same folder (also one a rule accepts in the same pass)", () => {
    const pkg = file("web/package.json", { state: "accepted" });
    expect(planAutoAccept([pkg, file("web/package-lock.json")], ctx())).toEqual([{ path: "web/package-lock.json", rule: "lockfile" }]);
    expect(planAutoAccept([file("web/package.json"), file("web/yarn.lock")], ctx())).toEqual([]);
    expect(planAutoAccept([file("package.json", { state: "accepted" }), file("web/pnpm-lock.yaml")], ctx())).toEqual([]);
    expect(planAutoAccept([file("app/build.gradle", { state: "accepted" }), file("app/gradle.lockfile")], ctx())).toEqual([{ path: "app/gradle.lockfile", rule: "lockfile" }]);
    expect(planAutoAccept([file("web/package.json", { whitespaceOnly: true }), file("web/package-lock.json")], ctx()).map((f) => f.rule)).toEqual(["whitespace", "lockfile"]);
    expect(lockfileManifests("a/b/yarn.lock")).toEqual(["a/b/package.json"]);
    expect(lockfileManifests("gradle.lockfile")).toEqual(["build.gradle", "build.gradle.kts"]);
    expect(lockfileManifests("lockfile.json")).toEqual(["pom.xml"]);
    expect(lockfileManifests("src/Svc.java")).toEqual([]);
  });

  it("only applies the rules that are on (default: none) and `only`", () => {
    const files = [file("a/Svc.java", { whitespaceOnly: true }), file("src/test/java/SvcTest.java")];
    expect(planAutoAccept(files, ctx({ rules: {} }))).toEqual([]);
    expect(planAutoAccept(files, ctx({ rules: normalizeAutoAcceptRules(undefined) }))).toEqual([]);
    expect(planAutoAccept(files, ctx({ rules: { tests: true } })).map((f) => f.rule)).toEqual(["tests"]);
    expect(planAutoAccept(files, ctx({ only: ["lockfile"] }))).toEqual([]);
    expect(normalizeAutoAcceptRules({ whitespace: true, tests: "yes", other: true })).toEqual({ whitespace: true });
  });
});

describe("autoAcceptBlock — what no rule ever accepts (§41.2)", () => {
  const ws = (path: string, over: Partial<ChangedFile> = {}) => file(path, { whitespaceOnly: true, ...over });
  it("risk badges: settings, SQL, schema, CI, permission, sensitive, deleted", () => {
    expect(autoAcceptBlock(ws("src/main/resources/application.properties"), ctx())).toBe("risk");
    expect(autoAcceptBlock(ws("src/main/resources/mapper/UserMapper.xml"), ctx())).toBe("risk");
    expect(autoAcceptBlock(ws("db/migration/V1__init.sql"), ctx())).toBe("risk");
    expect(autoAcceptBlock(ws("Jenkinsfile"), ctx())).toBe("risk");
    expect(autoAcceptBlock(ws("bin/run.sh", { oldMode: "100644", newMode: "100755" }), ctx())).toBe("risk");
    expect(autoAcceptBlock(ws(".github/workflows/ci.yml"), ctx())).toBe("risk");
    expect(autoAcceptBlock(file("src/test/java/SvcTest.java", { status: "D" }), ctx())).toBe("risk");
    expect(planAutoAccept([file("src/test/java/SvcTest.java", { status: "D" })], ctx())).toEqual([]);
  });

  it("Claude Code's own files (.claude/, CLAUDE.md, .mcp.json)", () => {
    expect(autoAcceptBlock(ws(".claude/settings.json"), ctx())).toBe("mods");
    expect(autoAcceptBlock(ws("CLAUDE.md"), ctx())).toBe("mods");
  });

  it("a change outside the edit tools: Bash (even with an edit), an MCP tool, nothing of Claude's", () => {
    expect(autoAcceptBlock(ws("a/Svc.java", { tools: ["Bash"] }), ctx())).toBe("bash");
    expect(autoAcceptBlock(ws("a/Svc.java", { tools: ["Bash", "Edit"], toolUseIds: ["b", "e"] }), ctx())).toBe("bash");
    expect(autoAcceptBlock(file("web/package-lock.json", { tools: ["Bash"] }), ctx())).toBe("bash");
    expect(planAutoAccept([file("web/package.json", { state: "accepted" }), file("web/package-lock.json", { tools: ["Bash"] })], ctx())).toEqual([]);
    expect(autoAcceptBlock(ws("a/Svc.java", { tools: ["mcp__filesystem__write_file"] }), ctx())).toBe("mcp");
    expect(autoAcceptBlock(ws("a/Svc.java", { tools: [], toolUseIds: [] }), ctx())).toBe("external");
    expect(autoAcceptBlock(ws("a/Svc.java", { tools: ["Edit"], toolUseIds: [] }), ctx())).toBe("external");
  });

  it("a large file (§39.1), an uncaptured one, a partly rejected one, one with notes, one rejected before", () => {
    expect(autoAcceptBlock(ws("a/dump.bin", { tooLarge: true, uncaptured: true }), ctx())).toBe("large");
    expect(autoAcceptBlock(ws("a/x.java", { uncaptured: true }), ctx())).toBe("uncaptured");
    expect(autoAcceptBlock(ws("a/x.java", { partial: true, rejectedHunks: 1 }), ctx())).toBe("partial");
    expect(autoAcceptBlock(ws("a/x.java"), ctx({ noted: new Set(["a/x.java"]) }))).toBe("notes");
    expect(autoAcceptBlock(ws("a/x.java"), ctx({ rejectedBefore: new Set(["a/x.java"]) }))).toBe("rejected_before");
    expect(autoAcceptBlock(ws("a/y.java", { status: "R", oldPath: "a/x.java" }), ctx({ rejectedBefore: new Set(["a/x.java"]) }))).toBe("rejected_before");
    expect(autoAcceptBlock(ws("a/x.java", { state: "accepted" }), ctx())).toBe("not_pending");
    expect(autoAcceptBlock(ws("a/x.java"), ctx())).toBeNull();
  });
});
