import { afterEach, describe, expect, it } from "vitest";
import type { BrainEvent, BrainMemory, EngineCommand } from "@reviewgate/engine";
import { agentName, brainGraph, brainLayout, HUB_ID, LAYOUT_MARGIN, readable, writerAgentType, writerAvatar, writerLabel } from "./subBrain";
import { avatarOf, MAIN_AVATAR } from "./agentAvatar";
import { useSubBrain } from "./subBrainStore";
import { EngineRefusal } from "./engineRequest";

/** docs/PROTOCOL.md §43.2: the board's sub-brain tab — the graph, its layout, the words and the store (the Mac's SubBrainTests). */

function memory(name: string, type: BrainMemory["type"], extra: Partial<BrainMemory> = {}): BrainMemory {
  return { name, type, description: "", mtime: 0, size: 10, indexed: true, links: [], ...extra };
}

function snapshot(memories: BrainMemory[], extra: Partial<BrainEvent> = {}): BrainEvent {
  return {
    type: "brain", dir: "/m", exists: true, memories, counts: { user: 0, feedback: 0, project: 0, reference: 0, other: 0 }, hasIndex: true,
    unindexed: [], missing: [], brokenLinks: [], changes: [], tally: { add: 0, change: 0, remove: 0 }, sessionCount: 0, baselineAt: 1, scannedAt: 1,
    ...extra,
  };
}

describe("the memory graph", () => {
  it("puts MEMORY.md first, sorts by kind then name, links each pair once and the hub to indexed memories", () => {
    const g = brainGraph(snapshot([
      memory("project_a", "project", { links: ["reference_b", "missing", "project_a"] }),
      memory("reference_b", "reference", { links: ["project_a"] }),
      memory("user_c", "user", { indexed: false }),
    ]));
    expect(g.nodes.map((n) => n.id)).toEqual([HUB_ID, "user_c", "project_a", "reference_b"]);
    expect(g.edges.filter((e) => !e.index)).toHaveLength(1);
    expect(g.edges.filter((e) => e.index)).toHaveLength(2);
    expect(g.nodes.find((n) => n.id === "project_a")?.degree).toBe(2);
    expect(brainGraph(snapshot([memory("user_c", "user")]), new Set(["user"])).nodes).toEqual([]);
    expect(brainGraph(snapshot([memory("a", "other")], { hasIndex: false })).nodes.some((n) => n.type === null)).toBe(false);
  });

  it("over the cap draws this session's memories, then the most linked, then the newest; the rest are 'N개 더'", () => {
    const many = Array.from({ length: 10 }, (_, i) => memory(`reference_${i}`, "reference", { mtime: i }));
    many.push(memory("project_hot", "project", { mtime: -1, session: "add" }));
    many[0]!.links = ["reference_1"];
    const g = brainGraph(snapshot(many, { hasIndex: false }), new Set(), 3);
    expect(g.hidden).toBe(8);
    expect(new Set(g.nodes.map((n) => n.id))).toEqual(new Set(["project_hot", "reference_0", "reference_1"]));
  });
});

describe("the layout", () => {
  it("is the same for the same graph, stays in the frame with the hub in the middle, and pulls linked memories together", () => {
    const mems = Array.from({ length: 24 }, (_, i) => memory(`reference_${i}`, "reference"));
    mems[0]!.links = ["reference_1"];
    const g = brainGraph(snapshot(mems));
    const a = brainLayout(g, { width: 800, height: 600, seed: 3 });
    expect(brainLayout(g, { width: 800, height: 600, seed: 3 })).toEqual(a);
    expect(a).toHaveLength(g.nodes.length);
    expect(a[0]).toEqual({ x: 400, y: 300 });
    for (const p of a) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(LAYOUT_MARGIN);
      expect(p.x).toBeLessThanOrEqual(800 - LAYOUT_MARGIN);
    }
    const at = (id: string) => a[g.nodes.findIndex((n) => n.id === id)]!;
    const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
    const others: number[] = [];
    for (let i = 4; i < 24; i++) for (let j = i + 1; j < 24; j++) others.push(dist(at(`reference_${i}`), at(`reference_${j}`)));
    expect(dist(at("reference_0"), at("reference_1"))).toBeLessThan(others.reduce((x, y) => x + y, 0) / others.length);
    expect(brainLayout({ nodes: [], edges: [], hidden: 0 })).toEqual([]);
  });

  it("a star around MEMORY.md of 40 or 140 memories leaves nothing pinned to the frame", () => {
    for (const count of [40, 140]) {
      const g = brainGraph(snapshot(Array.from({ length: count }, (_, i) => memory(`project_${i}`, "project"))));
      const pts = brainLayout(g);
      expect(pts.filter((p) => p.x <= 24.5 || p.x >= 975.5 || p.y <= 24.5 || p.y >= 675.5)).toEqual([]);
    }
  });
});

describe("words", () => {
  it("names writers and agent types as the Mac does, and shows a memory's body", () => {
    expect(agentName("oh-my-claudecode:executor")).toBe("executor");
    expect(agentName("general-purpose")).toBe("general");
    expect(writerLabel({ by: "main" })).toBe("Claude");
    expect(writerLabel({ by: "agent", agentType: "oh-my-claudecode:writer" })).toBe("writer");
    expect(writerLabel({ by: "external" })).toBe("External");
    expect(writerAgentType({ by: "agent", agentType: "x:y" })).toBe("x:y");
    expect(writerAgentType({ by: "main" })).toBeNull();
    // The board's faces (§43.1) beside the writer: Claude's star, the type's face, none from outside (the Mac's writerAvatar).
    expect(writerAvatar({ by: "main" })).toEqual(MAIN_AVATAR);
    expect(writerAvatar({ by: "agent", agentType: "oh-my-claudecode:writer" })).toEqual(avatarOf("oh-my-claudecode:writer"));
    expect(writerAvatar({ by: "agent", agentType: "oh-my-claudecode:writer" })?.icon).toBe("pencil");
    expect(writerAvatar({ by: "external" })).toBeNull();
    expect(readable("---\nname: a\ntype: user\n---\n\nbody line\n")).toBe("body line");
    expect(readable("no frontmatter")).toBe("no frontmatter");
    expect(readable("---\nname: only\n---\n")).toBe("---\nname: only\n---\n");
  });
});

describe("the store", () => {
  afterEach(() => {
    useSubBrain.getState().setRequest(null);
    useSubBrain.setState({ snapshot: null, unsupported: false, selected: null, text: null, textError: null, hidden: [], error: null });
  });

  it("watches while shown, reads the selected memory, stops, and closes the panel when the memory goes away", async () => {
    const sent: EngineCommand[] = [];
    const snap = snapshot([memory("project_a", "project")], { watching: true });
    useSubBrain.getState().setRequest((async (cmd: EngineCommand) => {
      sent.push(cmd);
      if (cmd.type === "brain") return snap;
      if (cmd.type === "brain_read") return { type: "brain_memory", name: cmd.name, path: `/m/${cmd.name}.md`, text: "body" };
      throw new Error("unexpected");
    }) as never);
    const s = useSubBrain.getState();
    await s.start();
    expect(useSubBrain.getState().snapshot).toEqual(snap);
    await s.select("project_a");
    expect(useSubBrain.getState().text?.text).toBe("body");
    await s.select(HUB_ID);
    expect(useSubBrain.getState().text).toBeNull();
    await s.stop();
    expect(sent).toEqual([{ type: "brain", watch: true }, { type: "brain_read", name: "project_a" }, { type: "brain", watch: false }]);
    await s.select("project_a");
    s.apply(snapshot([]));
    expect(useSubBrain.getState().selected).toBeNull();
    s.toggle("user");
    expect(useSubBrain.getState().hidden).toEqual(["user"]);
    s.toggle("user");
    expect(useSubBrain.getState().hidden).toEqual([]);
  });

  it("an older engine refuses brain: the tab says so instead of an empty folder", async () => {
    useSubBrain.getState().setRequest((async () => {
      throw new EngineRefusal("unknown command: brain", "unknown_command");
    }) as never);
    await useSubBrain.getState().start();
    expect(useSubBrain.getState().unsupported).toBe(true);
    expect(useSubBrain.getState().snapshot).toBeNull();
  });
});
