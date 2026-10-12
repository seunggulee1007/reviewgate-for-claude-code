import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_HANDOFF_FILE } from "../src/review/planHandoff.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** MARK: wave4d w4d-plan — docs/PROTOCOL.md §42.1: plans you can review and follow. */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-w4dplan"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "line1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string) => (dirs.push(d), d);
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const PLAN = "# DB\n\n1. Update `FooService.java`\n2. Add the mapper\n   - FooMapper.xml\n3. Run the tests\n";

/** A plan file under a fake `<home>/.claude/plans/`. */
function planFile(content = PLAN): string {
  const home = track(realpathSync(makeTempDir("rg-w4dhome")));
  mkdirSync(join(home, ".claude", "plans"), { recursive: true });
  const file = join(home, ".claude", "plans", "db.md");
  writeFileSync(file, content, "utf8");
  return file;
}

async function proposed(repo = track(makeRepo())): Promise<{ h: Harness; repo: string; file: string }> {
  const h = harness();
  await h.hello();
  await h.open(repo);
  await h.engine.request({ type: "set_permission_mode", mode: "plan" });
  const file = planFile();
  await h.engine.handle({ type: "send", text: "Plan the DB migration" });
  await h.waitFor((s) => s.gate.phase === "running", "turn running");
  h.session().emitTurnEnd({ planFiles: [file] });
  await h.waitFor((s) => s.session.pendingPlan !== null && s.gate.phase !== "collecting", "plan proposed");
  return { h, repo, file };
}

/** One turn that writes `files` (repo-relative) through Write calls, with `before` run while it runs. */
async function editTurn(h: Harness, repo: string, text: string, files: string[], opts: { mentions?: string[]; before?: () => void } = {}): Promise<void> {
  await h.engine.request({ type: "send", text, ...(opts.mentions ? { mentions: opts.mentions } : {}) });
  await h.waitFor((s) => s.gate.phase === "running", "turn running");
  opts.before?.();
  const s = h.session();
  files.forEach((f, i) => {
    s.emit({ type: "tool_use", id: `w${i}`, name: "Write", input: { file_path: join(repo, f) }, file: join(repo, f) });
    write(repo, f, `${f}\n`);
    s.emit({ type: "tool_result", toolUseId: `w${i}`, isError: false, preview: "ok" });
  });
  s.emitTurnEnd({ toolFiles: files.map((f, i) => ({ path: join(repo, f), tools: ["Write"], count: 1, toolUseIds: [`w${i}`] })) });
  await h.waitFor((st) => st.gate.phase === "reviewing", "reviewing");
  await h.settle();
}

describe("§42.1 plans you can review (market-08)", () => {
  it("a proposed plan lists its steps for per-step notes (event and state)", async () => {
    const { h } = await proposed();
    const steps = [{ index: 0, text: "Update FooService.java" }, { index: 1, text: "Add the mapper" }, { index: 2, text: "Run the tests" }];
    expect(h.ofType("plan_proposed")[0]!.steps).toEqual(steps);
    expect(h.engine.state.session.pendingPlan!.steps).toEqual(steps);
  });

  it("into new_chat: a fresh chat in the approved mode gets the plan's path as its first message and follows the plan", async () => {
    const { h, repo, file } = await proposed();
    const before = h.engine.state.sessions.currentId;
    await h.engine.request({ type: "plan_response", approve: true, mode: "acceptEdits", into: "new_chat" });
    const s = h.engine.state;
    expect(s.sessions.currentId).not.toBe(before);
    expect(s.sessions.list).toHaveLength(2);
    expect(s.session.permissionMode).toBe("acceptEdits");
    expect(s.session.pendingPlan).toBeNull();
    // The fresh chat's CLI started in the approved mode and got the path as its first message (the old one got nothing).
    expect(h.sessions).toHaveLength(2);
    expect(h.session().opts.settings.permissionMode).toBe("acceptEdits");
    expect(h.sessions[0]!.sends).toHaveLength(1);
    expect(h.session().sends.map((x) => x.text)).toEqual([`Implement the approved plan at ${file} (it was made in an earlier chat — read it first). Work in small units and stop after each unit for review.`]);
    expect(h.ofType("plan_approved").at(-1)).toMatchObject({ mode: "acceptEdits", path: file, into: "new_chat" });
    expect(s.session.planSource).toMatchObject({ kind: "approved", path: file });
    // Its summary checks the plan.
    const sess = h.session();
    sess.emit({ type: "tool_use", id: "e1", name: "Write", input: { file_path: join(repo, "src/FooService.java") }, file: join(repo, "src/FooService.java") });
    write(repo, "src/FooService.java", "class FooService {}\n");
    sess.emit({ type: "tool_result", toolUseId: "e1", isError: false, preview: "ok" });
    sess.emitTurnEnd({ toolFiles: [{ path: join(repo, "src/FooService.java"), tools: ["Write"], count: 1, toolUseIds: ["e1"] }] });
    await h.waitFor((st) => st.gate.phase === "reviewing", "reviewing");
    await h.settle();
    const plan = h.ofType("turn_summary").at(-1)!.plan!;
    expect(plan.source).toBe("approved");
    expect(plan.steps[0]!.files).toEqual(["src/FooService.java"]);
  });

  it("into new_chat is checked like a chat switch: notes waiting refuse it and nothing changes", async () => {
    const { h } = await proposed();
    const before = h.engine.state.sessions.currentId;
    await expect(h.engine.request({ type: "plan_response", approve: true, into: "new_chat", mode: "plan" })).rejects.toThrow("invalid_mode");
    expect(h.engine.state.sessions.currentId).toBe(before);
    expect(h.engine.state.session.pendingPlan).not.toBeNull();
    expect(h.engine.state.session.permissionMode).toBe("plan");
  });

  it("into workbench: the plan goes to that worktree once — its window implements it in a fresh chat; this chat stays in plan mode", async () => {
    const repo = track(makeRepo());
    const wt = track(realpathSync(makeTempDir("rg-w4dwt")));
    removeDir(wt);
    sh(repo, "worktree", "add", "-q", "-b", "feat/db", wt);
    const { h, file } = await proposed(repo);
    await expect(h.engine.request({ type: "plan_response", approve: true, into: "workbench", path: repo })).rejects.toThrow("same_worktree");
    await h.engine.request({ type: "plan_response", approve: true, into: "workbench", path: wt });
    expect(h.engine.state.session.pendingPlan).toBeNull();
    expect(h.engine.state.session.permissionMode).toBe("plan");
    expect(h.session().sends).toHaveLength(1); // nothing sent here
    expect(h.ofType("plan_approved").at(-1)).toMatchObject({ mode: "plan", path: file, into: "workbench", target: wt });
    const gitDir = sh(wt, "rev-parse", "--absolute-git-dir").trim();
    expect(existsSync(join(gitDir, "reviewgate", PLAN_HANDOFF_FILE))).toBe(true);

    const t = harness();
    await t.hello();
    await t.open(wt);
    await t.waitFor(() => t.session().sends.length === 1, "the plan's follow-up");
    expect(t.session().sends[0]!.text).toContain(`Implement the approved plan at ${file}`);
    expect(t.session().opts.settings.permissionMode).toBe("default");
    expect(t.engine.state.session.planSource).toMatchObject({ kind: "approved", path: file });
    expect(t.ofType("plan_approved").at(-1)).toMatchObject({ into: "workbench", from: repo, mode: "default" });
    expect(existsSync(join(gitDir, "reviewgate", PLAN_HANDOFF_FILE))).toBe(false);
  });
});

describe("§42.1 plan vs actual without an approved plan (comp-17)", () => {
  async function opened(): Promise<{ h: Harness; repo: string }> {
    const repo = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(repo);
    return { h, repo };
  }

  it("a plan file the chat names is the plan (an .omc/plans file, read at every summary)", async () => {
    const { h, repo } = await opened();
    write(repo, ".omc/plans/db.md", PLAN);
    await editTurn(h, repo, "계획은 .omc/plans/db.md 에 있어요. 1단계부터 해 주세요", ["src/FooService.java", "src/Other.java"]);
    const plan = h.ofType("turn_summary").at(-1)!.plan!;
    expect(plan).toMatchObject({ source: "file", path: join(repo, ".omc/plans/db.md"), title: "db.md", unplannedFiles: ["src/Other.java"] });
    expect(plan.steps.map((s) => s.files)).toEqual([["src/FooService.java"], [], []]);
    expect(h.engine.state.session.planSource).toMatchObject({ kind: "file", path: ".omc/plans/db.md", candidates: [".omc/plans/db.md"] });
  });

  it("Claude's TodoWrite list is the plan when no plan file is named", async () => {
    const { h, repo } = await opened();
    await editTurn(h, repo, "FooService 를 고쳐 주세요", ["src/FooService.java", "src/Other.java"], {
      before: () => h.session().emit({ type: "tool_use", id: "td1", name: "TodoWrite", input: { todos: [{ content: "Fix FooService.java", status: "completed" }, { content: "Add tests", status: "pending" }] } }),
    });
    const plan = h.ofType("turn_summary").at(-1)!.plan!;
    expect(plan.source).toBe("todos");
    expect(plan.steps).toEqual([{ index: 0, text: "Fix FooService.java", done: true, files: ["src/FooService.java"] }, { index: 1, text: "Add tests", done: false, files: [] }]);
    expect(plan.unplannedFiles).toEqual(["src/Other.java"]);
  });

  it("the first message's numbered list is the plan, else its @mentioned files are the request's scope", async () => {
    const { h, repo } = await opened();
    await editTurn(h, repo, "이렇게 해 주세요\n1. FooService.java 수정\n2. FooMapper.xml 추가\n", ["src/FooService.java"]);
    expect(h.ofType("turn_summary").at(-1)!.plan).toMatchObject({ source: "message", unplannedFiles: [] });

    const other = await opened();
    write(other.repo, "src/FooService.java", "x\n");
    sh(other.repo, "add", "-A");
    sh(other.repo, "commit", "-qm", "svc");
    await editTurn(other.h, other.repo, "@src/FooService.java 의 버그를 고쳐 주세요.", ["src/FooService.java", "src/FooServiceTest.java", "web/page.jsp"], { mentions: ["src/FooService.java"] });
    const scope = other.h.ofType("turn_summary").at(-1)!.plan!;
    expect(scope).toMatchObject({ source: "request", title: "@src/FooService.java 의 버그를 고쳐 주세요.", unplannedFiles: ["web/page.jsp"] });
    expect(other.h.engine.state.session.planSource).toMatchObject({ kind: "request" });
  });

  it("a chat without any of them has no plan section, as before", async () => {
    const { h, repo } = await opened();
    await editTurn(h, repo, "고쳐 주세요", ["src/a.ts"]);
    expect(h.ofType("turn_summary").at(-1)!.plan).toBeNull();
    expect(h.engine.state.session.planSource).toBeUndefined();
  });

  it("plan_follow chooses a plan file for the chat (kept with it), refuses what is no Markdown file, null goes back", async () => {
    const { h, repo } = await opened();
    write(repo, "docs/rollout-plan.md", "1. Change `a.ts`\n2. Later\n");
    await expect(h.engine.request({ type: "plan_follow", path: "docs/missing-plan.md" })).rejects.toThrow("invalid_plan_file");
    await expect(h.engine.request({ type: "plan_follow", path: "README.md.txt" })).rejects.toThrow("invalid_plan_file");
    await h.engine.request({ type: "plan_follow", path: "docs/rollout-plan.md" });
    await h.settle();
    expect(h.engine.state.session.planSource).toMatchObject({ kind: "file", path: "docs/rollout-plan.md", chosen: true });
    const meta = h.engine.state.sessions.list.find((m) => m.id === h.engine.state.sessions.currentId)!;
    expect(meta.planFile).toBe(join(repo, "docs/rollout-plan.md"));
    await editTurn(h, repo, "go", ["src/a.ts"]);
    expect(h.ofType("turn_summary").at(-1)!.plan).toMatchObject({ source: "file", title: "rollout-plan.md", unplannedFiles: [] });
    await h.engine.request({ type: "plan_follow", path: null });
    await h.settle();
    expect(h.engine.state.session.planSource?.kind ?? null).not.toBe("file");
  });

  it("the chat's sources come back from its rows after a restart", async () => {
    const { h, repo } = await opened();
    write(repo, ".omc/plans/db.md", PLAN);
    await editTurn(h, repo, "see .omc/plans/db.md", ["src/FooService.java"]);
    await h.engine.request({ type: "accept_all" });
    await h.engine.dispose();
    harnesses.splice(harnesses.indexOf(h), 1);
    const again = harness();
    await again.hello();
    await again.open(repo);
    expect(again.engine.state.session.planSource).toMatchObject({ kind: "file", path: ".omc/plans/db.md" });
  });
});
