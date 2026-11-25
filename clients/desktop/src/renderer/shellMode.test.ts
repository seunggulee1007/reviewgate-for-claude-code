// docs/PROTOCOL.md §67.2 / §67.3 on Windows: `!` shell mode — the draft, the requests and their refusals in words, the
// running command's output and its row (live and restored), how a row says it ended, the folded output, the files line,
// the gate's `shell_running`, and the §67.1 card reason `added_directory`. Every string of shellMode.ts has its Korean.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, ReviewState, TranscriptItem } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import ko from "./i18n/ko.json";

const sent: EngineCommand[] = [];
let answer: (c: EngineCommand) => { ok: true; reply: unknown } | { ok: false; error: string; code?: string } = () => ({ ok: true, reply: { type: "result", ok: true } });

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return answer(c);
      },
      setSettings: async (patch: Record<string, unknown>) => patch,
      getSettings: async () => ({}),
      setUI: async () => undefined,
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "win32",
      sep: "\\",
    },
  };
  return { store: await import("./store"), shell: await import("./shellMode"), codes: await import("./errorCodes"), gate: await import("./gateText"), perms: await import("./permissionQueue") };
}

const result = (p: Record<string, unknown> = {}) => ({ id: "s1", command: "npm test", cwd: "C:\\work\\acme", output: "ok\n", exitCode: 0, durationMs: 1200, ...p });

describe("§67.2 ! shell mode on Windows", () => {
  beforeAll(() => initI18n("ko", "win32"));
  afterAll(() => initI18n("en", "darwin"));
  let mod: Awaited<ReturnType<typeof load>>;

  beforeEach(async () => {
    mod = await load();
    sent.length = 0;
    answer = () => ({ ok: true, reply: { type: "result", ok: true } });
    mod.store.useStore.setState({ transcript: [] });
    mod.shell.clearShellOutput();
  });

  it("a draft starting with ! is a shell command; anything else is a message", () => {
    const { isShellDraft, shellCommandOfDraft } = mod.shell;
    expect(shellCommandOfDraft("!npm test")).toBe("npm test");
    expect(shellCommandOfDraft("!  git status \n")).toBe("git status");
    expect(shellCommandOfDraft("!")).toBe("");
    expect(shellCommandOfDraft(" !ls")).toBeNull();
    expect(shellCommandOfDraft("run !ls")).toBeNull();
    expect(isShellDraft("!x")).toBe(true);
    expect(isShellDraft("")).toBe(false);
  });

  it("runs and stops through the engine; a refusal comes back in the user's words", async () => {
    expect(await mod.shell.runShellCommand("npm test")).toBeNull();
    expect(await mod.shell.cancelShellCommand()).toBeNull();
    expect(sent).toEqual([{ type: "shell_run", command: "npm test" }, { type: "shell_cancel" }]);
    answer = () => ({ ok: false, error: "shell_busy", code: "shell_busy" });
    expect(await mod.shell.runShellCommand("ls")).toBe("셸 명령이 이미 실행 중이에요 — 끝나길 기다리거나 중지해요");
    answer = () => ({ ok: false, error: "turn_running", code: "turn_running" });
    expect(await mod.shell.runShellCommand("ls")).toBe("Claude가 작업 중이에요 — 턴이 끝나면 실행할 수 있어요");
    answer = () => ({ ok: false, error: "no_shell_running", code: "no_shell_running" });
    expect(await mod.shell.cancelShellCommand()).toBe("실행 중인 셸 명령이 없어요");
  });

  it("keeps the running command's output until its row arrives; the row joins the chat", () => {
    const { handleEvent } = mod.store.useStore.getState();
    handleEvent({ type: "shell_output", id: "s1", output: "building…" });
    expect(mod.shell.useShellLive.getState()).toEqual({ id: "s1", output: "building…" });
    handleEvent({ type: "shell_output", id: "s1", output: "building…\ndone" });
    expect(mod.shell.useShellLive.getState().output).toBe("building…\ndone");
    handleEvent({ type: "shell_result", turn: 3, at: "2026-11-24T10:00:00Z", ...result({ files: ["src/a.ts"] }) } as never);
    expect(mod.shell.useShellLive.getState()).toEqual({ id: null, output: "" });
    const rows = mod.store.useStore.getState().transcript;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "shell", turn: 3, result: { id: "s1", command: "npm test", exitCode: 0, files: ["src/a.ts"] } });
    expect((rows[0] as { result: Record<string, unknown> }).result).not.toHaveProperty("type");
  });

  it("another command's row leaves the running one's output alone", () => {
    mod.shell.noteShellOutput("s2", "x");
    mod.shell.clearShellOutput("s1");
    expect(mod.shell.useShellLive.getState().id).toBe("s2");
  });

  it("comes back with the chat (transcript_restore)", () => {
    const rows = mod.store.chatItemsOfRows([{ kind: "shell", at: "2026-11-24T10:00:00Z", turn: 2, ...result({ exitCode: null, cancelled: true }) } as TranscriptItem], { maxFiles: 0, maxLines: 0 } as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "shell", turn: 2, result: { command: "npm test", cancelled: true, exitCode: null } });
    expect((rows[0] as { result: Record<string, unknown> }).result).not.toHaveProperty("kind");
  });

  it("says how a command ended", () => {
    const { shellEnd } = mod.shell;
    expect(shellEnd({ exitCode: 0 })).toEqual({ text: "✓ 0", tone: "ok" });
    expect(shellEnd({ exitCode: 2 })).toEqual({ text: "✗ 종료 코드 2", tone: "error" });
    expect(shellEnd({ exitCode: null, cancelled: true })).toEqual({ text: "중지됨", tone: "stopped" });
    expect(shellEnd({ exitCode: null, timedOut: true })).toEqual({ text: "시간 초과 (10분)", tone: "stopped" });
    expect(shellEnd({ exitCode: null })).toEqual({ text: "시작하지 못했어요", tone: "error" });
  });

  it("folds long output to its last lines", () => {
    const { foldShellOutput } = mod.shell;
    expect(foldShellOutput("a\nb\n")).toEqual({ text: "a\nb", hidden: 0 });
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\r\n");
    const folded = foldShellOutput(long, 12);
    expect(folded.hidden).toBe(18);
    expect(folded.text.split("\n")[0]).toBe("line 19");
    expect(folded.text.endsWith("line 30")).toBe(true);
  });

  it("names the files it changed, with the names in the tooltip", () => {
    const { shellFilesLine } = mod.shell;
    expect(shellFilesLine({})).toBeNull();
    expect(shellFilesLine({ files: ["a.ts", "b.ts"] })).toEqual({ text: "파일 2개를 바꿨어요 — 다음 리뷰에 나와요", title: "a.ts\nb.ts" });
    expect(shellFilesLine({ files: ["a.ts"], filesTruncated: true })!.text).toContain("1+");
  });

  it("the caption over the box and the key hint", () => {
    expect(mod.shell.shellPendingCaption(0)).toBeNull();
    expect(mod.shell.shellPendingCaption(undefined)).toBeNull();
    expect(mod.shell.shellPendingCaption(2)).toBe("셸 결과 2개가 다음 메시지와 함께 Claude에게 가요");
    expect(mod.shell.shellKeyHint(true)).toBe("Enter 셸 명령 실행 · 출력은 다음 메시지와 함께 Claude에게 가요"); // ↩ spelled out on Windows
    expect(mod.shell.shellKeyHint(false)).toContain("셸 명령 실행");
  });

  it("the gate's shell_running: the message waits, and a refusal says why", () => {
    const s = mod.store.useStore.getState().state;
    const state = { ...s, gate: { ...s.gate, blockedReason: "shell_running" } } as ReviewState;
    expect(mod.store.cannotSendReason(state)).toBe("셸 명령을 실행 중이에요 — 메시지는 명령이 끝나면 보내요");
    expect(mod.gate.gateText("shell_running")).toBe("셸 명령이 끝날 때까지 기다려 주세요");
  });

  it("every /add-dir and ! refusal has its Korean", () => {
    const codes = ["dir_empty_path", "dir_path_too_long", "dir_not_found", "dir_not_directory", "dir_is_project", "dir_already_added", "dir_too_many", "dir_busy", "dir_not_added", "terminal_chat", "empty_command", "command_too_long", "shell_busy", "turn_running", "no_shell_running"];
    for (const code of codes) {
      expect(mod.codes.REFUSAL_CODES as readonly string[], code).toContain(code);
      expect(mod.codes.refusalCodeText(code, "C:\\work\\shared"), code).toMatch(/[가-힣]/);
    }
    expect(mod.codes.refusalMessage({ code: "dir_not_found", error: "dir_not_found:C:\\work\\nope", detail: "C:\\work\\nope" })).toBe("그런 디렉터리가 없어요: C:\\work\\nope");
  });

  it("§67.1 the card's reason for an edit in an added directory (orange, bundled like an outside edit)", () => {
    const view = mod.perms.reasonView({ code: "added_directory", message: "m", path: "C:\\work\\shared" });
    expect(view).toMatchObject({ tone: "orange", path: "C:\\work\\shared", text: "/add-dir로 추가한 디렉터리의 수정이에요 — 리뷰에 diff가 나오지 않아서 여기서 승인받아요" });
    expect(mod.perms.bundles({ toolName: "Edit", reason: { code: "added_directory", message: "m" } })).toBe(true);
  });

  it("has Korean for every string of shellMode.ts, in 해요체", () => {
    const src = readFileSync(fileURLToPath(new URL("./shellMode.ts", import.meta.url)), "utf8");
    const keys = [...src.matchAll(/\bt\("((?:[^"\\]|\\.)+)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    expect(keys.length).toBeGreaterThan(8);
    const dict = ko as Record<string, string>;
    for (const k of keys) {
      expect(dict[k], k).toMatch(/[가-힣]/);
      expect(dict[k], k).not.toMatch(/(습니다|십시오|합니다)/);
      for (const p of k.match(/\{\d\}/g) ?? []) expect(dict[k], k).toContain(p);
    }
  });
});
