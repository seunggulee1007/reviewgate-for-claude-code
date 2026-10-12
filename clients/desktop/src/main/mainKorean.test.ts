// MARK: wave4d w4d-windows — audit polish-07: the main process speaks the UI language too — the menu bar (role items
// included), the taskbar overlay's description and the reasons a picked program is refused.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

const built: { template: MenuItemConstructorOptions[] } = { template: [] };
vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.3.0", getPath: () => "/tmp/rg-user-data" },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      built.template = template;
      return template;
    },
    setApplicationMenu: () => undefined,
  },
  shell: { openPath: async () => "" },
}));
vi.mock("./settings.js", () => ({ loadSettings: () => ({ recentProjects: ["/definitely/missing/rg-project-x"] }) }));

import { initI18n } from "../renderer/i18n";
import { badgeDescription } from "./notify";
import { refusalText } from "./settingsGuard";

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p, configurable: true });

/** Every item of the template, submenus included. */
function walk(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? walk(i.submenu as MenuItemConstructorOptions[]) : [])]);
}

async function windowsMenu(): Promise<MenuItemConstructorOptions[]> {
  setPlatform("win32"); // read once, when menu.ts loads — imported here for the first time
  const { buildMenu } = await import("./menu");
  buildMenu({ newWindow: () => undefined, openInNewWindow: () => undefined, copyDiagnostics: () => undefined });
  return built.template;
}

describe("main process in Korean (polish-07)", () => {
  beforeAll(() => initI18n("ko", "win32"));
  afterEach(() => setPlatform(realPlatform));
  afterAll(() => initI18n("en", "darwin"));

  it("labels every menu item — the role items too — in Korean on Windows", async () => {
    const template = await windowsMenu();
    expect(template.map((m) => m.label)).toEqual(["파일", "편집", "보기", "창", "도움말"]);
    for (const item of walk(template)) {
      if (item.type === "separator") continue;
      expect(typeof item.label, JSON.stringify(item)).toBe("string");
      const label = item.label!;
      if (label.startsWith("ReviewGate ")) continue; // the version line
      expect(label, `${item.role ?? ""} ${label}`).toMatch(/[가-힣]/);
    }
    const labels = walk(template).map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(["프로젝트 열기…", "실행 취소", "붙여넣기", "모두 선택", "확대", "축소", "최소화", "로그 폴더 열기"]));
    // A gone recent folder: shown, named in Korean, never opened.
    const gone = walk(template).find((i) => i.sublabel === "/definitely/missing/rg-project-x");
    expect(gone?.label).toBe("rg-project-x — 찾을 수 없음");
    expect(gone?.enabled).toBe(false);
  });

  it("shows the Mac's View keys without taking them from the renderer, and Help › Keyboard Shortcuts (polish-08)", async () => {
    const items = walk(await windowsMenu());
    for (const [label, accelerator] of [["Diff 패널 보기/숨기기", "CmdOrCtrl+Shift+D"], ["에이전트 패널 보기/숨기기", "CmdOrCtrl+Alt+A"], ["곁질문 패널 보기/숨기기", "CmdOrCtrl+Alt+S"]] as const) {
      const item = items.find((i) => i.label === label);
      expect(item?.accelerator, label).toBe(accelerator);
      expect(item?.registerAccelerator, label).toBe(false);
    }
    expect(items.find((i) => i.label === "키보드 단축키")?.click).toBeTypeOf("function");
  });

  it("describes the taskbar overlay in Korean", () => {
    expect(badgeDescription(0)).toBe("");
    expect(badgeDescription(1)).toBe("확인할 항목 1개");
    expect(badgeDescription(3)).toBe("확인할 항목 3개");
    expect(badgeDescription(150)).toBe("확인할 항목 99+개");
  });

  it("says why a picked program is not used in Korean (the log keeps the English reason)", () => {
    expect(refusalText("the file must be named claude.exe or claude.cmd", "claude", "win32")).toBe("파일 이름이 claude.exe 또는 claude.cmd 여야 해요.");
    expect(refusalText("the file must be named gh.exe", "gh", "win32")).toBe("파일 이름이 gh.exe 여야 해요.");
    expect(refusalText("no such file", "git", "win32")).toBe("파일이 없어요.");
    expect(refusalText("not executable", "claude", "darwin")).toBe("실행 권한이 없는 파일이에요.");
    expect(refusalText("not an absolute path", "claude", "win32")).toBe("전체 경로가 아니에요.");
    expect(refusalText("not a path", "claude", "win32")).toBe("파일 경로가 아니에요.");
    expect(refusalText("no such version", "claude", "win32")).toBe("설치되지 않은 버전이에요.");
    expect(refusalText("not a version", "claude", "win32")).toBe("버전 이름이 아니에요.");
    // Anything this client does not know stays as main wrote it.
    expect(refusalText("something else", "claude", "win32")).toBe("something else");
  });
});
