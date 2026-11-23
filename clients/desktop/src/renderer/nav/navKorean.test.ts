// §62 on Windows: every string the code navigation shows has its Korean (ko.extra.json → ko.json), in 해요체, with the
// glossary's words — and IDE / VS Code / IntelliJ IDEA kept in English.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ko from "../i18n/ko.json";

const dir = fileURLToPath(new URL(".", import.meta.url));
const sources = readdirSync(dir)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"))
  .map((f) => readFileSync(`${dir}/${f}`, "utf8"))
  .concat(readFileSync(fileURLToPath(new URL("../components/diff/OpenInEditor.tsx", import.meta.url)), "utf8"));
const keys = [...new Set(sources.flatMap((s) => [...s.matchAll(/\bt\("((?:[^"\\]|\\.)+)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string)))];
const dict = ko as Record<string, string>;

describe("code navigation in Korean (§62)", () => {
  it("has Korean for every string", () => {
    expect(keys.length).toBeGreaterThan(25);
    for (const k of keys) expect(dict[k], k).toMatch(/[가-힣]/);
  });

  it("uses the agreed words", () => {
    expect(dict["Go to Definition"]).toBe("정의로 이동");
    expect(dict["Find References"]).toBe("참조 찾기");
    expect(dict["Open in IDE"]).toBe("IDE에서 열기");
    expect(dict["Back"]).toBe("뒤로");
    expect(dict["Forward"]).toBe("앞으로");
    expect(dict["No definition found"]).toBe("정의를 찾지 못했어요");
    expect(dict["Code navigation"]).toBe("코드 탐색");
  });

  it("speaks 해요체, keeps the placeholders, never 검토", () => {
    for (const k of keys) {
      const v = dict[k]!;
      expect(v, k).not.toMatch(/(습니다|십시오|합니다)/);
      expect(v, k).not.toMatch(/검토/);
      for (const p of k.match(/\{\d\}/g) ?? []) expect(v, k).toContain(p);
      for (const name of ["IDE", "VS Code", "IntelliJ IDEA", "Ctrl+Alt+O", "F12"]) if (k.includes(name)) expect(v, k).toContain(name);
    }
  });
});
