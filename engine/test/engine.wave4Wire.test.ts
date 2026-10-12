import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "../src/protocol.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir, sh } from "./helpers/repo.js";

/**
 * MARK: wave4b w4b-check4 — golden wire JSON of the §39.4 / §39.5 / §40.1 shapes as this engine sends them, consumed by
 * the Swift `Wave4WireGoldenTests` and the Electron `wave4Wire.test.ts`: a chat moved to another worktree (the event, both
 * metas, the notice in the target, the refusals), the auto-mode notices and a hook that blocked. Regenerate with
 * `UPDATE_WIRE_FIXTURES=1`.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "wire", "wave4.follow.json");
const PINNED_TIME = "2026-01-02T03:04:05.000Z";
const TIME_KEYS = new Set(["at", "createdAt", "updatedAt", "savedAt"]);

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** Times, the temp repository and the chat's random id vary per run: pinned (`/repo`, `/repo-wt`, `chat-1`). */
function pin<T>(value: T, root: string, chatId: string): T {
  let json = JSON.stringify(value, (key, v: unknown) => (TIME_KEYS.has(key) && typeof v === "string" ? PINNED_TIME : v));
  for (const form of new Set([root, JSON.stringify(root).slice(1, -1)])) json = json.split(form).join("/repo");
  json = json.split(basename(root)).join("repo"); // a worktree's `name` is its folder name
  json = json.split(chatId).join("chat-1");
  json = json.replace(/\/repo((?:\\\\[^"\\]*)+)/g, (_m, tail: string) => "/repo" + tail.replace(/\\\\/g, "/"));
  return JSON.parse(json) as T;
}

async function opened(path: string): Promise<Harness> {
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(path);
  return h;
}

describe("§39.4 / §39.5 / §40.1 wire goldens (wave4b w4b-check4)", () => {
  it("a moved chat, its refusals and notices, the auto-mode rows and a hook that blocked", async () => {
    const main = realpathSync(makeRepo());
    const wt = `${main}-wt`;
    sh(main, "worktree", "add", "-q", "-b", "feat", wt);
    dirs.push(main, wt);

    const src = await opened(main);
    await src.engine.handle({ type: "send", text: "remember the word cobalt" });
    const chatId = src.engine.state.sessions.currentId!;
    const s = src.session();
    s.emitSessionInfo({ sessionId: chatId });
    // §39.5 / §40.1: the notices as the session sends them (ClaudeSession's own shapes), as the engine forwards them.
    s.emit({ type: "error", message: "Auto mode blocked: git push --force — [Security Weaken]", fatal: false, code: "auto_mode_denied", detail: "git push --force — [Security Weaken]", toolName: "Bash" });
    s.emit({ type: "error", message: "Auto mode is not available here (this model or a policy turns it off); Claude Code runs in default mode and asks for commands.", fatal: false, code: "auto_mode_unavailable", detail: "default" });
    s.emit({ type: "error", message: "The hook PreToolUse:Bash blocked this: no rm -rf in this repo", fatal: false, code: "hook_blocked", hookName: "PreToolUse:Bash", exitCode: 2, detail: "no rm -rf in this repo" });
    s.emit({ type: "error", message: "The hook PostToolUse:Bash failed (exit 1): commit-sweep.sh: not found", fatal: false, code: "hook_failed", hookName: "PostToolUse:Bash", exitCode: 1, detail: "commit-sweep.sh: not found" });
    s.emitTurnEnd({ sessionId: chatId, stopReason: "error_max_turns" });
    await src.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn end");

    // §39.4 refusals, as a client without a pending request sees them (`result{ok: false, code}`).
    await src.engine.handle({ type: "chat_move", path: main, id: "req-same" });
    await src.engine.handle({ type: "chat_move", path: join(main, "nope"), id: "req-missing" });
    await src.engine.handle({ type: "chat_move", path: wt, id: "req-move" });
    const record = await src.waitFor((x) => x.session.open && !x.session.starting && x.sessions.list.some((m) => m.id === chatId && m.movedTo), "the record");
    await src.engine.handle({ type: "chat_move", path: wt, id: "req-record" });

    const dst = await opened(wt);
    const pick = (h: Harness, type: EngineEvent["type"], pred: (e: Record<string, unknown>) => boolean = () => true) =>
      h.events.filter((e) => e.type === type && pred(e as unknown as Record<string, unknown>));
    const codes = new Set(["auto_mode_denied", "auto_mode_unavailable", "hook_blocked", "hook_failed"]);
    const golden = pin({
      notices: pick(src, "error", (e) => codes.has(e.code as string)),
      turnEnd: pick(src, "turn_end").at(-1)!,
      results: pick(src, "result", (e) => typeof e.id === "string" && (e.id as string).startsWith("req-")),
      chatMoved: pick(src, "chat_moved").at(-1)!,
      sourceMeta: record.sessions.list.find((m) => m.id === chatId)!,
      movedIn: pick(dst, "error", (e) => e.code === "chat_moved_in" || e.code === "chat_moved_in_disk"),
      targetMeta: dst.engine.state.sessions.list.find((m) => m.id === chatId)!,
    }, main, chatId);

    // What the clients rely on, said here so a change to the engine's shapes fails before the goldens are rewritten.
    expect(golden.notices.map((e) => (e as { code?: string }).code)).toEqual(["auto_mode_denied", "auto_mode_unavailable", "hook_blocked", "hook_failed"]);
    expect(golden.notices[2]).toMatchObject({ fatal: false, scope: "session", code: "hook_blocked", hookName: "PreToolUse:Bash", exitCode: 2, detail: "no rm -rf in this repo" });
    expect(golden.turnEnd).toMatchObject({ type: "turn_end", stopReason: "error_max_turns" });
    expect(golden.results.map((r) => [(r as { id?: string }).id, (r as { ok?: boolean }).ok, (r as { code?: string }).code ?? null])).toEqual([
      ["req-same", false, "same_worktree"],
      ["req-missing", false, "path_not_found"],
      ["req-move", true, null],
      ["req-record", false, "chat_is_record"],
    ]);
    expect(golden.chatMoved).toEqual({ type: "chat_moved", sessionId: "chat-1", path: "/repo-wt", name: "repo-wt", baseline: "disk", interrupted: false });
    expect(golden.sourceMeta.movedTo).toEqual({ path: "/repo-wt", name: "repo-wt", at: PINNED_TIME });
    expect(golden.movedIn).toEqual([expect.objectContaining({ type: "error", fatal: false, scope: "session", code: "chat_moved_in_disk", path: "/repo", sessionId: "chat-1" })]);
    expect(golden.targetMeta.movedFrom).toEqual({ path: "/repo", name: "repo", at: PINNED_TIME });
    expect(golden.targetMeta.movedTo).toBeUndefined();

    const text = JSON.stringify(golden, null, 2) + "\n";
    if (process.env.UPDATE_WIRE_FIXTURES || !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, text);
    }
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(JSON.parse(text));
  });
});
