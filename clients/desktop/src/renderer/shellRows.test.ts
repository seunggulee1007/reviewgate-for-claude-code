// docs/PROTOCOL.md §67.3 on Windows, the `!` command in the chat as markup: the running row at the end (command, elapsed,
// output so far, 중지) and the finished row (how it ended, the time, the folded output with 전체 보기, the cut note, the
// files line with the names in its tooltip), its copy menu, and the transcript drawing both. Every string has its Korean.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewState, ShellResult } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import ko from "./i18n/ko.json";

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "win32", sep: "\\" },
  };
  return { store: await import("./store"), shell: await import("./shellMode"), rows: await import("./components/chat/ShellRows"), transcript: await import("./components/chat/Transcript") };
}

const result = (p: Partial<ShellResult> = {}): ShellResult => ({ id: "s1", command: "npm test", cwd: "C:\\work\\acme", output: "ok\n", exitCode: 0, durationMs: 1200, ...p });

describe("§67.3 the ! command's rows", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("ko", "win32");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));

  const sync = () => {
    Object.assign(m.store.useStore.getInitialState(), m.store.useStore.getState());
    Object.assign(m.shell.useShellLive.getInitialState(), m.shell.useShellLive.getState());
  };
  const row = (r: ShellResult) => renderToStaticMarkup(createElement(m.rows.ShellRow, { result: r }));

  it("a finished command: the command, how it ended, the time, the output", () => {
    const html = row(result());
    expect(html).toContain("$ npm test");
    expect(html).toContain("실행한 곳: C:\\work\\acme");
    expect(html).toMatch(/data-testid="Shell end">✓ 0</);
    expect(html).toContain("1.2초");
    expect(html).toMatch(/data-testid="Shell output">ok</);
    expect(html).not.toContain("Shell show all");
    expect(html).not.toContain("Shell files");
    expect(row(result({ exitCode: 1 }))).toContain("✗ 종료 코드 1");
    expect(row(result({ exitCode: null, cancelled: true }))).toContain("중지됨");
    expect(row(result({ exitCode: null, timedOut: true }))).toContain("시간 초과");
    expect(row(result({ output: "" }))).toContain("(출력 없음)");
  });

  it("long output folds to its last lines with 전체 보기; a cut start says so", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const html = row(result({ output: long, truncated: true }));
    expect(html).toContain("전체 보기");
    expect(html).toContain("위의 28줄까지 모두 보기");
    expect(html).toContain("앞부분은 잘렸어요");
    expect(html).not.toContain("line 28\n");
    expect(html).toContain("line 29");
  });

  it("names the files it changed, with the names in the tooltip", () => {
    const html = row(result({ files: ["src/a.ts", "README.md"] }));
    expect(html).toContain("파일 2개를 바꿨어요 — 다음 리뷰에 나와요");
    expect(html).toContain('title="src/a.ts\nREADME.md"');
  });

  it("its menu copies the command and the output (no output: disabled with why)", () => {
    expect(m.rows.shellCopyItems(result()).map((i) => [i.label, i.disabled ?? null])).toEqual([["명령 복사", null], ["출력 복사", null]]);
    expect(m.rows.shellCopyItems(result({ output: "" }))[1]!.disabled).toBe("출력이 없어요");
  });

  it("while it runs: the command, the elapsed time, the output so far and 중지", () => {
    const s = m.store.useStore.getInitialState().state;
    m.store.useStore.setState({ state: { ...s, session: { ...s.session, shell: { id: "s1", command: "npm run build", cwd: "C:\\work\\acme", startedAt: new Date(Date.now() - 4000).toISOString() } } } as ReviewState });
    m.shell.noteShellOutput("s1", "compiling…");
    sync();
    const html = renderToStaticMarkup(createElement(m.rows.ShellRunningRow, {}));
    expect(html).toContain("$ npm run build");
    expect(html).toMatch(/>[45]초</); // whole seconds while it ticks
    expect(html).toContain("compiling…");
    expect(html).toContain('title="셸 명령 중지 (esc)"');
    expect(html).toContain("</span> 중지</button>");
    m.shell.noteShellOutput("other", "not this one");
    sync();
    expect(renderToStaticMarkup(createElement(m.rows.ShellRunningRow, {}))).not.toContain("not this one");
  });

  it("the transcript draws the finished row and, at its end, the running one", () => {
    const s = m.store.useStore.getInitialState().state;
    m.store.useStore.setState({
      state: { ...s, session: { ...s.session, shell: { id: "s2", command: "git status", cwd: "C:\\work\\acme", startedAt: new Date().toISOString() } } } as ReviewState,
      transcript: [{ kind: "shell", id: 1, result: result(), turn: 1 }],
    });
    sync();
    const html = renderToStaticMarkup(createElement(m.transcript.Transcript));
    expect(html).toContain('data-testid="Shell row"');
    expect(html.indexOf("Shell running row")).toBeGreaterThan(html.indexOf('data-testid="Shell row"'));
  });

  it("has Korean for every string of the rows", () => {
    const src = readFileSync(fileURLToPath(new URL("./components/chat/ShellRows.tsx", import.meta.url)), "utf8");
    const keys = [...src.matchAll(/\bt\("((?:[^"\\]|\\.)+)"/g)].map((x) => JSON.parse(`"${x[1]}"`) as string);
    expect(keys.length).toBeGreaterThan(8);
    const dict = ko as Record<string, string>;
    for (const k of keys) {
      expect(dict[k], k).toMatch(/[가-힣]/);
      for (const p of k.match(/\{\d\}/g) ?? []) expect(dict[k], k).toContain(p);
    }
  });
});
