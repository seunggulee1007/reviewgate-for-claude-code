// docs/PROTOCOL.md §67.1 / §67.3 on Windows: /add-dir — add_dir with a typed path or the folder picker (cancel does nothing),
// remove_dir from the chip's ×, refusals in the user's words, when the chat's directories cannot change (dir_busy), and the
// chip's popover as markup (home as ~, the full path in the tooltip, × and "디렉터리 추가…" disabled with the reason).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand } from "@reviewgate/engine";
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
      onEvent: () => () => undefined,
      platform: "win32",
      sep: "\\",
    },
  };
  return { dirs: await import("./addedDirs"), chip: await import("./components/chat/AddedDirsChip") };
}

describe("§67.1 /add-dir on Windows", () => {
  beforeAll(() => initI18n("ko", "win32"));
  afterAll(() => initI18n("en", "darwin"));
  let mod: Awaited<ReturnType<typeof load>>;

  beforeEach(async () => {
    mod = await load();
    sent.length = 0;
    answer = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  it("adds a typed path; ok says Claude works there from the next message", async () => {
    expect(await mod.dirs.addDir("  ../shared  ")).toEqual({ ok: true, notice: "디렉터리를 추가했어요 — 다음 메시지부터 Claude가 여기서도 일해요" });
    expect(sent).toEqual([{ type: "add_dir", path: "../shared" }]);
  });

  it("/add-dir alone asks the picker first; a cancelled picker sends nothing", async () => {
    expect(await mod.dirs.addDir("", async () => null)).toBeNull();
    expect(sent).toEqual([]);
    expect((await mod.dirs.addDir("", async () => "C:\\work\\shared"))?.ok).toBe(true);
    expect(sent).toEqual([{ type: "add_dir", path: "C:\\work\\shared" }]);
  });

  it("a refusal comes back in words, with the path it names", async () => {
    answer = () => ({ ok: false, error: "dir_is_project:C:\\work\\acme\\src", code: "dir_is_project" });
    expect(await mod.dirs.addDir("src")).toEqual({ ok: false, notice: "프로젝트 폴더이거나 그 안이에요 — Claude가 이미 일하는 곳이에요 (C:\\work\\acme\\src)" });
    answer = () => ({ ok: false, error: "dir_busy", code: "dir_busy" });
    expect((await mod.dirs.removeDir("C:\\work\\shared"))?.notice).toBe("Claude의 작업이 끝나면 바꿀 수 있어요 — 작업 중에는 채팅의 디렉터리가 바뀌지 않아요");
    expect(sent.at(-1)).toEqual({ type: "remove_dir", path: "C:\\work\\shared" });
  });

  it("removes one from the chip", async () => {
    expect(await mod.dirs.removeDir("C:\\work\\shared")).toEqual({ ok: true, notice: "디렉터리를 뺐어요 — 다음 메시지부터 Claude는 여기서 일하지 않아요" });
  });

  it("the chat's directories cannot change while Claude works, starts, collects or reverts", () => {
    const at = (phase: string, starting = false, externalTurn: unknown = null) => mod.dirs.addedDirsBusyReason({ session: { starting, externalTurn } as never, gate: { phase } as never });
    expect(at("idle")).toBeNull();
    expect(at("reviewing")).toBeNull();
    for (const phase of ["running", "collecting", "reverting"]) expect(at(phase), phase).toContain("작업 중에는");
    expect(at("idle", true)).not.toBeNull();
    expect(at("idle", false, { peer: null })).not.toBeNull();
  });

  it("the chip and its list", () => {
    expect(mod.dirs.addedDirsChipText(2)).toBe("디렉터리 2");
    expect(mod.dirs.addedDirsOf({})).toEqual([]);
    expect(mod.dirs.shownDir("C:\\Users\\dev\\shared")).toBe("~\\shared");
    const html = renderToStaticMarkup(createElement(mod.chip.AddedDirsList, { dirs: ["C:\\Users\\dev\\shared", "D:\\libs"], busy: null, onRemove: () => undefined, onAdd: () => undefined }));
    expect(html).toContain("~\\shared");
    expect(html).toContain('title="C:\\Users\\dev\\shared"');
    expect(html).toContain("디렉터리 추가…");
    expect(html).toContain('aria-label="C:\\Users\\dev\\shared 제거"');
    expect(html).not.toContain("disabled");
    const busy = renderToStaticMarkup(createElement(mod.chip.AddedDirsList, { dirs: ["D:\\libs"], busy: "작업 중이에요", onRemove: () => undefined, onAdd: () => undefined }));
    expect(busy.match(/disabled=""/g)).toHaveLength(2);
    expect(busy.match(/title="작업 중이에요"/g)).toHaveLength(2);
  });

  it("has Korean for every string of addedDirs.ts and the chip", () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const src = read("./addedDirs.ts") + read("./components/chat/AddedDirsChip.tsx");
    const keys = [...src.matchAll(/\bt\("((?:[^"\\]|\\.)+)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    expect(keys.length).toBeGreaterThan(6);
    const dict = ko as Record<string, string>;
    for (const k of keys) {
      expect(dict[k], k).toMatch(/[가-힣]/);
      expect(dict[k], k).not.toMatch(/(습니다|십시오|합니다)/);
    }
  });
});
