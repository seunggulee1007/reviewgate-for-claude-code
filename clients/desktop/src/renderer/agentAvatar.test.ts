// MARK: wave5 w5-board — §43.1: the agent board's avatars, tool icons and friendly MCP names (the Mac's AgentBoardTests read
// the same fixture), the tones in board.css, moods, the summary line and the remembered tab.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentNode } from "@reviewgate/engine";
import {
  AVATAR_TONES,
  MAIN_AVATAR,
  avatarOf,
  boardSummary,
  COMPACT_FROM,
  identityIndex,
  mainMood,
  moodMoves,
  moodOf,
  parallelBatches,
  pluginBadge,
  readBoardTab,
  rowDetail,
  summaryParts,
  toolIconOf,
  toolText,
  writeBoardTab,
} from "./agentAvatar";
import { initI18n } from "./i18n";

type Fixture = {
  tones: Record<string, { light: string; dark: string }>;
  types: { type: string; icon: string; tone: string; name: string; badge: string | null }[];
  main: { icon: string; tone: string };
  tools: { tool: string; detail?: string; icon: string; ko: string; en: string }[];
};

const fixture = JSON.parse(readFileSync(new URL("../../../../engine/test/fixtures/agentAvatars.json", import.meta.url), "utf8")) as Fixture;
const css = readFileSync(new URL("./components/board/board.css", import.meta.url), "utf8");

const node = (id: string, over: Partial<AgentNode> = {}): AgentNode => ({
  id,
  toolUseId: id,
  type: "executor",
  description: "",
  status: "running",
  isBackground: false,
  depth: 1,
  startedAt: 0,
  files: [],
  ...over,
});

afterEach(() => {
  initI18n("en", "darwin");
  vi.unstubAllGlobals();
});

describe("agent avatars (§43.1)", () => {
  it("gives every type the fixture's icon, tone, name and badge", () => {
    expect(fixture.types.length).toBeGreaterThanOrEqual(20);
    for (const c of fixture.types) expect(avatarOf(c.type), c.type).toEqual({ icon: c.icon, tone: c.tone, name: c.name, badge: c.badge });
    expect(MAIN_AVATAR.icon).toBe(fixture.main.icon);
    expect(MAIN_AVATAR.tone).toBe(fixture.main.tone);
  });

  it("hashes an unknown type like the Mac's AgentIdentity.colorIndex", () => {
    const want: Record<string, number> = { executor: 3, architect: 2, Explore: 5, "general-purpose": 6, "test-engineer": 4, debugger: 1, "code-reviewer": 0, analyst: 7 };
    for (const [type, index] of Object.entries(want)) expect(identityIndex(type), type).toBe(index);
    expect(identityIndex("oh-my-claudecode:executor")).toBe(identityIndex("executor"));
  });

  it("has the fixture's tones in board.css — light first, the same dark values in both dark blocks", () => {
    expect([...AVATAR_TONES].sort()).toEqual(Object.keys(fixture.tones).sort());
    for (const tone of AVATAR_TONES) {
      const values = [...css.matchAll(new RegExp(`--av-${tone}:\\s*(#[0-9A-Fa-f]{6})`, "g"))].map((m) => m[1]!.toUpperCase());
      expect(values, tone).toEqual([fixture.tones[tone]!.light, fixture.tones[tone]!.dark, fixture.tones[tone]!.dark]);
    }
  });

  it("names the tool an agent runs: its icon, and the frequent MCP servers' tools in words", () => {
    for (const lang of ["ko", "en"] as const) {
      initI18n(lang, "darwin");
      for (const c of fixture.tools) {
        expect(toolIconOf(c.tool), c.tool).toBe(c.icon);
        expect(toolText(c.tool, c.detail ?? null), `${lang} ${c.tool}`).toBe(lang === "ko" ? c.ko : c.en);
      }
    }
  });
});

describe("moods and the summary line (§43.1)", () => {
  it("reads an agent's mood from its status, its permission wait and its retry", () => {
    expect(moodOf(node("a"), false)).toBe("working");
    expect(moodOf(node("a"), true)).toBe("waiting");
    expect(moodOf(node("a", { retry: { attempt: 2, max: 10, at: 1 } }), false)).toBe("retrying");
    expect(moodOf(node("a", { status: "paused" }), false)).toBe("idle");
    expect(moodOf(node("a", { status: "completed" }), true)).toBe("done");
    expect(moodOf(node("a", { status: "failed" }), false)).toBe("failed");
    expect(moodOf(node("a", { status: "stopped" }), false)).toBe("stopped");
    expect(mainMood(true, false)).toBe("working");
    expect(mainMood(true, true)).toBe("waiting");
    expect(mainMood(false, false)).toBe("idle");
    expect(moodMoves("working") && moodMoves("waiting") && moodMoves("retrying")).toBe(true);
    expect(moodMoves("done") || moodMoves("idle") || moodMoves("failed")).toBe(false);
  });

  it("counts who works, waits and retries, and the distinct agents that came today", () => {
    const now = new Date(2026, 9, 24, 15, 0, 0);
    const today = now.getTime() - 60_000;
    const yesterday = new Date(2026, 9, 23, 23, 59).getTime();
    const agents = [
      node("a", { startedAt: today }),
      node("b", { startedAt: today }),
      node("c", { startedAt: today }),
      node("r", { startedAt: today, retry: { attempt: 1, max: 10, at: today } }),
      node("d", { startedAt: today, status: "completed" }),
    ];
    const history = [node("h1", { startedAt: today, status: "completed" }), node("a", { startedAt: today, status: "completed" }), node("h2", { startedAt: yesterday, status: "completed" })];
    const s = boardSummary(agents, history, (a) => a.toolUseId === "c", true, now);
    expect(s).toEqual({ working: 2, waiting: 2, retrying: 1, today: 6 });
    initI18n("ko", "darwin");
    expect(summaryParts(s).join(" · ")).toBe("지금 2명 일하는 중 · 2명 권한 대기 · 1명 재시도 중 · 오늘 6명 다녀감");
    expect(summaryParts({ working: 0, waiting: 0, retrying: 0, today: 0 })).toEqual(["조용해요 — Claude가 서브에이전트를 부르면 여기 모여요"]);
    expect(summaryParts({ working: 0, waiting: 0, retrying: 0, today: 3 })).toEqual(["모두 쉬는 중", "오늘 3명 다녀감"]);
  });
});

describe("the board's tab per project (§43.1)", () => {
  it("remembers the tab per project and reads anything else as the agents tab", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    expect(readBoardTab("/a")).toBe("agents");
    writeBoardTab("/a", "graph");
    expect(readBoardTab("/a")).toBe("graph");
    expect(readBoardTab("/b")).toBe("agents");
    store.set("rg.board.tab./b", "nonsense");
    expect(readBoardTab("/b")).toBe("agents");
    expect(readBoardTab(null)).toBe("agents");
  });

  it("works without storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readBoardTab("/a")).toBe("agents");
    expect(() => writeBoardTab("/a", "brain")).not.toThrow();
  });
});

describe("the agent panel's layout on Windows (§42.4 with §43.1's colors)", () => {
  it("groups agents that ran at the same time and makes rows from three", () => {
    const a = node("a", { startedAt: 0, endedAt: 100, status: "completed" });
    const b = node("b", { startedAt: 50, endedAt: 150, status: "completed" });
    const c = node("c", { startedAt: 120, status: "running" });
    const d = node("d", { startedAt: 500, endedAt: 600, status: "completed" });
    expect(parallelBatches([a, b, c, d], 400).map((x) => x.map((n) => n.toolUseId))).toEqual([["a", "b", "c"], ["d"]]);
    expect(COMPACT_FROM).toBe(3);
  });

  it("reads a row's second line as the Mac's AgentPanelLayout.rowDetail", () => {
    initI18n("en", "darwin");
    const live = node("1", { description: "TenantService 리팩터링" });
    expect(rowDetail(live, 0)).toBeNull();
    expect(rowDetail({ ...live, lastTool: "Read" }, 0)).toBe("Read");
    expect(rowDetail({ ...live, lastStep: { tool: "Bash", detail: "./gradlew test", since: 0 } }, 4_000)).toBe("Bash · ./gradlew test · 4.0s");
    expect(rowDetail(node("2", { status: "failed", error: "API Error: 529" }), 0)).toBe("API Error: 529");
    expect(rowDetail(node("3", { status: "completed" }), 0)).toBeNull();
    expect(rowDetail(node("3", { status: "completed", summary: "요약", reportPreview: "\n## TenantContext 사용처 14군데\n- api 9" }), 0)).toBe("TenantContext 사용처 14군데");
  });

  it("badges the plugin as the Mac does", () => {
    expect(pluginBadge("oh-my-claudecode:executor")).toBe("OMC");
    expect(pluginBadge("acme-tools:smoke")).toBe("acme-tools");
    expect(pluginBadge("a-very-long-plugin-name:x")).toBe("a-very-long…");
    expect(pluginBadge("executor")).toBeNull();
    expect(pluginBadge(":x")).toBeNull();
  });
});
