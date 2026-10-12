import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/git/checkpoint.js";
import { buildTurnSummary, matchPlan, mentionsPath, parsePlanSteps, plainText, type ToolCallInfo } from "../src/review/summary.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

const PLAN = `# Add a CONTRIBUTING guide

Some intro mentioning nothing.

## Steps
1. Create \`CONTRIBUTING.md\` with the review flow
   - link it from README.md
2. Teach **engine/src/review/gate.ts** to expose the summary
3. Add tests
   1. nested numbered item mentions summary.test.ts
- [x] Bump the version in package.json
- [ ] Update docs/PROTOCOL.md

\`\`\`
1. not a step inside a fence
\`\`\`
`;

describe("plan parsing", () => {
  it("finds numbered and checklist steps, nested items stay in their parent's body", () => {
    const steps = parsePlanSteps(PLAN);
    expect(steps.map((s) => [s.text, s.done])).toEqual([
      ["Create CONTRIBUTING.md with the review flow", null],
      ["Teach engine/src/review/gate.ts to expose the summary", null],
      ["Add tests", null],
      ["Bump the version in package.json", true],
      ["Update docs/PROTOCOL.md", false],
    ]);
    expect(steps[0]!.body).toContain("README.md");
    expect(steps[2]!.body).toContain("summary.test.ts");
  });

  it("step headings and the bullet fallback", () => {
    expect(parsePlanSteps("## Step 1: Parse input\ntext about parser.ts\n## Step 2 - Render\n").map((s) => s.text)).toEqual(["Parse input", "Render"]);
    expect(parsePlanSteps("Plan:\n- touch a.ts\n- touch b.ts\n  - sub\n").map((s) => s.text)).toEqual(["touch a.ts", "touch b.ts"]);
    expect(parsePlanSteps("no steps at all")).toEqual([]);
    expect(parsePlanSteps("1) one\r\n2) two\r\n").map((s) => s.text)).toEqual(["one", "two"]);
  });

  it("plainText strips inline markdown", () => {
    expect(plainText("**bold** `code` [link](http://x) __u__")).toBe("bold code link u");
  });
});

describe("path mentions", () => {
  it("full path, sub-path, basename token and distinctive stems", () => {
    expect(mentionsPath("edit engine/src/review/gate.ts", "engine/src/review/gate.ts")).toBe(true);
    expect(mentionsPath("edit src/review/gate.ts", "engine/src/review/gate.ts")).toBe(true);
    expect(mentionsPath("edit `gate.ts`.", "engine/src/review/gate.ts")).toBe(true);
    expect(mentionsPath("edit gate.tsx", "engine/src/review/gate.ts")).toBe(false);
    expect(mentionsPath("update the Summary builder", "engine/src/review/summary.ts")).toBe(true);
    expect(mentionsPath("summarize things", "engine/src/review/summary.ts")).toBe(false);
    // Generic / short stems never match on their own.
    expect(mentionsPath("update the index", "src/index.ts")).toBe(false);
    expect(mentionsPath("fix the gate", "src/gate.ts")).toBe(false);
    expect(mentionsPath("README.MD changes", "README.md")).toBe(true);
  });

  it("matchPlan maps steps to files and lists the unplanned ones", () => {
    const r = matchPlan(parsePlanSteps(PLAN), ["CONTRIBUTING.md", "README.md", "engine/src/review/gate.ts", "engine/src/other.ts"], "/p.md");
    expect(r.path).toBe("/p.md");
    expect(r.steps.map((s) => s.files)).toEqual([["CONTRIBUTING.md", "README.md"], ["engine/src/review/gate.ts"], [], [], []]);
    expect(r.steps[3]).toMatchObject({ index: 3, done: true });
    expect(r.steps[0]).not.toHaveProperty("done");
    expect(r.unplannedFiles).toEqual(["engine/src/other.ts"]);
  });
});

describe("buildTurnSummary", () => {
  const file = (path: string, toolUseIds: string[], extra: Partial<ChangedFile> = {}): ChangedFile => ({
    path, oldPath: null, status: "M", added: 2, deleted: 1, isBinary: false, tools: ["Edit"], toolUseIds, state: "pending", ...extra,
  });

  it("why = the first touching call with a rationale; commands in order with outcomes; no plan → null", () => {
    const calls = new Map<string, ToolCallInfo>([
      ["t1", { name: "Edit" }],
      ["t2", { name: "Edit", rationale: "Rename the helper." }],
      ["b1", { name: "Bash", command: "npm test", isError: false, testOutcome: "pass" }],
      ["b2", { name: "Bash", command: "ls", isError: true, parentToolUseId: "agent-1" }],
    ]);
    const s = buildTurnSummary({ turn: 3, files: [file("a.ts", ["t1", "t2"]), file("b.ts", ["b9"])], calls, commandIds: ["b1", "b2", "gone"], plan: null });
    expect(s.turn).toBe(3);
    expect(s.files[0]).toMatchObject({ path: "a.ts", why: "Rename the helper.", whyToolUseId: "t2", adds: 2, dels: 1, state: "pending", tools: ["Edit"] });
    expect(s.files[1]).toMatchObject({ why: null, whyToolUseId: null });
    expect(s.commands).toEqual([
      { toolUseId: "b1", command: "npm test", isError: false, testOutcome: "pass" },
      { toolUseId: "b2", command: "ls", isError: true, parentToolUseId: "agent-1" },
    ]);
    expect(s.plan).toBeNull();
  });
});

// ------------------------------------------------------------------ engine: turn_summary

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-summary"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "r\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

describe("turn_summary event (§15)", () => {
  it("follows turn_end when files await review, with why / commands / plan vs actual", async () => {
    const dir = makeRepo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    await h.engine.request({ type: "set_permission_mode", mode: "plan" });
    await h.engine.handle({ type: "send", text: "plan it" });
    h.session().emit({ type: "plan_exit", plan: "1. Create CONTRIBUTING.md\n2. Mention it in README.md\n3. Tests later", planFiles: [] });
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.session.pendingPlan !== null && s.gate.phase === "idle", "plan proposed");
    // No files changed in the planning turn: no summary.
    expect(h.ofType("turn_summary")).toEqual([]);
    await h.engine.request({ type: "plan_response", approve: true });

    const s = h.session();
    s.emit({ type: "tool_use", id: "w1", name: "Write", input: { file_path: join(dir, "CONTRIBUTING.md") }, file: join(dir, "CONTRIBUTING.md"), rationale: "Add the guide." });
    write(dir, "CONTRIBUTING.md", "how to\n");
    s.emit({ type: "tool_result", toolUseId: "w1", isError: false, preview: "ok" });
    s.emit({ type: "tool_use", id: "b1", name: "Bash", input: { command: "echo extra > extra.txt && npm test" } });
    write(dir, "extra.txt", "extra\n");
    s.emit({ type: "tool_result", toolUseId: "b1", isError: true, preview: "1 failed", testOutcome: "fail" });
    s.emitTurnEnd({
      toolFiles: [
        { path: join(dir, "CONTRIBUTING.md"), tools: ["Write"], count: 1, toolUseIds: ["w1"] },
        { path: join(dir, "extra.txt"), tools: ["Bash"], count: 1, toolUseIds: ["b1"] },
      ],
    });
    await h.waitFor((st) => st.gate.phase === "reviewing", "reviewing");
    await h.settle();
    const summaries = h.ofType("turn_summary");
    expect(summaries).toHaveLength(1);
    const sum = summaries[0]!;
    const order = h.events.map((e) => e.type);
    expect(order.lastIndexOf("turn_summary")).toBeGreaterThan(order.lastIndexOf("turn_end"));
    expect(sum.turn).toBe(2);
    expect(sum.files.map((f) => [f.path, f.status, f.adds, f.why])).toEqual([
      ["CONTRIBUTING.md", "A", 1, "Add the guide."],
      ["extra.txt", "A", 1, null],
    ]);
    expect(sum.commands).toEqual([{ toolUseId: "b1", command: "echo extra > extra.txt && npm test", isError: true, testOutcome: "fail" }]);
    expect(sum.plan).toEqual({
      path: null,
      steps: [
        { index: 0, text: "Create CONTRIBUTING.md", files: ["CONTRIBUTING.md"] },
        { index: 1, text: "Mention it in README.md", files: [] },
        { index: 2, text: "Tests later", files: [] },
      ],
      unplannedFiles: ["extra.txt"],
      // §42.1: the plan approved in ReviewGate says so (an older engine left `source` out).
      source: "approved",
    });
  });
});
