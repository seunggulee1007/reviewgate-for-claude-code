// MARK: wave4b w4b-files — §40.2: one risk classification in the engine (comp-12) and what a diff without lines is (comp-11).
import { chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCheckpoint } from "../src/git/checkpoint.js";
import { parseUnifiedDiff } from "../src/diff/parse.js";
import { FILE_RISK_KINDS, FILE_RISK_WEIGHT, fileRiskFields, fileRisks } from "../src/review/fileRisk.js";
import { makeRepo, removeDir, write } from "./helpers/repo.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const file = (path: string, over: Partial<Parameters<typeof fileRisks>[0]> = {}) => ({
  path,
  oldPath: null,
  status: "M" as const,
  added: 3,
  deleted: 1,
  tools: ["Edit"],
  toolUseIds: ["t1"],
  ...over,
});

describe("fileRisks (comp-12)", () => {
  it("knows the Java / Spring risks of an acme turn", () => {
    expect(fileRisks(file("src/main/resources/application.properties"))).toEqual(["settings"]);
    expect(fileRisks(file("src/main/resources/application-dev.yml"))).toEqual(["settings"]);
    expect(fileRisks(file("src/main/resources/messages_ko.properties"))).toEqual(["settings"]);
    expect(fileRisks(file("src/main/resources/mapper/orders/billing/RefundMapper.xml"))).toEqual(["sql"]);
    expect(fileRisks(file("src/main/resources/sqlmap/UserMapper.xml"))).toEqual(["sql"]);
    expect(fileRisks(file("db/migration/V12__add_column.sql"))).toEqual(["schema"]);
    expect(fileRisks(file("src/main/resources/db/changelog/db.changelog-master.yaml"))).toEqual(["schema"]);
    expect(fileRisks(file("scripts/report.sql"))).toEqual(["schema"]);
    expect(fileRisks(file("Jenkinsfile"))).toEqual(["ci"]);
    expect(fileRisks(file("ci/Jenkinsfile.release"))).toEqual(["ci"]);
    expect(fileRisks(file(".gitlab-ci.yml"))).toEqual(["ci"]);
    // CI workflows stay "sensitive" (they run with the repository's secrets) and say why: CI.
    expect(fileRisks(file(".github/workflows/build.yml"))).toEqual(["sensitive", "ci"]);
    expect(fileRisks(file("pom.xml"))).toEqual(["config"]);
    expect(fileRisks(file("src/main/java/com/acme/orders/billing/InvoiceServiceImpl.java"))).toEqual([]);
    // A plain XML / JSP is not SQL.
    expect(fileRisks(file("src/main/webapp/WEB-INF/web.xml"))).toEqual([]);
    expect(fileRisks(file("CHANGELOG.md"))).toEqual([]);
  });

  it("keeps the badges both clients already had", () => {
    expect(fileRisks(file(".claude/settings.json"))).toEqual(["sensitive"]);
    expect(fileRisks(file(".env.local"))).toEqual(["sensitive"]);
    expect(fileRisks(file("a.ts", { status: "D", added: 0, deleted: 4 }))).toEqual(["deleted"]);
    expect(fileRisks(file("a.ts", { added: 200, deleted: 100 }))).toEqual(["large"]);
    expect(fileRisks(file("a.ts", { added: 200, deleted: 99 }))).toEqual([]);
    expect(fileRisks(file("a.ts", { tools: ["Bash"], toolUseIds: ["b1"] }))).toEqual(["bash"]);
    expect(fileRisks(file("a.ts", { tools: ["Bash", "Edit"], toolUseIds: ["b1", "e1"] }))).toEqual([]);
    expect(fileRisks(file("a.ts", { tools: [], toolUseIds: [] }))).toEqual(["external"]);
    expect(fileRisks(file("package-lock.json"))).toEqual(["config"]);
    expect(fileRisks(file("tsconfig.base.json"))).toEqual(["config"]);
    expect(fileRisks(file("src/test/java/com/acme/FooServiceTest.java"))).toEqual(["test"]);
    expect(fileRisks(file("web/src/app.spec.ts"))).toEqual(["test"]);
    expect(fileRisks(file("Tests/CoreTests/FooTests.swift"))).toEqual(["test"]);
    // An old path that was sensitive keeps the badge after a rename.
    expect(fileRisks(file("docs/notes.md", { status: "R", oldPath: "CLAUDE.md" }))).toEqual(["sensitive"]);
  });

  it("flags an executable bit that changed or a new executable file", () => {
    expect(fileRisks(file("run.sh", { oldMode: "100644", newMode: "100755" }))).toEqual(["permission"]);
    expect(fileRisks(file("run.sh", { oldMode: "100755", newMode: "100644" }))).toEqual(["permission"]);
    expect(fileRisks(file("run.sh", { status: "A", newMode: "100755" }))).toEqual(["permission"]);
    expect(fileRisks(file("run.sh", { status: "A", newMode: "100644" }))).toEqual([]);
  });

  it("orders the badges by the shared list and scores a test file below ordinary code", () => {
    const kinds = fileRisks(file("db/migration/V1__init.sql", { status: "D", added: 0, deleted: 400, tools: [], toolUseIds: [] }));
    expect(kinds).toEqual(["deleted", "schema", "large", "external"]);
    expect([...kinds].sort((a, b) => FILE_RISK_KINDS.indexOf(a) - FILE_RISK_KINDS.indexOf(b))).toEqual(kinds);
    expect(FILE_RISK_WEIGHT.test).toBeLessThanOrEqual(0);
    const test = fileRiskFields(file("src/test/java/FooTest.java"));
    const service = fileRiskFields(file("src/main/java/FooService.java"));
    expect(test.riskScore).toBeLessThan(service.riskScore);
    expect(service).toEqual({ risks: [], riskScore: 0 });
    expect(fileRiskFields(file("src/main/resources/mapper/FooMapper.xml")).riskScore).toBeGreaterThan(0);
  });
});

describe("modes, renames and binaries on the wire (comp-11)", () => {
  it("changes() carries the modes of a chmod and the similarity of a rename", async () => {
    if (!posix) return;
    const dir = makeRepo();
    dirs.push(dir);
    write(dir, "run.sh", "echo hi\n");
    write(dir, "src/Old.java", "class Old {\n  int a;\n  int b;\n}\n");
    const cp = await openCheckpoint(dir);
    const a = await cp.snapshot();
    chmodSync(join(dir, "run.sh"), 0o755);
    renameSync(join(dir, "src/Old.java"), join(dir, "src/New.java"));
    const b = await cp.snapshot();
    const files = await cp.changes(a, b);
    const run = files.find((f) => f.path === "run.sh")!;
    expect(run).toMatchObject({ status: "M", added: 0, deleted: 0, oldMode: "100644", newMode: "100755" });
    const moved = files.find((f) => f.path === "src/New.java")!;
    expect(moved).toMatchObject({ status: "R", oldPath: "src/Old.java", similarity: 100 });
    expect(moved.oldMode).toBeUndefined();
    // The patch says the same: a mode-only change and a pure rename have no hunks.
    const runDiff = parseUnifiedDiff(await cp.patch(a, b, "run.sh", null));
    expect(runDiff).toMatchObject({ hunks: [], oldMode: "100644", newMode: "100755" });
    const movedDiff = parseUnifiedDiff(await cp.patch(a, b, "src/New.java", "src/Old.java"));
    expect(movedDiff).toMatchObject({ hunks: [], similarity: 100, oldPath: "src/Old.java", newPath: "src/New.java" });
  });

  it("parses new / deleted file modes and leaves an ordinary diff without them", () => {
    const added = parseUnifiedDiff(["diff --git a/x.sh b/x.sh", "new file mode 100755", "index 0000000..1111111", "--- /dev/null", "+++ b/x.sh", "@@ -0,0 +1 @@", "+echo"].join("\n"));
    expect(added.newMode).toBe("100755");
    expect(added.oldMode).toBeUndefined();
    const plain = parseUnifiedDiff(["diff --git a/x b/x", "index 1111111..2222222 100644", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b"].join("\n"));
    expect(plain.oldMode).toBeUndefined();
    expect(plain.newMode).toBeUndefined();
    expect(plain.similarity).toBeUndefined();
  });

  it("blobSize gives the byte size of a path in a tree, null when it is not there", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const cp = await openCheckpoint(dir);
    const a = await cp.snapshot();
    write(dir, "logo.png", Buffer.alloc(12_288, 1));
    const b = await cp.snapshot();
    expect(await cp.blobSize(b, "logo.png")).toBe(12_288);
    expect(await cp.blobSize(a, "logo.png")).toBeNull();
  });
});
