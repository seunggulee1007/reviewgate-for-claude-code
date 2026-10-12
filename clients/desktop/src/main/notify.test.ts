import { describe, expect, it } from "vitest";
import { AttentionCounter, badgeDescription, Coalescer, dotBitmap, shouldNotify, validateNotify } from "./notify.js";
import { linesOf, mergedAllowPatterns } from "./projectPatterns.js";
import { projectRootHash } from "../shared/hash.js";
import { sanitizeSettingsPatch } from "./settingsGuard.js";

describe("validateNotify", () => {
  it("accepts an allowlisted kind with bounded text", () => {
    expect(validateNotify({ kind: "turn_done", title: "ReviewGate", body: "3개 파일 검토 대기", key: "turn:1" })).toEqual({ kind: "turn_done", title: "ReviewGate", body: "3개 파일 검토 대기", key: "turn:1" });
    expect(validateNotify({ kind: "plan", title: "t", body: "", key: "k" })?.body).toBe("");
    // §29: a message another Claude session sent, held for the user.
    expect(validateNotify({ kind: "peer_message", title: "ReviewGate", body: "acme-b4 세션이 메시지를 보냈어요", key: "peer:1" })?.kind).toBe("peer_message");
    // MARK: wave3 desktop-agents — §36.4: the subagents the main turn waited on have all finished (once per turn).
    expect(validateNotify({ kind: "agents_done", title: "ReviewGate", body: "서브에이전트가 모두 끝났어요 — Claude가 이어서 작업 중", key: "agents:1" })?.kind).toBe("agents_done");
  });

  it("refuses unknown kinds, wrong types and non-plain objects", () => {
    expect(validateNotify({ kind: "shell", title: "t", body: "b", key: "k" })).toBeNull();
    expect(validateNotify({ kind: "error", title: 1, body: "b", key: "k" })).toBeNull();
    expect(validateNotify({ kind: "error", title: "t", body: "b" })).toBeNull();
    expect(validateNotify({ kind: "error", title: "t\0", body: "b", key: "k" })).toBeNull();
    expect(validateNotify([1])).toBeNull();
    expect(validateNotify(null)).toBeNull();
    expect(validateNotify(Object.create({ kind: "error", title: "t", body: "b", key: "k" }))).toBeNull();
  });

  it("strips control characters and truncates long text", () => {
    const r = validateNotify({ kind: "error", title: "a\nb", body: "x".repeat(1000), key: "k" })!;
    expect(r.title).toBe("a b");
    expect(r.body.length).toBe(400);
    expect(r.body.endsWith("…")).toBe(true);
  });
});

describe("shouldNotify", () => {
  it("only for an unfocused window with the setting on", () => {
    expect(shouldNotify({ enabled: true, focused: false, supported: true })).toBe(true);
    expect(shouldNotify({ enabled: true, focused: true, supported: true })).toBe(false);
    expect(shouldNotify({ enabled: false, focused: false, supported: true })).toBe(false);
    expect(shouldNotify({ enabled: true, focused: false, supported: false })).toBe(false);
  });
});

describe("Coalescer", () => {
  it("drops the same key for the same window within the window, not other keys or windows", () => {
    let now = 1000;
    const c = new Coalescer(5000, () => now);
    expect(c.admit(1, "perm:a")).toBe(true);
    expect(c.admit(1, "perm:a")).toBe(false);
    expect(c.admit(2, "perm:a")).toBe(true);
    expect(c.admit(1, "perm:b")).toBe(true);
    now += 5000;
    expect(c.admit(1, "perm:a")).toBe(true);
    c.forget(1);
    expect(c.admit(1, "perm:a")).toBe(true);
  });
});

describe("AttentionCounter", () => {
  it("sums the unseen counts and clears per window", () => {
    const a = new AttentionCounter();
    a.add(1);
    a.add(1);
    a.add(2);
    expect(a.total()).toBe(3);
    expect(a.count(1)).toBe(2);
    a.clear(1);
    expect(a.total()).toBe(1);
    expect(badgeDescription(0)).toBe("");
    expect(badgeDescription(1)).toBe("1 item needs attention");
    expect(badgeDescription(150)).toBe("99+ items need attention");
  });

  it("builds an opaque dot centre and transparent corners", () => {
    const b = dotBitmap(16);
    expect(b.length).toBe(16 * 16 * 4);
    expect(b[(8 * 16 + 8) * 4 + 3]).toBe(255);
    expect(b[3]).toBe(0);
  });
});

describe("per-project allow patterns", () => {
  const root = "/Users/me/proj";
  const map = { [projectRootHash(root)]: "Bash(npm test:*)\n# note\nBash(git *)" };

  it("appends the open project's lines to the global ones, deduplicated", () => {
    expect(mergedAllowPatterns("Bash(git *)\n", map, root)).toEqual(["Bash(git *)", "Bash(npm test:*)"]);
    expect(mergedAllowPatterns("Bash(make)", map, "/other")).toEqual(["Bash(make)"]);
    expect(mergedAllowPatterns("Bash(make)", map, null)).toEqual(["Bash(make)"]);
    expect(mergedAllowPatterns("", undefined, root)).toEqual([]);
    expect(linesOf(" a \r\n\n#x\nb")).toEqual(["a", "b"]);
  });

  it("settingsGuard accepts only hash keys with text values", () => {
    expect(sanitizeSettingsPatch({ projectBashAllowPatterns: { "0a1b2c3d": "Bash(npm test:*)" }, notifications: false, notificationSound: true }).rejected).toEqual([]);
    expect(sanitizeSettingsPatch({ projectBashAllowPatterns: { "../x": "a" } }).rejected).toEqual(["projectBashAllowPatterns"]);
    expect(sanitizeSettingsPatch({ projectBashAllowPatterns: { "0a1b2c3d": 1 } }).rejected).toEqual(["projectBashAllowPatterns"]);
    expect(sanitizeSettingsPatch({ projectBashAllowPatterns: ["a"] }).rejected).toEqual(["projectBashAllowPatterns"]);
    expect(sanitizeSettingsPatch({ notifications: "yes" }).rejected).toEqual(["notifications"]);
  });
});
