/**
 * MARK: wave5 w5-fixes — §43.5: the "plan vs actual" basis menu on the newest turn summary card, as it renders
 * (react-dom/server; the store loads with the window mocked as in TurnSummaryCard.test.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanSourceState, TurnSummaryEvent, TurnSummaryFile } from "@reviewgate/engine";

type Store = typeof import("../../store").useStore;
let useStore: Store;
let TurnSummaryCard: FunctionComponent<{ id: number; summary: TurnSummaryEvent }>;

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
      platform: "darwin",
    },
  };
  useStore = (await import("../../store")).useStore;
  TurnSummaryCard = (await import("./TurnSummaryCard")).TurnSummaryCard;
});

const file = (path: string): TurnSummaryFile => ({ path, status: "M", state: "pending", adds: 2, dels: 1, why: null, whyToolUseId: null, tools: ["Edit"], toolUseIds: ["e1"] });
const summary = (more: Partial<TurnSummaryEvent> = {}): TurnSummaryEvent => ({ type: "turn_summary", turn: 3, files: [file("src/a.ts")], commands: [], plan: null, ...more });
const withSource = (source: PlanSourceState | undefined, rows: { id: number; s: TurnSummaryEvent }[]) => {
  const initial = useStore.getInitialState();
  initial.transcript = rows.map(({ id, s }) => ({ kind: "turnSummary" as const, id, summary: s }));
  initial.state = { ...initial.state, session: { ...initial.state.session, planSource: source } };
};
const render = (id: number, s: TurnSummaryEvent) => renderToStaticMarkup(createElement(TurnSummaryCard, { id, summary: s }));

describe("the basis menu on the turn summary (§43.5)", () => {
  const source: PlanSourceState = { kind: "file", path: ".omc/plans/db-migration.md", candidates: [".omc/plans/db-migration.md", "docs/batch-plan.md"] };
  const planned = summary({ plan: { path: "/repo/.omc/plans/db-migration.md", steps: [{ index: 1, text: "Update a.ts", files: ["src/a.ts"] }], unplannedFiles: [], source: "file", title: "db-migration.md" } });

  it("the newest card's plan section carries it; an older card does not", () => {
    withSource(source, [{ id: 1, s: planned }, { id: 2, s: planned }]);
    const newest = render(2, planned);
    expect(newest).toContain('data-testid="Plan basis menu"');
    expect(newest).toContain("Basis: Automatic · db-migration.md");
    expect(render(1, planned)).not.toContain("Plan basis menu");
  });

  it("a summary without a plan shows the line with the menu, so a plan file can be chosen", () => {
    const plain = summary();
    withSource({ kind: null, candidates: ["docs/batch-plan.md"] }, [{ id: 5, s: plain }]);
    const html = render(5, plain);
    expect(html).toContain('data-testid="Plan basis line"');
    expect(html).toContain("This turn had no plan to compare against");
    expect(html).toContain("Basis: Automatic");
  });

  it("every step of the live chat's plan section has its '왜?' (§43.5)", () => {
    withSource(source, [{ id: 9, s: planned }]);
    const initial = useStore.getInitialState();
    const before = initial.state;
    initial.state = { ...before, project: { root: "/repo" } as typeof before.project }; // the ask buttons need an open project
    try {
      expect(render(9, planned)).toContain('data-testid="Plan step why 2"');
    } finally {
      initial.state = before;
    }
  });

  it("an engine without planSource shows neither", () => {
    const plain = summary();
    withSource(undefined, [{ id: 7, s: plain }, { id: 8, s: planned }]);
    expect(render(7, plain)).not.toContain("Plan basis");
    expect(render(8, planned)).not.toContain("Plan basis");
  });
});
