/**
 * MARK: wave5 w5-brain — docs/PROTOCOL.md §43.2: the board's "서브브레인" tab. What Claude's auto memory holds (cards per
 * kind), how the memories link (an SVG graph: MEMORY.md in the middle, this session's memories shimmering — still with
 * reduced motion), a memory's text on the right (read only) with [에디터에서 열기], and below it this session's timeline, the
 * latest edits and the index's gaps. The engine re-reads the folder every 4 s while the tab is shown. Same tab as the Mac
 * (`SubBrainBoardView.swift`); the rules live in subBrain.ts, the state in subBrainStore.ts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BrainEvent, BrainMemory, BrainMemoryType } from "@reviewgate/engine";
import { relativeTime, t } from "../../i18n";
import { useStore } from "../../store";
import { useSubBrain } from "../../subBrainStore";
import { canOpenMarkdown } from "../../claudeConfig";
import {
  BRAIN_CARD_TYPES,
  BRAIN_TYPES,
  brainGraph,
  brainLayout,
  countOf,
  HUB_ID,
  LAYOUT_HEIGHT,
  LAYOUT_WIDTH,
  memoryLabel,
  readable,
  typeIcon,
  typeName,
  verb,
  writerAvatar,
  writerLabel,
  type BrainGraph,
} from "../../subBrain";
import { Avatar } from "./Avatar";
import "./subBrain.css";

const ago = (ms: number): string => (ms > 0 ? relativeTime(new Date(ms).toISOString()) : "");

/** The tab's content (no props: the board shows it; the state comes from the stores). */
export default function SubBrainBoard() {
  const projectPath = useStore((s) => s.state.project?.path ?? null);
  const snapshot = useSubBrain((s) => s.snapshot);
  const unsupported = useSubBrain((s) => s.unsupported);
  const error = useSubBrain((s) => s.error);

  useEffect(() => {
    const brain = useSubBrain.getState();
    if (!projectPath) {
      brain.reset();
      return;
    }
    void brain.start();
    // A watched folder's changes arrive as `brain` without an id (a reply is the request's own).
    const off = window.rg?.onEvent?.((ev) => {
      if (ev.type === "brain" && !ev.id) useSubBrain.getState().apply(ev);
    });
    return () => {
      off?.();
      void useSubBrain.getState().stop();
    };
  }, [projectPath]);

  let body;
  if (!projectPath) {
    body = <Notice icon="📁" title={t("Open a project to see what Claude remembers about it")} detail={t("Each repository has its own auto memory; every workbench of it shares one.")} />;
  } else if (unsupported) {
    body = <Notice icon="⚠️" title={t("Needs the engine of this app version — reopen the project")} detail={t("This engine does not read Claude's auto memory yet.")} />;
  } else if (snapshot) {
    body = snapshot.memories.length === 0
      ? (
        <Notice
          icon="🧠"
          title={t("This project has no auto memory yet")}
          detail={t("Claude keeps what it learns in your chats here — your preferences, feedback, facts about the project. Once it does, they show up as a graph.")}
          path={snapshot.dir}
          error={snapshot.error}
        />
      )
      : <Content snapshot={snapshot} />;
  } else if (error) {
    body = <Notice icon="⚠️" title={t("The sub-brain could not be read")} detail={error} />;
  } else {
    body = <div className="brain-loading"><span className="spinner" aria-label={t("Loading…")} /></div>;
  }
  return <div className="brain" data-testid="sub-brain">{body}</div>;
}

function Notice({ icon, title, detail, path, error }: { icon: string; title: string; detail: string; path?: string | null; error?: string }) {
  return (
    <div className="brain-notice" role="status">
      <div className="brain-notice-icon" aria-hidden="true">{icon}</div>
      <div className="bold">{title}</div>
      <div className="muted">{detail}</div>
      {path ? <div className="mono caption muted brain-path" title={path}>{path}</div> : null}
      {error ? <div className="caption red">{error}</div> : null}
    </div>
  );
}

function Content({ snapshot }: { snapshot: BrainEvent }) {
  return (
    <>
      <Header snapshot={snapshot} />
      <div className="brain-main">
        <GraphView snapshot={snapshot} />
        <MemoryPanel snapshot={snapshot} />
      </div>
      <Lists snapshot={snapshot} />
    </>
  );
}

function Header({ snapshot }: { snapshot: BrainEvent }) {
  const types: BrainMemoryType[] = [...BRAIN_CARD_TYPES, ...(countOf(snapshot, "other") > 0 ? (["other"] as const) : [])];
  return (
    <div className="brain-header">
      <div className="brain-cards">
        {types.map((type) => (
          <div key={type} className={`brain-card t-${type}`} aria-label={`${typeName(type)} ${countOf(snapshot, type)}`}>
            <span className="brain-card-icon" aria-hidden="true">{typeIcon(type)}</span>
            <span className="brain-card-text">
              <span className="brain-card-count">{countOf(snapshot, type)}</span>
              <span className="caption muted">{typeName(type)}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="brain-session">
        <div className={snapshot.sessionCount > 0 ? "bold brain-grown" : "bold"}>✨ {t("Added this session: {0}", snapshot.sessionCount)}</div>
        {snapshot.dir ? <div className="mono caption muted brain-path" title={snapshot.dir}>{snapshot.dir}</div> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the graph

const radius = (degree: number, hub: boolean): number => (hub ? 15 : 6 + Math.min(degree, 6));

function GraphView({ snapshot }: { snapshot: BrainEvent }) {
  const hidden = useSubBrain((s) => s.hidden);
  const selected = useSubBrain((s) => s.selected);
  const select = useSubBrain((s) => s.select);
  const toggle = useSubBrain((s) => s.toggle);
  const graph: BrainGraph = useMemo(() => brainGraph(snapshot, new Set(hidden)), [snapshot, hidden]);
  const key = graph.nodes.map((n) => n.id).join("|") + `#${graph.edges.length}`;
  // The layout depends only on which nodes and edges there are (not on texts or times).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const points = useMemo(() => brainLayout(graph), [key]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  // The svg's size in pixels: dots and labels keep their screen size (as on the Mac) while the layout scales.
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const w = LAYOUT_WIDTH / zoom;
  const h = LAYOUT_HEIGHT / zoom;
  const viewBox = `${LAYOUT_WIDTH / 2 - w / 2 - pan.x} ${LAYOUT_HEIGHT / 2 - h / 2 - pan.y} ${w} ${h}`;
  const showAll = graph.nodes.length <= 40 || zoom >= 1.8;
  const links = graph.edges.filter((e) => !e.index).length;
  /** Layout units per screen pixel. */
  const u = box.w > 0 && box.h > 0 ? Math.max(w / box.w, h / box.h) : 1;

  return (
    <div className="brain-graph">
      <div className="brain-controls">
        {BRAIN_TYPES.map((type) => {
          const off = hidden.includes(type);
          return (
            <button
              key={type}
              type="button"
              className={`plain small brain-legend${off ? " off" : ""}`}
              aria-pressed={!off}
              title={off ? t("Show this kind in the graph") : t("Hide this kind in the graph")}
              onClick={() => toggle(type)}
            >
              <span className={`brain-dot-key t-${type}`} aria-hidden="true" />
              {typeName(type)}
            </button>
          );
        })}
        <span className="brain-controls-gap" />
        <button type="button" className="plain small" aria-label={t("Zoom in")} title={t("Zoom in")} onClick={() => setZoom((z) => Math.min(4, z * 1.25))}>＋</button>
        <button type="button" className="plain small" aria-label={t("Zoom out")} title={t("Zoom out")} onClick={() => setZoom((z) => Math.max(0.4, z / 1.25))}>－</button>
        <button type="button" className="plain small" title={t("Fit the graph")} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>{t("Fit the graph")}</button>
        {graph.hidden > 0 ? <span className="caption muted" title={t("Only the memories changed this session, the most linked and the newest are drawn")}>{t("{0} more not drawn", graph.hidden)}</span> : null}
      </div>
      <svg
        ref={svgRef}
        className="brain-svg"
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={t("Memory graph: {0} memories, {1} links", graph.nodes.length, links)}
        onWheel={(e) => {
          const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
          setZoom((z) => Math.min(4, Math.max(0.4, z * f)));
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || e.buttons === 0) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          d.moved = true;
          setPan({ x: d.px + dx * u, y: d.py + dy * u });
        }}
        onPointerUp={() => {
          // A drag never selects; a click on the background closes the panel.
          setTimeout(() => {
            drag.current = null;
          }, 0);
        }}
        onClick={(e) => {
          if (drag.current?.moved) return;
          if (e.target === svgRef.current) void select(null);
        }}
      >
        <g className="brain-edges">
          {points.length === graph.nodes.length && graph.edges.map((e, i) => (
            <line
              key={i}
              className={e.index ? "brain-edge index" : "brain-edge"}
              strokeWidth={(e.index ? 0.6 : 1.2) * u}
              x1={points[e.from]!.x}
              y1={points[e.from]!.y}
              x2={points[e.to]!.x}
              y2={points[e.to]!.y}
            />
          ))}
        </g>
        {points.length === graph.nodes.length && graph.nodes.map((n, i) => {
          const p = points[i]!;
          const hub = n.type === null;
          const r = radius(n.degree, hub) * u;
          const isSelected = n.id === selected;
          return (
            <g
              key={n.id}
              className={`brain-node t-${n.type ?? "hub"}${isSelected ? " selected" : ""}`}
              transform={`translate(${p.x} ${p.y})`}
              onClick={(e) => {
                e.stopPropagation();
                if (!drag.current?.moved) void select(n.id);
              }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h0) => (h0 === i ? null : h0))}
            >
              <title>{n.label}</title>
              {n.session ? <circle className="brain-glow" r={r + 5 * u} strokeWidth={2 * u} /> : null}
              <circle className="brain-dot" r={r} strokeWidth={1.2 * u} />
              {isSelected ? <circle className="brain-ring" r={r + 3 * u} strokeWidth={2.5 * u} /> : null}
              {hub ? <text className="brain-hub-icon" dy="0.35em" fontSize={15 * u}>🧠</text> : null}
              {showAll || hover === i || isSelected || hub ? <text className="brain-label" y={r + 12 * u} fontSize={10.5 * u} strokeWidth={3 * u}>{n.label}</text> : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- a memory's text

function OpenButton({ path }: { path: string }) {
  const can = canOpenMarkdown(path) && typeof window.rg?.openMarkdown === "function";
  return (
    <button type="button" className="plain small" disabled={!can} onClick={() => can && void window.rg.openMarkdown!(path)} title={can ? t("Opens in the default app") : undefined}>
      ↗ {t("Open in Editor")}
    </button>
  );
}

function MemoryPanel({ snapshot }: { snapshot: BrainEvent }) {
  const selected = useSubBrain((s) => s.selected);
  const text = useSubBrain((s) => s.text);
  const textError = useSubBrain((s) => s.textError);
  const select = useSubBrain((s) => s.select);
  const sep = snapshot.dir?.includes("\\") ? "\\" : "/";
  if (selected === HUB_ID) {
    return (
      <aside className="brain-panel">
        <div className="brain-panel-head"><span aria-hidden="true">🧠</span> <span className="bold">MEMORY.md</span></div>
        <p className="muted">{t("The index Claude reads at the start of every chat. Each line points to one memory.")}</p>
        {snapshot.dir ? <OpenButton path={`${snapshot.dir}${sep}MEMORY.md`} /> : null}
      </aside>
    );
  }
  const memory: BrainMemory | undefined = snapshot.memories.find((m) => m.name === selected);
  if (!memory) {
    return (
      <aside className="brain-panel brain-panel-empty">
        <div aria-hidden="true" className="brain-notice-icon small">👆</div>
        <div className="muted">{t("Click a memory in the graph to read it here.")}</div>
      </aside>
    );
  }
  const path = text?.name === memory.name ? text.path : snapshot.dir ? `${snapshot.dir}${sep}${memory.name}.md` : null;
  return (
    <aside className="brain-panel" aria-label={memoryLabel(memory)}>
      <div className="brain-panel-head">
        <span aria-hidden="true">{typeIcon(memory.type)}</span>
        <span className="bold brain-panel-title">{memoryLabel(memory)}</span>
        <button type="button" className="plain small" aria-label={t("Close")} onClick={() => void select(null)}>✕</button>
      </div>
      <div className="brain-chips">
        <span className={`pill brain-type t-${memory.type}`}>{typeName(memory.type)}</span>
        {memory.session ? <span className="pill">{verb(memory.session)}</span> : null}
        <span className="caption muted">{ago(memory.mtime)}</span>
      </div>
      <div className="mono caption muted">{memory.name}.md</div>
      {memory.description ? <div className="muted">{memory.description}</div> : null}
      {memory.links.length > 0 ? (
        <div className="brain-links">
          <span aria-hidden="true">🔗</span>
          {memory.links.slice(0, 6).map((l) => (
            <button key={l} type="button" className="link small" onClick={() => void select(l)}>{l}</button>
          ))}
        </div>
      ) : null}
      <div className="brain-text">
        {text?.name === memory.name ? (
          <>
            <pre className="mono">{readable(text.text)}</pre>
            {text.truncated ? <div className="caption muted">{t("Only the first 64 KB is shown.")}</div> : null}
          </>
        ) : textError ? <div className="red">{textError}</div> : <span className="spinner" aria-label={t("Loading…")} />}
      </div>
      {path ? <OpenButton path={path} /> : null}
    </aside>
  );
}

// ---------------------------------------------------------------- the lists

function Lists({ snapshot }: { snapshot: BrainEvent }) {
  const select = useSubBrain((s) => s.select);
  const ok = snapshot.unindexed.length === 0 && snapshot.missing.length === 0 && snapshot.brokenLinks.length === 0;
  return (
    <div className="brain-lists">
      <section aria-label={t("In this session")}>
        <h4>✨ {t("In this session")}</h4>
        {snapshot.changes.length === 0 ? <div className="caption muted">{t("Nothing yet. A memory Claude writes shows up here right away.")}</div> : (
          <ul>
            {snapshot.changes.map((c) => (
              <li key={`${c.at}-${c.kind}-${c.name}`}>
                <span className={`brain-kind ${c.kind}`} aria-label={verb(c.kind)}>{c.kind === "add" ? "+" : c.kind === "change" ? "✎" : "−"}</span>
                <span className="brain-row">
                  <button type="button" className="plain small brain-row-name" disabled={c.kind === "remove"} onClick={() => void select(c.name)}>
                    {typeIcon(c.type)} {c.title?.trim() ? c.title : c.name}
                  </button>
                  <span className="caption muted brain-writer">
                    {/* The writer's face from the agent board (§43.1): Claude's star or the subagent type's face. */}
                    {(() => {
                      const face = writerAvatar(c);
                      return face ? <Avatar avatar={face} mood="idle" size={16} label={false} showsMood={false} /> : null;
                    })()}
                    {writerLabel(c)} · {ago(c.at)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label={t("Recently changed")}>
        <h4>🕘 {t("Recently changed")}</h4>
        <ul>
          {snapshot.memories.slice(0, 8).map((m) => (
            <li key={m.name}>
              <button type="button" className="plain small brain-recent" onClick={() => void select(m.name)}>
                <span className="brain-recent-top">
                  <span>{typeIcon(m.type)} {memoryLabel(m)}</span>
                  <span className="caption muted">{ago(m.mtime)}</span>
                </span>
                {m.description ? <span className="caption muted brain-ellipsis">{m.description}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label={t("Index problems")}>
        <h4>📋 {t("Index problems")}</h4>
        {ok ? <div className="caption muted">✓ {t("No index problems")}</div> : null}
        {!snapshot.hasIndex ? <div className="caption orange">{t("There is no MEMORY.md — Claude finds memories only through it.")}</div> : null}
        <Problem title={t("Not in MEMORY.md: {0}", snapshot.unindexed.length)} names={snapshot.unindexed} onPick={(n) => void select(n)} />
        <Problem title={t("In MEMORY.md but no file: {0}", snapshot.missing.length)} names={snapshot.missing} />
        <Problem title={t("Broken links: {0}", snapshot.brokenLinks.length)} names={snapshot.brokenLinks.map((b) => `${b.from} → ${b.to}`)} />
      </section>
    </div>
  );
}

function Problem({ title, names, onPick }: { title: string; names: string[]; onPick?: (name: string) => void }) {
  if (names.length === 0) return null;
  return (
    <div className="brain-problem">
      <div className="caption orange bold">{title}</div>
      {names.slice(0, 12).map((n) => onPick
        ? <button key={n} type="button" className="link small" onClick={() => onPick(n)}>{n}</button>
        : <div key={n} className="caption muted brain-ellipsis">{n}</div>)}
      {names.length > 12 ? <div className="caption muted">{t("{0} more", names.length - 12)}</div> : null}
    </div>
  );
}
