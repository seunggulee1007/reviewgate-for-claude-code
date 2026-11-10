import { describe, expect, it } from "vitest";
import type { CodeGraphEvent, UserMod } from "@reviewgate/engine";
import { ago, applyCodeGraphEvent, buildBlockedReason, buildLine, fileName, freshness, freshnessLabel, graphRefusal, looksLikeGraphHtml, modState, share, useCodeGraph } from "./codeGraph";
import { EngineRefusal } from "./engineRequest";

/** wave5 w5-graph — docs/PROTOCOL.md §43.3 on Electron: the Mac's code graph rules (Core `CodeGraphText` / `CodeGraphStore`). */

const reply = (more: Partial<CodeGraphEvent> = {}): CodeGraphEvent => ({
  type: "code_graph",
  root: "/w/shop",
  reportPath: "/w/shop/graphify-out/GRAPH_REPORT.md",
  builtAt: "2026-10-20T01:02:03.000Z",
  report: {
    name: "shopfront", date: "2026-10-20", files: 1204, words: 310552, nodes: 9876, edges: 32100, communities: 210,
    extractedPct: 91, inferredPct: 9, ambiguousPct: 0, commit: "1a2b3c4d", hubs: ["OrderService"], hubCount: 5,
    gods: [{ name: "OrderService", edges: 1230 }], surprises: [], bigCommunities: [{ id: 1, name: "CartController", nodes: 310, cohesion: 0.11 }], isolated: 812,
  },
  head: "9f8e7d6c",
  behind: 37,
  htmlPath: "/w/shop/graphify-out/graph.html",
  graphify: "/u/.local/bin/graphify",
  outIgnored: true,
  build: null,
  ...more,
});

describe("code graph rules (§43.3)", () => {
  it("freshness: behind, fresh, a commit this repository lacks, a report without git", () => {
    expect(freshness(reply())).toEqual({ kind: "behind", commits: 37 });
    expect(freshnessLabel({ kind: "behind", commits: 37 })).toBe("37 commits behind HEAD");
    expect(freshness(reply({ behind: 0 }))).toEqual({ kind: "fresh" });
    expect(freshness(reply({ behind: null }))).toEqual({ kind: "unknown" });
    expect(freshness(reply({ report: { ...reply().report!, commit: null } }))).toEqual({ kind: "noCommit" });
    expect(freshness(reply({ report: null }))).toBeNull();
  });

  it("one reason a build cannot run, in the Mac's order", () => {
    expect(buildBlockedReason(reply(), false)).toBeNull();
    expect(buildBlockedReason(reply(), true)).toContain("update ReviewGate");
    expect(buildBlockedReason(null, false)).toBe("Reading the code graph…");
    expect(buildBlockedReason(reply({ build: { running: true, startedAt: "x" } }), false)).toBe("A build is running");
    expect(buildBlockedReason(reply({ outIgnored: false, build: { running: true, startedAt: "x" } }), false)).toContain(".gitignore");
    expect(buildBlockedReason(reply({ graphify: null, outIgnored: false }), false)).toBe("graphify is not installed");
    expect(graphRefusal("graph_out_not_ignored", "x")).toContain("graphify-out/");
    expect(graphRefusal("unknown_command", "x")).toContain("update ReviewGate");
    expect(graphRefusal("other", "fallback")).toBe("fallback");
  });

  it("the build line, the age of the report, bars, file names, graph.html and the mods' state", () => {
    const now = Date.parse("2026-10-24T10:01:20Z");
    expect(buildLine({ running: true, startedAt: "2026-10-24T10:00:00.000Z", line: "Re-extracting code files" }, now)).toBe("Building… 1m 20s · Re-extracting code files");
    expect(buildLine({ running: false, startedAt: "2026-10-24T10:00:00Z", finishedAt: "2026-10-24T10:02:05Z", ok: true, line: "Rebuilt: 9 nodes" }, now)).toBe("Last build succeeded · 2m 05s · Rebuilt: 9 nodes");
    expect(buildLine({ running: false, startedAt: "2026-10-24T10:00:00Z", finishedAt: "2026-10-24T10:00:03Z", ok: false, exitCode: 1, line: "ValueError: boom" }, now)).toBe("Last build failed · 3.0s · ValueError: boom");
    expect(buildLine({ running: false, startedAt: "x", ok: false, timedOut: true }, now)).toBe("The build ran over 10 minutes and was stopped");
    expect(ago("2026-10-24T10:01:00Z", now)).toBe("just now");
    expect(ago("2026-10-24T09:41:20Z", now)).toBe("20 min ago");
    expect(ago("2026-10-20T10:00:00Z", now)).toBe("4 d ago");
    expect(ago("nope", now)).toBeNull();
    expect(share(0, 10)).toBe(0);
    expect(share(1, 1000)).toBe(0.02);
    expect(share(5, 0)).toBe(0);
    expect(fileName("src\\main\\B.java")).toBe("B.java");
    expect(looksLikeGraphHtml("/w/shop/graphify-out/graph.html")).toBe(true);
    expect(looksLikeGraphHtml("C:\\w\\shop\\graphify-out\\graph.html")).toBe(true);
    expect(looksLikeGraphHtml("/w/shop/graph.html")).toBe(false);
    expect(looksLikeGraphHtml("relative/graphify-out/graph.html")).toBe(false);
    const mod: UserMod = { name: "demo-board", description: "", path: "/m", source: "dev", loaded: false, hasHooks: true };
    expect(modState(mod)).toBe("Loads only in the Claude Code session that made it");
    expect(modState({ ...mod, loaded: true })).toBe("Loaded in this session");
    expect(modState({ ...mod, source: "plugin_dirs" })).toBe("Not loaded in this session");
  });
});

describe("the tab's store", () => {
  it("keeps the last reply, says why a request failed, marks an older engine, takes emitted events", async () => {
    const s = useCodeGraph.getState();
    s.reset();
    const sent: string[] = [];
    await s.refresh({ request: async () => reply() as never, requestDetailed: async (cmd) => (sent.push(cmd.type), { ok: true as const, reply: reply() as never }) });
    expect(useCodeGraph.getState().reply?.behind).toBe(37);
    await s.build({ request: async () => ({}) as never, requestDetailed: async (cmd) => (sent.push(cmd.type), { ok: false as const, error: "graphify_missing", code: "graphify_missing" }) });
    expect(useCodeGraph.getState().error).toBe("graphify is not installed");
    expect(useCodeGraph.getState().reply?.behind).toBe(37);
    await s.refresh({ request: async () => { throw new EngineRefusal("unknown command: code_graph", "unknown_command"); } });
    expect(useCodeGraph.getState().unsupported).toBe(true);
    expect(sent).toEqual(["code_graph", "code_graph_build"]);
    expect(applyCodeGraphEvent(reply({ build: { running: false, startedAt: "x", ok: true } }))).toBe(true);
    expect(useCodeGraph.getState().reply?.build?.ok).toBe(true);
    expect(useCodeGraph.getState().error).toBeNull();
    expect(applyCodeGraphEvent({ type: "log", level: "info", message: "x" })).toBe(false);
    s.reset();
    expect(useCodeGraph.getState()).toMatchObject({ reply: null, error: null, unsupported: false });
  });
});
