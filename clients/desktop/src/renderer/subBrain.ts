/**
 * MARK: wave5 w5-brain — docs/PROTOCOL.md §43.2, the pure part of the board's "서브브레인" tab (unit-tested in
 * subBrain.test.ts): the memory graph (MEMORY.md as the hub, [[links]], a 300-node cap), a seeded force layout, and the
 * words. Same rules and English keys as the Mac (Core `SubBrain.swift`); the engine reads the folder — these only draw it.
 */
import type { BrainChange, BrainChangeKind, BrainEvent, BrainMemory, BrainMemoryType } from "@reviewgate/engine";
import { t } from "./i18n";
import { avatarOf, MAIN_AVATAR, type AgentAvatar } from "./agentAvatar";

/** The board's order of kinds (cards, legend, the graph's starting spiral). */
export const BRAIN_TYPES: readonly BrainMemoryType[] = ["user", "feedback", "project", "reference", "other"];
/** The four kinds that always get a card; `other` only when there is one. */
export const BRAIN_CARD_TYPES: readonly BrainMemoryType[] = ["user", "feedback", "project", "reference"];

export function typeName(type: BrainMemoryType): string {
  switch (type) {
    case "user":
      return t("People");
    case "feedback":
      return t("Feedback");
    case "project":
      return t("Project");
    case "reference":
      return t("Reference");
    default:
      return t("Other");
  }
}

/** A small picture per kind (the Mac's SF Symbols: person, speech bubbles, folder, books, page). */
export function typeIcon(type: BrainMemoryType): string {
  switch (type) {
    case "user":
      return "👤";
    case "feedback":
      return "💬";
    case "project":
      return "📁";
    case "reference":
      return "📚";
    default:
      return "📄";
  }
}

export function verb(kind: BrainChangeKind): string {
  return kind === "add" ? t("Memory added") : kind === "change" ? t("Memory changed") : t("Memory removed");
}

/** `oh-my-claudecode:executor` → `executor`; `general-purpose` → `general`. */
export function agentName(type: string): string {
  const bare = type.split(":").pop() ?? type;
  return bare === "general-purpose" ? "general" : bare;
}

/** Who wrote a change: "Claude", the subagent's type, or "외부". */
export function writerLabel(change: Pick<BrainChange, "by" | "agentType">): string {
  if (change.by === "main") return "Claude";
  if (change.by === "agent") return change.agentType ? agentName(change.agentType) : t("Subagent");
  return t("External");
}

/** The writer's agent type for the board's avatar (w5-board); null for Claude itself and an outside writer. */
export function writerAgentType(change: Pick<BrainChange, "by" | "agentType">): string | null {
  return change.by === "agent" ? change.agentType ?? null : null;
}

/**
 * The writer's face beside "누가 썼나" — the agent board's avatars (§43.1): Claude's star for the main agent, the subagent
 * type's face (a sparkly robot when the type is unknown), none for an outside writer. Same rule as the Mac's `SubBrainText.writerAvatar`.
 */
export function writerAvatar(change: Pick<BrainChange, "by" | "agentType">): AgentAvatar | null {
  if (change.by === "main") return MAIN_AVATAR;
  if (change.by === "agent") return avatarOf(change.agentType ?? "");
  return null;
}

export const memoryLabel = (m: Pick<BrainMemory, "name" | "title">): string => (m.title?.trim() ? m.title : m.name);

/** A memory's text as the panel shows it: the body after the frontmatter; the whole text without one or without a body. */
export function readable(text: string): string {
  const lines = text.split("\n");
  if ((lines[0] ?? "").replace(/^﻿/, "").trim() !== "---") return text;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return text;
  const body = lines.slice(end + 1).join("\n").trim();
  return body ? body : text;
}

export const countOf = (snap: Pick<BrainEvent, "memories">, type: BrainMemoryType): number => snap.memories.filter((m) => m.type === type).length;

// ---------------------------------------------------------------- the graph

export const HUB_ID = "MEMORY.md";
export const MAX_NODES = 300;

export type BrainNode = { id: string; label: string; type: BrainMemoryType | null; degree: number; session?: "add" | "change" };
export type BrainEdge = { from: number; to: number; index: boolean };
export type BrainGraph = { nodes: BrainNode[]; edges: BrainEdge[]; hidden: number };

/** Nodes (the hub first, then the memories by kind and name), link edges once per pair, hub → indexed memories. */
export function brainGraph(snap: Pick<BrainEvent, "memories" | "hasIndex">, hiddenTypes: ReadonlySet<BrainMemoryType> = new Set(), maxNodes = MAX_NODES): BrainGraph {
  const names = new Set(snap.memories.map((m) => m.name));
  const degree = new Map<string, number>();
  for (const m of snap.memories) {
    for (const to of m.links) {
      if (to === m.name || !names.has(to)) continue;
      degree.set(m.name, (degree.get(m.name) ?? 0) + 1);
      degree.set(to, (degree.get(to) ?? 0) + 1);
    }
  }
  const candidates = snap.memories.filter((m) => !hiddenTypes.has(m.type));
  let kept = candidates;
  if (candidates.length > maxNodes) {
    kept = [...candidates]
      .sort((a, b) => {
        const sa = a.session ? 1 : 0;
        const sb = b.session ? 1 : 0;
        if (sa !== sb) return sb - sa;
        const da = degree.get(a.name) ?? 0;
        const db = degree.get(b.name) ?? 0;
        if (da !== db) return db - da;
        if (a.mtime !== b.mtime) return b.mtime - a.mtime;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      })
      .slice(0, Math.max(0, maxNodes));
  }
  kept = [...kept].sort((a, b) => {
    const ta = BRAIN_TYPES.indexOf(a.type);
    const tb = BRAIN_TYPES.indexOf(b.type);
    if (ta !== tb) return ta - tb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const nodes: BrainNode[] = [];
  const withHub = snap.hasIndex && kept.some((m) => m.indexed);
  if (withHub) nodes.push({ id: HUB_ID, label: "MEMORY.md", type: null, degree: 0 });
  const index = new Map<string, number>();
  for (const m of kept) {
    index.set(m.name, nodes.length);
    nodes.push({ id: m.name, label: memoryLabel(m), type: m.type, degree: degree.get(m.name) ?? 0, ...(m.session ? { session: m.session } : {}) });
  }
  const edges: BrainEdge[] = [];
  const seen = new Set<string>();
  for (const m of kept) {
    const a = index.get(m.name)!;
    for (const to of m.links) {
      const b = index.get(to);
      if (b === undefined || b === a) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: a, to: b, index: false });
    }
    if (withHub && m.indexed) edges.push({ from: 0, to: a, index: true });
  }
  return { nodes, edges, hidden: candidates.length - kept.length };
}

// ---------------------------------------------------------------- the layout

export type Point = { x: number; y: number };

/** mulberry32: a tiny deterministic generator (the jitter that breaks ties). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let z = a;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

export const LAYOUT_WIDTH = 1000;
export const LAYOUT_HEIGHT = 700;
export const LAYOUT_MARGIN = 24;

/**
 * A seeded force layout (Fruchterman–Reingold with gravity toward the middle; the hub stays there): the same graph and seed
 * always give the same picture. O(n² · iterations) — at most 300 nodes.
 */
export function brainLayout(graph: BrainGraph, opts: { width?: number; height?: number; seed?: number; iterations?: number } = {}): Point[] {
  const width = opts.width ?? LAYOUT_WIDTH;
  const height = opts.height ?? LAYOUT_HEIGHT;
  const iterations = opts.iterations ?? 160;
  const n = graph.nodes.length;
  if (n === 0 || width <= 0 || height <= 0) return [];
  const cx = width / 2;
  const cy = height / 2;
  if (n === 1) return [{ x: cx, y: cy }];
  const rng = random(opts.seed ?? 7);
  const k = Math.sqrt((width * height) / n) * GRAPH_SPREAD;
  const xs = new Array<number>(n).fill(cx);
  const ys = new Array<number>(n).fill(cy);
  const hub = graph.nodes[0]?.type === null ? 0 : -1;
  for (let i = 0; i < n; i++) {
    if (i === hub) continue;
    const r = k * 0.6 * Math.sqrt(i + 1);
    const a = i * 2.399963 + rng() * 0.3;
    xs[i] = cx + r * Math.cos(a);
    ys[i] = cy + r * Math.sin(a);
  }
  let temp = Math.min(width, height) / 8;
  const cool = temp / Math.max(1, iterations);
  const dx = new Array<number>(n).fill(0);
  const dy = new Array<number>(n).fill(0);
  for (let it = 0; it < iterations; it++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = xs[i]! - xs[j]!;
        let ddy = ys[i]! - ys[j]!;
        let d2 = ddx * ddx + ddy * ddy;
        if (d2 < 0.0001) {
          ddx = rng() - 0.5;
          ddy = rng() - 0.5;
          d2 = ddx * ddx + ddy * ddy + 0.0001;
        }
        const f = (k * k) / d2;
        dx[i]! += ddx * f;
        dy[i]! += ddy * f;
        dx[j]! -= ddx * f;
        dy[j]! -= ddy * f;
      }
    }
    for (const e of graph.edges) {
      const ddx = xs[e.from]! - xs[e.to]!;
      const ddy = ys[e.from]! - ys[e.to]!;
      const d = Math.max(0.01, Math.sqrt(ddx * ddx + ddy * ddy));
      const f = (d / k) * (e.index ? 0.15 : 1);
      dx[e.from]! -= ddx * f;
      dy[e.from]! -= ddy * f;
      dx[e.to]! += ddx * f;
      dy[e.to]! += ddy * f;
    }
    for (let i = 0; i < n; i++) {
      if (i === hub) continue;
      // Weaker sideways: the cloud fills a wide frame instead of a square in its middle.
      dx[i]! += (cx - xs[i]!) * GRAPH_GRAVITY * (height / width);
      dy[i]! += (cy - ys[i]!) * GRAPH_GRAVITY;
      const len = Math.max(0.01, Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!));
      const step = Math.min(len, temp);
      xs[i] = Math.min(width - LAYOUT_MARGIN, Math.max(LAYOUT_MARGIN, xs[i]! + (dx[i]! / len) * step));
      ys[i] = Math.min(height - LAYOUT_MARGIN, Math.max(LAYOUT_MARGIN, ys[i]! + (dy[i]! / len) * step));
    }
    temp = Math.max(0.5, temp - cool);
  }
  return xs.map((x, i) => ({ x, y: ys[i]! }));
}

/** The ideal distance between nodes as a share of √(area / n), and the pull toward the middle (the Mac uses the same two). */
export const GRAPH_SPREAD = 0.55;
export const GRAPH_GRAVITY = 1;
