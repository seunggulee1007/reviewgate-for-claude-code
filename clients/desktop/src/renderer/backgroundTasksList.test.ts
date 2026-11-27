// docs/PROTOCOL.md §71.3: `/tasks` (`/bashes`) — the background work with each task's output tail. As Core BackgroundTasksListTests.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outputTail, tasksDescription } from "./background";
import { initI18n, t } from "./i18n";
import { appCommandDescription, parseSlashAppCommand, TERMINAL_ONLY } from "./slashAppCommands";

beforeAll(() => initI18n("en", "win32"));
afterAll(() => initI18n("en", "win32"));

describe("§71.3 the output's tail", () => {
  it("the last three non-empty lines — colors and \\r redraws out, each at most 240 characters", () => {
    expect(outputTail("one\ntwo\n\nthree\nfour\n")).toEqual(["two", "three", "four"]);
    expect(outputTail("\x1b[32mready\x1b[0m in 120 ms\n")).toEqual(["ready in 120 ms"]);
    expect(outputTail("progress 10%\rprogress 50%\rprogress 100%\n")).toEqual(["progress 100%"]);
    expect(outputTail("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(outputTail("   \n\n")).toEqual([]);
    expect(outputTail("x".repeat(500))[0]).toHaveLength(240);
    expect(outputTail("1\n2\n3\n4\n5", 2)).toEqual(["4", "5"]);
  });
});

describe("§71.3 /tasks", () => {
  it("is the app's own, /bashes its alias", () => {
    expect(parseSlashAppCommand("/tasks", [])).toEqual({ kind: "tasks" });
    expect(parseSlashAppCommand("/bashes", [])).toEqual({ kind: "tasks" });
    expect(appCommandDescription("bashes")).toBe(tasksDescription());
    expect(TERMINAL_ONLY.has("tasks")).toBe(false);
  });

  it("the hint names Windows' key; the Korean comes from the Mac's catalog", () => {
    expect(t("While Claude runs a command, ⌃B in the empty message box moves it here.")).toContain("Ctrl+B");
    initI18n("ko", "win32");
    expect(t("Background tasks")).toBe("백그라운드 작업");
    expect(t("While Claude runs a command, ⌃B in the empty message box moves it here.")).toContain("Ctrl+B");
  });
});
