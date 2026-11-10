// MARK: wave5 w5-model — §43.4 auto model through the engine: the model is set before a message goes out, never during a
// turn; this message's own pick wins; manual mode puts the chip's model back after a one-message pick.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir, write } from "./helpers/repo.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.handle({ type: "shutdown" }).catch(() => undefined);
  for (const d of dirs.splice(0)) removeDir(d);
});

async function setup(settings: Parameters<Harness["hello"]>[0] = {}): Promise<{ h: Harness; dir: string }> {
  const dir = makeRepo();
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello(settings);
  await h.open(dir);
  return { h, dir };
}

/** One full turn: send, the fake CLI ends it, the collection finishes. */
async function turn(h: Harness, text: string, extra: Record<string, unknown> = {}, opts: { stopReason?: string } = {}): Promise<void> {
  await h.engine.request({ type: "send", text, ...extra } as never);
  h.session().emitTurnEnd(opts.stopReason ? { stopReason: opts.stopReason } : {});
  await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn end");
  await h.settle();
}

const lastUserMessage = (h: Harness) => h.ofType("user_message").at(-1)!;

describe("§43.4 auto model", () => {
  it("auto picks a model per message before it goes out, says why, counts it, and leaves a running turn alone", async () => {
    const { h, dir } = await setup({ modelMode: "auto" });
    const s = h.session();
    await turn(h, "로그인 모듈 아키텍처를 어떻게 나눌지 설계해 줘");
    expect(s.models).toEqual(["claude-opus-5-5"]);
    expect(lastUserMessage(h).autoModel).toEqual({ model: "claude-opus-5-5", family: "opus", reason: "design", policy: "balanced", by: "auto", switched: true, from: null });
    expect(h.ofType("turn_end").at(-1)!.autoModel).toMatchObject({ model: "claude-opus-5-5", reason: "design" });
    expect(h.engine.state.session.autoModel).toMatchObject({ model: "claude-opus-5-5", reason: "design", by: "auto" });
    // A simple request goes to haiku; the switch line names where it came from.
    await turn(h, "Fix the typo in README");
    expect(s.models).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
    expect(lastUserMessage(h).autoModel).toMatchObject({ model: "claude-haiku-5-5", reason: "trivial_edit", switched: true, from: "claude-opus-5-5" });
    // The same family again: no switch, no line.
    await turn(h, "Rename getUsr to getUser");
    expect(s.models).toHaveLength(2);
    expect(lastUserMessage(h).autoModel).toEqual({ model: "claude-haiku-5-5", family: "haiku", reason: "trivial_edit", policy: "balanced", by: "auto" });
    expect(h.engine.state.hud.autoModelCounts).toEqual([{ family: "haiku", count: 2 }, { family: "opus", count: 1 }]);
    // The turn summary card says it too (a turn that changed a file).
    await h.engine.request({ type: "send", text: "UserController 에 페이징 API 추가해 줘" });
    write(dir, "README.md", "line1\nline2 changed\nline3\n");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "README.md"), tools: ["Edit"], count: 1 }] });
    await h.waitFor((st) => st.gate.phase === "reviewing", "review");
    await h.settle();
    expect(h.ofType("turn_summary").at(-1)?.autoModel).toMatchObject({ model: "claude-sonnet-5-5", reason: "standard", switched: true });
    // A policy change applies from the next message.
    await h.engine.request({ type: "set_settings", settings: { modelAutoPolicy: "cost" } });
    await h.engine.request({ type: "accept_all" });
    await turn(h, "Design the caching layer for the order service");
    expect(lastUserMessage(h).autoModel).toMatchObject({ model: "claude-sonnet-5-5", reason: "cost_policy", policy: "cost" });
  });

  it("this message's own pick wins over auto; manual mode puts the chip's model back after it", async () => {
    const { h } = await setup({ modelMode: "auto" });
    const s = h.session();
    await expect(h.engine.request({ type: "send", text: "hi", model: "rm -rf /" } as never)).rejects.toThrow(/invalid_model/);
    expect(h.ofType("user_message")).toHaveLength(0);
    await turn(h, "Fix the typo in README", { model: "claude-opus-5-5" });
    expect(s.models).toEqual(["claude-opus-5-5"]);
    expect(lastUserMessage(h).autoModel).toMatchObject({ model: "claude-opus-5-5", reason: "user_choice", by: "user", switched: true });
    expect(h.engine.state.hud.autoModelCounts ?? []).toEqual([]);
    // Manual: the chip's model (here the CLI default) comes back once, then nothing more is touched.
    await h.engine.request({ type: "set_settings", settings: { modelMode: "manual" } });
    await turn(h, "UserController 에 페이징 API 추가해 줘");
    expect(s.models).toEqual(["claude-opus-5-5", null]);
    expect(lastUserMessage(h).autoModel).toMatchObject({ model: null, reason: "manual", by: "manual", switched: true, from: "claude-opus-5-5" });
    await turn(h, "Add a unit test for the CSV parser");
    expect(s.models).toHaveLength(2);
    expect(lastUserMessage(h).autoModel).toBeUndefined();
    // A one-message pick in manual mode too.
    await turn(h, "이건 haiku 로", { model: "claude-haiku-5-5" });
    expect(s.models).toEqual(["claude-opus-5-5", null, "claude-haiku-5-5"]);
  });

  it("manual mode (the default) never touches the model; plan mode, a failed turn and a reject steer auto", async () => {
    const { h, dir } = await setup();
    const s = h.session();
    await turn(h, "로그인 모듈 아키텍처를 설계해 줘");
    expect(s.models).toEqual([]);
    expect(lastUserMessage(h).autoModel).toBeUndefined();
    expect(h.engine.state.session.autoModel ?? null).toBeNull();
    await h.engine.request({ type: "set_settings", settings: { modelMode: "auto" } });
    await turn(h, "Fix the typo in README", {}, { stopReason: "error_during_execution" });
    expect(lastUserMessage(h).autoModel).toMatchObject({ reason: "trivial_edit" });
    await turn(h, "Fix the typo in README");
    expect(lastUserMessage(h).autoModel).toMatchObject({ family: "opus", reason: "after_failure" });
    // A reject of Claude's change makes the next message a retry.
    await h.engine.request({ type: "send", text: "Rename getUsr to getUser" });
    write(dir, "README.md", "line1\nline2 renamed\nline3\n");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "README.md"), tools: ["Edit"], count: 1 }] });
    await h.waitFor((st) => st.gate.phase === "reviewing", "review");
    await h.engine.request({ type: "reject", paths: ["README.md"] });
    await h.settle();
    await turn(h, "Rename getUsr to getUser");
    expect(lastUserMessage(h).autoModel).toMatchObject({ family: "opus", reason: "after_revert" });
    // "계속" keeps the previous turn's family.
    await turn(h, "계속 진행해");
    expect(lastUserMessage(h).autoModel).toMatchObject({ family: "opus", reason: "continuation" });
    // Planning goes to opus whatever the words.
    await turn(h, "Fix the typo in README");
    expect(lastUserMessage(h).autoModel).toMatchObject({ family: "haiku" });
    await h.engine.request({ type: "set_permission_mode", mode: "plan" });
    await turn(h, "로그인 개선");
    expect(lastUserMessage(h).autoModel).toMatchObject({ family: "opus", reason: "plan_mode", switched: true });
  });
});
