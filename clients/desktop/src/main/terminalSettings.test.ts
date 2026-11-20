// §57.17 "Terminal chat (preview)": off by default; a terminal chat by default only while the preview is on and chosen.
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.5.17", getPath: () => "/tmp/rg-user-data" },
  nativeTheme: { themeSource: "system" },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

import { DEFAULTS, engineSettings, newChatKindOf } from "./settings";

describe("terminal chat (preview) settings (§57.17)", () => {
  it("defaults: preview off, chats, auto GPU, PowerShell, full repaint, 13 pt", () => {
    expect(DEFAULTS).toMatchObject({ terminalChatPreview: false, newChatKind: "chat", terminalGpu: "auto", terminalShell: "powershell", terminalFullRepaint: true, terminalFontSize: 13 });
  });

  it("newChatKind goes to the engine as terminal only while the preview is on", () => {
    expect(engineSettings({ ...DEFAULTS }, null).newChatKind).toBe("chat");
    expect(engineSettings({ ...DEFAULTS, newChatKind: "terminal" }, null).newChatKind).toBe("chat"); // preview off
    expect(engineSettings({ ...DEFAULTS, terminalChatPreview: true }, null).newChatKind).toBe("chat");
    expect(engineSettings({ ...DEFAULTS, terminalChatPreview: true, newChatKind: "terminal" }, null).newChatKind).toBe("terminal");
    expect(newChatKindOf({})).toBe("chat"); // an older settings file
  });
});
