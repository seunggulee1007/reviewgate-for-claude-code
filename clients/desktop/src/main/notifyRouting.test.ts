// MARK: wave4b w4-notify — notifications you notice (§39.6): the click's target, one switch per group, the Windows AUMID.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appUserModelId, APP_USER_MODEL_ID, groupEnabled, notificationSettingsUrl, notifyGroupOf, validateNotify } from "./notify.js";
import { sanitizeSettingsPatch } from "./settingsGuard.js";

describe("the click's target", () => {
  it("keeps the chat and the request a click opens", () => {
    const r = validateNotify({ kind: "permission", title: "t", body: "b", key: "perm:r1", target: { chatId: "chat-1", requestId: "r1" } });
    expect(r?.target).toEqual({ chatId: "chat-1", requestId: "r1" });
    expect(validateNotify({ kind: "turn_done", title: "t", body: "b", key: "k", target: { chatId: "c" } })?.target).toEqual({ chatId: "c" });
  });

  it("drops a target it cannot trust, never the notification", () => {
    const bad = [{ chatId: 1 }, { requestId: "x".repeat(300) }, { chatId: "a\nb" }, [1], "chat", null, Object.create({ chatId: "c" })];
    for (const target of bad) {
      const r = validateNotify({ kind: "permission", title: "t", body: "b", key: "k", target });
      expect(r?.kind).toBe("permission");
      expect(r?.target).toBeUndefined();
    }
    expect(validateNotify({ kind: "permission", title: "t", body: "b", key: "k" })).toEqual({ kind: "permission", title: "t", body: "b", key: "k" });
  });
});

describe("one switch per group (Settings › Notifications, as on the Mac)", () => {
  it("sorts every kind into waiting / finished work / everything else", () => {
    for (const k of ["permission", "question", "plan"] as const) expect(notifyGroupOf(k)).toBe("waiting");
    expect(notifyGroupOf("turn_done")).toBe("turnEnd");
    for (const k of ["error", "side_answer", "peer_message", "agents_done"] as const) expect(notifyGroupOf(k)).toBe("other");
  });

  it("is on until turned off; the renderer may write the switches", () => {
    expect(groupEnabled({}, "waiting")).toBe(true);
    expect(groupEnabled({ notifyTurnEnd: false }, "turnEnd")).toBe(false);
    expect(groupEnabled({ notifyTurnEnd: false }, "other")).toBe(true);
    const { patch, rejected } = sanitizeSettingsPatch({ notifyWaiting: false, notifyTurnEnd: true, notifyOther: false, notificationsHintDismissed: true, notifyOther2: true });
    expect(patch).toEqual({ notifyWaiting: false, notifyTurnEnd: true, notifyOther: false, notificationsHintDismissed: true });
    expect(rejected).toEqual(["notifyOther2"]);
    expect(sanitizeSettingsPatch({ notifyWaiting: "no" }).rejected).toEqual(["notifyWaiting"]);
  });
});

describe("Windows shows the toasts of the installed app", () => {
  it("uses the installer's appId as AppUserModelId (the Start menu shortcut carries it)", () => {
    const yml = readFileSync(fileURLToPath(new URL("../../electron-builder.yml", import.meta.url)), "utf8");
    expect(yml).toMatch(new RegExp(`^appId: ${APP_USER_MODEL_ID.replace(/\./g, "\\.")}$`, "m"));
    expect(appUserModelId(true, "C:\\Program Files\\ReviewGate\\ReviewGate.exe")).toBe(APP_USER_MODEL_ID);
    // Run from a checkout (no shortcut): Electron's advice is the executable's path.
    expect(appUserModelId(false, "C:\\dev\\electron.exe")).toBe("C:\\dev\\electron.exe");
  });

  it("opens the OS notification settings by a fixed address only", () => {
    expect(notificationSettingsUrl("win32")).toBe("ms-settings:notifications");
    expect(notificationSettingsUrl("darwin")).toMatch(/^x-apple\.systempreferences:/);
    expect(notificationSettingsUrl("linux")).toBeNull();
  });
});
