import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { COMMIT_DRAFT_HEADER, COMMIT_DRAFT_SYSTEM } from "../src/review/commitDraft.js";
import { sessionTranscriptPath } from "../src/review/sessions.js";
import { SIDE_READ_ONLY_REASON, SideQuery } from "../src/side/sideQuery.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { FakeSide, makeSideRepo, type SideScript } from "./helpers/fakeSide.js";
import { removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §36.11 (daily-05): Claude drafts the commit message in the project's format; the user commits. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function setup(script: SideScript) {
  const sides: FakeSide[] = [];
  const h = makeHarness({ sideQueryFactory: (o) => {
    const f = new FakeSide(o, script);
    sides.push(f);
    return f;
  } });
  harnesses.push(h);
  return { h, sides };
}

/** One turn changes README.md and adds notes.txt; README.md is accepted. */
async function acceptedTurn(h: Harness, dir: string): Promise<void> {
  await h.engine.handle({ type: "send", text: "README 둘째 줄 고치고 notes 추가" });
  h.session().emitSessionInfo();
  write(dir, "README.md", "line1\nline2 changed\nline3\n");
  write(dir, "notes.txt", "n\n");
  h.session().emitTurnEnd({ toolFiles: [], lastUuid: "uuid-1" });
  await h.waitFor((s) => s.gate.phase === "reviewing" && s.changedFiles.length === 2, "review");
  await h.engine.request({ type: "accept", paths: ["README.md"] });
  await h.settle();
}

describe("§36.11 commit_draft", () => {
  it("a read-only fork gets the accepted diff, the recent subjects, the branch and the rendered template; the reply is the cleaned message and nothing is committed", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    sh(dir, "commit", "-q", "--allow-empty", "-m", "#acme/4746: [주문] 재고 동기화 - 로그 정리");
    sh(dir, "switch", "-q", "-c", "feature/acme/4747");
    const { h, sides } = setup(() => ({ text: "Here is the commit message:\n\n```\n#acme/4747: [주문] README - 둘째 줄 수정\n\n- 문구 변경\n```", cost: 0.004 }));
    await h.hello({ commitTemplate: "#acme/{issue}: " });
    await h.open(dir);
    await acceptedTurn(h, dir);
    const headBefore = sh(dir, "rev-parse", "HEAD").trim();
    const main = h.session();
    const transcriptBefore = readFileSync(sessionTranscriptPath(join(dir, ".git"), h.engine.state.sessions.currentId!), "utf8");
    const reply = await h.engine.request({ type: "commit_draft" });
    expect(reply).toMatchObject({ type: "commit_draft", message: "#acme/4747: [주문] README - 둘째 줄 수정\n\n- 문구 변경" });
    const o = sides[0]!.opts;
    // A fork of the main conversation, no session file, no web, its own system text.
    expect(o.forkFrom).toBe("sess-1");
    expect(o.persistSession).toBe(false);
    expect(o.allowWeb).toBe(false);
    expect(o.system).toBe(COMMIT_DRAFT_SYSTEM);
    expect(o.prompt.startsWith(COMMIT_DRAFT_HEADER)).toBe(true);
    expect(o.prompt).toContain("Branch: feature/acme/4747");
    expect(o.prompt).toContain('"#acme/4747: "');
    expect(o.prompt).toContain("- #acme/4746: [주문] 재고 동기화 - 로그 정리");
    expect(o.prompt).toContain("+line2 changed");
    // Only accepted files: notes.txt is pending.
    expect(o.prompt).not.toContain("notes.txt");
    expect(o.prompt).toContain("- README.md (M, +1 −1)");
    // Nothing committed, the main conversation untouched, no side thread, the cost on the side meter.
    expect(sh(dir, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(main.sends).toHaveLength(1);
    expect(readFileSync(sessionTranscriptPath(join(dir, ".git"), h.engine.state.sessions.currentId!), "utf8")).toBe(transcriptBefore);
    expect((await h.engine.request({ type: "side_list" })).threads).toEqual([]);
    await h.settle();
    expect(h.engine.state.hud.sideCostUSD).toBeCloseTo(0.004);
    expect(h.engine.state.changedFiles.find((f) => f.path === "README.md")?.state).toBe("accepted");

    // The fork cannot change a file: its hook and canUseTool refuse every edit and mutating command.
    const q = new SideQuery(o).queryOptions();
    const hook = q.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
    for (const [tool, input] of [["Edit", { file_path: join(dir, "README.md") }], ["Write", { file_path: join(dir, "x") }], ["Bash", { command: "git commit -am x" }], ["ReportFindings", { findings: [] }]] as const) {
      const out = await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, session_id: "s", transcript_path: "", cwd: dir, tool_use_id: "t" } as unknown as HookInput, "t", { signal: new AbortController().signal });
      expect((out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, tool).toBe("deny");
    }
    expect(await q.canUseTool!("MultiEdit", { file_path: join(dir, "README.md") }, { signal: new AbortController().signal, toolUseID: "t" } as never)).toEqual({ behavior: "deny", message: SIDE_READ_ONLY_REASON });
  });

  it("paths must all be accepted; no accepted file, a failed fork or an empty answer is refused", async () => {
    const dir = makeSideRepo();
    dirs.push(dir);
    let answer: { text: string; error?: string } = { text: "", error: "boom: the side session crashed" };
    const { h } = setup(() => answer);
    await h.hello();
    await h.open(dir);
    await expect(h.engine.request({ type: "commit_draft" })).rejects.toThrow(/^nothing_to_commit$/);
    await acceptedTurn(h, dir);
    await expect(h.engine.request({ type: "commit_draft", paths: ["notes.txt"] })).rejects.toThrow(/nothing_to_commit/);
    await expect(h.engine.request({ type: "commit_draft", paths: ["README.md", "notes.txt"] })).rejects.toThrow(/nothing_to_commit/);
    await expect(h.engine.request({ type: "commit_draft", paths: ["README.md"] })).rejects.toThrow(/commit_draft_failed:boom: the side session crashed/);
    answer = { text: "  \n " };
    await expect(h.engine.request({ type: "commit_draft" })).rejects.toThrow(/commit_draft_failed/);
    answer = { text: "docs: README 둘째 줄 수정" };
    expect((await h.engine.request({ type: "commit_draft", paths: ["README.md"] })).message).toBe("docs: README 둘째 줄 수정");
  });
});
