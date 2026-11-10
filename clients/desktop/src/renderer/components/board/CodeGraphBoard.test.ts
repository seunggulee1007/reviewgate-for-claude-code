/**
 * MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3: the code graph tab and the mods section as they render (react-dom/server;
 * the window mocked as in the other store tests). A server render reads the stores' first snapshots, so the tab is drawn
 * from its pure view with props; effects (the 15 s poll) do not run.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodeGraphEvent, SessionExtensions } from "@reviewgate/engine";

type ViewProps = { root: string | null; reply: CodeGraphEvent | null; error: string | null; unsupported: boolean; now: number };
let CodeGraphView: FunctionComponent<ViewProps>;
let replyFor: (root: string | null, last: CodeGraphEvent | null) => CodeGraphEvent | null;
let ModsSection: FunctionComponent<{ ext: SessionExtensions }>;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }),
      setSettings: async () => ({}),
      notify: async () => true,
      onEvent: () => () => undefined,
      openGraphHtml: async () => "",
      showItemInFolder: async () => undefined,
      platform: "win32",
    },
  };
  const board = await import("./CodeGraphBoard");
  CodeGraphView = board.CodeGraphView;
  replyFor = board.replyFor;
  ModsSection = (await import("../extensions/Mods")).ModsSection;
});

const ROOT = "/w/shop";
const reply = (more: Partial<CodeGraphEvent> = {}): CodeGraphEvent => ({
  type: "code_graph",
  root: ROOT,
  reportPath: `${ROOT}/graphify-out/GRAPH_REPORT.md`,
  builtAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  report: {
    name: "shopfront", date: "2026-10-20", files: 1204, words: 310552, nodes: 9876, edges: 32100, communities: 210,
    extractedPct: 91, inferredPct: 9, ambiguousPct: 0, commit: "1a2b3c4d", hubs: ["OrderService", "CartController"], hubCount: 5,
    gods: [{ name: "OrderService", edges: 1230 }, { name: "Money", edges: 640 }],
    surprises: [{ from: "refund()", relation: "calls", to: "values()", confidence: "INFERRED", fromFile: "src/a/RefundPolicy.java", toFile: "src/b/Report.java" }],
    bigCommunities: [{ id: 1, name: "CartController", nodes: 310, cohesion: 0.11 }, { id: 2, name: "PaymentGateway", nodes: 45, cohesion: null }],
    isolated: 812,
  },
  head: "9f8e7d6c",
  behind: 37,
  htmlPath: `${ROOT}/graphify-out/graph.html`,
  graphify: "/u/.local/bin/graphify",
  outIgnored: true,
  build: null,
  ...more,
});

const render = (r: CodeGraphEvent | null, more: Partial<ViewProps> = {}) =>
  renderToStaticMarkup(createElement(CodeGraphView, { root: ROOT, reply: r, error: null, unsupported: false, now: Date.now(), ...more }));

describe("code graph tab (§43.3)", () => {
  it("shows the numbers, the freshness, the bars, the surprises and the hubs of the report", () => {
    const html = render(reply());
    expect(html).toContain("37 commits behind HEAD");
    expect(html).toContain("9,876");
    expect(html).toContain("32,100");
    expect(html).toContain("Most connected nodes");
    expect(html).toContain('aria-label="OrderService, 1,230 edges"');
    expect(html).toContain("Community sizes");
    expect(html).toContain("Cohesion 0.11");
    expect(html).toContain("RefundPolicy.java → Report.java");
    expect(html).toContain("and 3 more");
    expect(html).toContain("Built 3 d ago");
    expect(html).toMatch(/<button[^>]*data-testid="Rebuild code graph"/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="Rebuild code graph"/);
  });

  it("an empty repository offers [만들기], disabled with the reason and the install line without graphify", () => {
    const html = render(reply({ report: null, reportPath: null, graphify: null, behind: null }));
    expect(html).toContain("No code graph yet");
    expect(html).toContain("Only code files go in (like Java)");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="Rebuild code graph"/);
    expect(html).toContain("graphify is not installed");
    expect(html).toContain("uv tool install graphifyy");
  });

  it("a running build shows its line; another project's reply is not shown; an older engine says to update", () => {
    expect(render(reply({ build: { running: true, startedAt: new Date().toISOString(), line: "Re-extracting code files" } }))).toContain("Re-extracting code files");
    expect(replyFor(ROOT, reply({ root: "/elsewhere" }))).toBeNull();
    expect(replyFor(null, reply())).toBeNull();
    expect(replyFor(ROOT, reply())?.root).toBe(ROOT);
    expect(render(null)).toContain("Reading the code graph…");
    expect(render(null, { unsupported: true })).toContain("update ReviewGate");
    expect(render(reply(), { root: null })).toContain("Open a project first");
    expect(render(reply(), { error: "graphify is not installed" })).toContain("graphify is not installed");
  });
});

describe("mods section (§43.3)", () => {
  it("lists each mod with its state and the note; nothing without mods", () => {
    const ext = {
      mods: [
        { name: "demo-board", description: "샘플 보드", version: "0.1.0", path: "/u/.claude/dev-mods/s1/demo-board", source: "dev", sessionId: "s1", loaded: false, hasHooks: true },
        { name: "demo-mod", description: "", path: "/m/demo-mod", source: "plugin_dirs", loaded: true, hasHooks: false },
      ],
    } as unknown as SessionExtensions;
    const html = renderToStaticMarkup(createElement(ModsSection, { ext }));
    expect(html).toContain("demo-board");
    expect(html).toContain("Loads only in the Claude Code session that made it");
    expect(html).toContain("Loaded in this session");
    expect(html).toContain("Mod panels do not show in the app");
    expect(html).toContain("Ctrl+Alt+B");
    expect(html).toContain("Show in Explorer");
    expect(renderToStaticMarkup(createElement(ModsSection, { ext: {} as SessionExtensions }))).toBe("");
  });
});
