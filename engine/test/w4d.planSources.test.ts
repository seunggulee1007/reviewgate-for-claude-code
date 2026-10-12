import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTaskTool,
  firstSentence,
  isPlanFilePath,
  messageSteps,
  planCandidates,
  planFilesNamed,
  planStepBriefs,
  readPlanFile,
  requestScope,
  resolvePlanPath,
  todoWriteSteps,
  type TaskItem,
} from "../src/review/planSources.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("§42.1 plan sources (w4d-plan)", () => {
  it("lists a plan's steps for notes, numbered from 0", () => {
    expect(planStepBriefs("# Plan\n\n1. Add the **controller**\n   - FooController.java\n2. Wire the `service`\n")).toEqual([
      { index: 0, text: "Add the controller" },
      { index: 1, text: "Wire the service" },
    ]);
    expect(planStepBriefs("just prose")).toEqual([]);
  });

  it("knows a plan file by its folder or its name", () => {
    for (const p of [".omc/plans/db.md", "docs/db-migration-plan.md", "docs/PLAN.md", "/Users/a/.claude/plans/x.md", "docs\\plans\\a.md", "planning.md"]) {
      expect(isPlanFilePath(p), p).toBe(true);
    }
    for (const p of ["docs/explanation.md", "README.md", ".omc/plans/a.txt", "src/plan.ts"]) expect(isPlanFilePath(p), p).toBe(false);
  });

  it("finds the plan files a message names — @mentions first, Korean particles and punctuation around them", () => {
    expect(planFilesNamed("계획은 .omc/plans/db.md에 있어요. docs/b-plan.md 도 보고, README.md 는 아님", ["docs/a-plan.md"])).toEqual([
      "docs/a-plan.md",
      ".omc/plans/db.md",
      "docs/b-plan.md",
    ]);
    expect(planFilesNamed("see ~/.claude/plans/x.md.")).toEqual(["~/.claude/plans/x.md"]);
    expect(planFilesNamed("https://example.com/plans/x.md")).toEqual([]);
  });

  it("resolves a named plan file against the worktree or the home folder and reads it capped", () => {
    const root = makeTempDir("rg-plansrc");
    dirs.push(root);
    expect(resolvePlanPath(".omc/plans/a.md", root, "/home/u")).toBe(join(root, ".omc/plans/a.md"));
    expect(resolvePlanPath("~/.claude/plans/a.md", root, "/home/u")).toBe(join("/home/u", ".claude/plans/a.md"));
    expect(resolvePlanPath("/abs/plan.md", root, "/home/u")).toBe("/abs/plan.md");
    mkdirSync(join(root, ".omc", "plans"), { recursive: true });
    writeFileSync(join(root, ".omc", "plans", "a.md"), "1. one\n2. two\n");
    expect(readPlanFile(join(root, ".omc", "plans", "a.md"))).toBe("1. one\n2. two\n");
    expect(readPlanFile(join(root, ".omc", "plans", "missing.md"))).toBeNull();
    expect(readPlanFile(join(root, ".omc", "plans"))).toBeNull();
  });

  it("offers the repository's plan files, then the newest of Claude Code's own plans folder", () => {
    const root = makeTempDir("rg-plancand");
    const user = makeTempDir("rg-userplans");
    dirs.push(root, user);
    mkdirSync(join(root, ".omc", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "deep"), { recursive: true });
    writeFileSync(join(root, ".omc", "plans", "old.md"), "x");
    writeFileSync(join(root, ".omc", "plans", "new.md"), "x");
    utimesSync(join(root, ".omc", "plans", "old.md"), new Date(1_000_000), new Date(1_000_000));
    writeFileSync(join(root, "docs", "deep", "rollout-plan.md"), "x");
    writeFileSync(join(root, "docs", "guide.md"), "x");
    writeFileSync(join(user, "u1.md"), "x");
    expect(planCandidates(root, user)).toEqual([
      join(root, ".omc", "plans", "new.md"),
      join(root, ".omc", "plans", "old.md"),
      join(root, "docs", "deep", "rollout-plan.md"),
      join(user, "u1.md"),
    ]);
    expect(planCandidates(root, null)).toHaveLength(3);
  });

  it("reads TodoWrite's list (done = completed) and the Task tools' running list", () => {
    expect(todoWriteSteps({ todos: [{ content: "Edit `FooService.java`", status: "completed", activeForm: "Editing" }, { content: "Run tests", status: "pending" }] })).toEqual([
      { text: "Edit FooService.java", done: true, body: "Edit `FooService.java`\nEditing" },
      { text: "Run tests", done: false, body: "Run tests" },
    ]);
    expect(todoWriteSteps({})).toBeNull();
    let tasks: TaskItem[] = [];
    tasks = applyTaskTool(tasks, "TaskCreate", { subject: "Add mapper", description: "FooMapper.xml" })!;
    tasks = applyTaskTool(tasks, "TaskCreate", { subject: "Add test" })!;
    tasks = applyTaskTool(tasks, "TaskUpdate", { taskId: "1", status: "completed" })!;
    expect(tasks.map((t) => [t.id, t.text, t.done])).toEqual([["1", "Add mapper", true], ["2", "Add test", false]]);
    expect(tasks[0]!.body).toContain("FooMapper.xml");
    expect(applyTaskTool(tasks, "TaskUpdate", { taskId: "2", status: "deleted" })!.map((t) => t.id)).toEqual(["1"]);
    expect(applyTaskTool(tasks, "Read", {})).toBeNull();
  });

  it("takes the first message's numbered list as the plan only with two or more items", () => {
    expect(messageSteps("이렇게 해 주세요\n1. FooController 에 API 추가\n2. FooService 수정\n")?.map((s) => s.text)).toEqual(["FooController 에 API 추가", "FooService 수정"]);
    expect(messageSteps("1. only one")).toBeNull();
    expect(messageSteps("- a\n- b\n")).toBeNull();
  });

  it("without a plan: the request's @mentioned files, their folders and companions are in, the rest is outside the request", () => {
    expect(firstSentence("FooService 의 버그를 고쳐 주세요. 그리고 테스트도.\n두 번째 줄")).toBe("FooService 의 버그를 고쳐 주세요.");
    const files = ["src/a/FooService.java", "src/a/FooServiceTest.java", "src/b/Other.java", "web/x/page.jsp", "README.md"];
    const scope = requestScope("@src/a/FooService.java 고쳐 주세요. README.md 도", ["src/a/FooService.java", "web/x"], files)!;
    expect(scope.source).toBe("request");
    expect(scope.steps[0]!.files).toEqual(["src/a/FooService.java", "src/a/FooServiceTest.java", "web/x/page.jsp", "README.md"]);
    expect(scope.unplannedFiles).toEqual(["src/b/Other.java"]);
    expect(requestScope("고쳐 주세요", [], files)).toBeNull();
  });
});
