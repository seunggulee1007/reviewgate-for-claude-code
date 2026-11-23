import { afterAll, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { displayChatTitle, NEW_CHAT_TITLE } from "./sessions";

// The engine stores a fresh chat's name as "New chat"; the client shows it (and an empty title) in the UI language.

describe("a chat's default name", () => {
  afterAll(() => initI18n("en", "darwin"));

  it("shows in the UI language; any other title as it is", () => {
    expect(NEW_CHAT_TITLE).toBe("New chat"); // the engine's stored name
    initI18n("ko", "win32");
    expect(displayChatTitle("New chat")).toBe("새 채팅");
    expect(displayChatTitle("  ")).toBe("새 채팅");
    expect(displayChatTitle("Fix the cart total")).toBe("Fix the cart total");
    initI18n("en", "darwin");
    expect(displayChatTitle("New chat")).toBe("New chat");
  });
});
