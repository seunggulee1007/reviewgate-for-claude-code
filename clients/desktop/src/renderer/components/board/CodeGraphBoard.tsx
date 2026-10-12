/**
 * MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3: the board's "코드 그래프" tab (the Mac's `CodeGraphBoardView`). graphify's
 * report — never graph.json — as big numbers, a freshness badge, the most connected nodes and the community sizes as bars,
 * the surprising connections and the community hubs; [다시 빌드] runs `graphify update .` in the background (disabled with
 * its reason), [graph.html 열기] opens the whole graph in the default browser (main checks the path). Read while the tab is
 * shown: at once, then every 15 s; a build's progress and end arrive as events.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { CodeGraphEvent, CodeGraphReport } from "@reviewgate/engine";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { ago, buildBlockedReason, buildLine, buildNote, fileName, freshness, freshnessLabel, installHint, looksLikeGraphHtml, share, useCodeGraph, type Freshness } from "../../codeGraph";
import "./codeGraph.css";

/** How often the tab re-reads the report while it is shown (the engine re-parses only a changed file). */
export const POLL_MS = 15_000;

const num = (n: number) => n.toLocaleString();

/** The last reply when it is this project's (a reply of the project before a switch is not shown). */
export function replyFor(root: string | null, last: CodeGraphEvent | null): CodeGraphEvent | null {
  return last && root && last.root === root ? last : null;
}

export default function CodeGraphBoard() {
  const root = useStore((s) => s.state.project?.root ?? null);
  const { reply: last, error, unsupported } = useCodeGraph();
  const reply = replyFor(root, last);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!root) return;
    const store = useCodeGraph.getState();
    if (store.reply && store.reply.root !== root) store.reset();
    void store.refresh();
    const timer = setInterval(() => void useCodeGraph.getState().refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [root]);

  const running = reply?.build?.running === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  return <CodeGraphView root={root} reply={reply} error={error} unsupported={unsupported} now={now} />;
}

/** The tab as drawn from its data (the default export adds the store, the 15 s poll and the build's clock). */
export function CodeGraphView({ root, reply, error, unsupported, now }: { root: string | null; reply: CodeGraphEvent | null; error: string | null; unsupported: boolean; now: number }) {
  if (!root) return <div className="cg-empty faint">{t("Open a project first")}</div>;
  const report = reply?.report ?? null;
  return (
    <div className="cg-board" data-testid="Code graph board">
      {reply && report ? (
        <>
          <Header reply={reply} report={report} />
          <StatTiles report={report} />
          <Controls reply={reply} unsupported={unsupported} error={error} now={now} />
          {report.gods.length > 0 && <Gods report={report} />}
          {report.bigCommunities.length > 0 && <Communities report={report} />}
          {report.surprises.length > 0 && <Surprises report={report} />}
          {report.hubs.length > 0 && <Hubs report={report} />}
        </>
      ) : (
        <Empty reply={reply} unsupported={unsupported} error={error} now={now} />
      )}
    </div>
  );
}

function Header({ reply, report }: { reply: CodeGraphEvent; report: CodeGraphReport }) {
  const parts: string[] = [];
  if (report.files !== null) parts.push(t("{0} files", num(report.files)));
  if (report.extractedPct !== null && report.inferredPct !== null) parts.push(`${t("Extracted")} ${report.extractedPct}% · ${t("Inferred")} ${report.inferredPct}%`);
  const built = ago(reply.builtAt);
  if (built) parts.push(t("Built {0}", built));
  if (reply.shared) parts.push(t("The main worktree's graph"));
  const fresh = freshness(reply);
  return (
    <div className="cg-header">
      <span className="cg-logo" aria-hidden="true">⌬</span>
      <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span className="cg-title truncate">{report.name ?? ""}</span>
        <span className="caption muted">{parts.join(" · ")}</span>
      </div>
      {fresh && <FreshBadge fresh={fresh} reply={reply} />}
    </div>
  );
}

function FreshBadge({ fresh, reply }: { fresh: Freshness; reply: CodeGraphEvent }) {
  const tone = fresh.kind === "fresh" ? "green" : fresh.kind === "behind" ? "orange" : "gray";
  const icon = fresh.kind === "fresh" ? "✓" : fresh.kind === "behind" ? "↻" : "?";
  return (
    <span className={`cg-badge ${tone}`} title={t("Graph built from commit {0} · HEAD {1}", reply.report?.commit ?? "?", reply.head ?? "?")} data-testid="Code graph freshness">
      <span aria-hidden="true">{icon}</span> {freshnessLabel(fresh)}
    </span>
  );
}

function StatTiles({ report }: { report: CodeGraphReport }) {
  const tiles: [string, number, string][] = [
    [t("Nodes"), report.nodes, "blue"],
    [t("Edges"), report.edges, "purple"],
    [t("Communities"), report.communities, "teal"],
  ];
  return (
    <div className="cg-tiles">
      {tiles.map(([label, value, tone]) => (
        <div key={label} className={`cg-tile ${tone}`} aria-label={`${label} ${num(value)}`} role="group">
          <span className="caption muted" aria-hidden="true">{label}</span>
          <span className="cg-big" aria-hidden="true">{num(value)}</span>
        </div>
      ))}
    </div>
  );
}

function BuildButton({ reply, unsupported, label }: { reply: CodeGraphEvent | null; unsupported: boolean; label: string }) {
  const blocked = buildBlockedReason(reply, unsupported);
  return (
    <button
      type="button"
      className="primary small"
      disabled={blocked !== null}
      title={blocked ?? t("Runs graphify update . in the project — in the background, without tokens")}
      onClick={() => void useCodeGraph.getState().build()}
      data-testid="Rebuild code graph"
    >
      ↻ {label}
    </button>
  );
}

function BuildStatus({ reply, unsupported, error, now }: { reply: CodeGraphEvent | null; unsupported: boolean; error: string | null; now: number }) {
  const blocked = buildBlockedReason(reply, unsupported);
  const build = reply?.build ?? null;
  return (
    <>
      {blocked && !build?.running && reply && <span className="caption muted">{blocked}</span>}
      {blocked && !build?.running && reply && !reply.graphify && <code className="cg-hint">{installHint()}</code>}
      {build && (
        <span className={`caption ${build.running || build.ok ? "muted" : "orange"}`} data-testid="Code graph build line">
          {build.running && <span className="spinner" aria-hidden="true" />} {buildLine(build, now)}
        </span>
      )}
      {error && (
        <span className="caption orange" role="alert">
          ⚠ {error}
        </span>
      )}
    </>
  );
}

function Controls({ reply, unsupported, error, now }: { reply: CodeGraphEvent; unsupported: boolean; error: string | null; now: number }) {
  const canOpen = looksLikeGraphHtml(reply.htmlPath) && typeof window.rg?.openGraphHtml === "function";
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8 }}>
        <BuildButton reply={reply} unsupported={unsupported} label={reply.shared ? t("Build here") : t("Rebuild")} />
        <button
          type="button"
          className="small"
          disabled={!canOpen}
          title={canOpen ? t("Opens the whole graph in your browser") : t("graph.html is not there — rebuild to make it")}
          onClick={() => canOpen && void window.rg.openGraphHtml!(reply.htmlPath!)}
          data-testid="Open graph.html"
        >
          ⧉ {t("Open graph.html")}
        </button>
      </div>
      <BuildStatus reply={reply} unsupported={unsupported} error={error} now={now} />
    </div>
  );
}

function Section({ title, icon, children, testId }: { title: string; icon: string; children: ReactNode; testId: string }) {
  return (
    <section className="cg-section" data-testid={testId}>
      <h4>
        <span className="cg-icon" aria-hidden="true">{icon}</span> {title}
      </h4>
      {children}
    </section>
  );
}

function Bar({ rank, name, value, max, tone, label, detail }: { rank?: number; name: string; value: number; max: number; tone: string; label: string; detail?: string }) {
  return (
    <li className={`cg-bar${rank === undefined ? " no-rank" : ""}`} aria-label={`${name}, ${label}${detail ? `, ${detail}` : ""}`} title={detail ? `${name} · ${detail}` : name}>
      {rank !== undefined && <span className="cg-rank" aria-hidden="true">{rank}</span>}
      <span className="cg-name mono truncate" aria-hidden="true">{name}</span>
      <span className="cg-track" aria-hidden="true">
        <span className={`cg-fill ${tone}`} style={{ width: `${(share(value, max) * 100).toFixed(1)}%` }} />
      </span>
      <span className="cg-value num" aria-hidden="true">{num(value)}</span>
    </li>
  );
}

function Gods({ report }: { report: CodeGraphReport }) {
  const max = Math.max(0, ...report.gods.map((g) => g.edges));
  return (
    <Section title={t("Most connected nodes")} icon="★" testId="Code graph gods">
      <ul className="cg-bars">
        {report.gods.map((g, i) => (
          <Bar key={`${g.name}-${i}`} rank={i + 1} name={g.name} value={g.edges} max={max} tone="accent" label={t("{0} edges", num(g.edges))} />
        ))}
      </ul>
    </Section>
  );
}

/** Community colors: none of the status colors' meanings (no red / pink / green / orange); the Mac's order. */
const PALETTE = ["teal", "indigo", "cyan", "purple", "mint", "blue", "brown"];

function Communities({ report }: { report: CodeGraphReport }) {
  const max = Math.max(0, ...report.bigCommunities.map((c) => c.nodes));
  return (
    <Section title={t("Community sizes")} icon="⬡" testId="Code graph communities">
      <ul className="cg-bars">
        {report.bigCommunities.map((c, i) => (
          <Bar key={`${c.id}-${i}`} name={c.name} value={c.nodes} max={max} tone={PALETTE[i % PALETTE.length]!} label={t("{0} nodes", num(c.nodes))}
            {...(c.cohesion !== null ? { detail: `${t("Cohesion")} ${c.cohesion.toFixed(2)}` } : {})} />
        ))}
      </ul>
    </Section>
  );
}

function Surprises({ report }: { report: CodeGraphReport }) {
  return (
    <Section title={t("Surprising connections")} icon="✦" testId="Code graph surprises">
      <ul className="cg-links">
        {report.surprises.map((l, i) => {
          const from = fileName(l.fromFile);
          const to = fileName(l.toFile);
          const inferred = l.confidence === "INFERRED";
          return (
            <li key={`${l.from}-${l.to}-${i}`}>
              <span className="row" style={{ gap: 6, minWidth: 0 }}>
                <span className="mono truncate">{l.from}</span>
                <span className="caption muted">─{l.relation}→</span>
                <span className="mono truncate grow">{l.to}</span>
                <span className={`pill ${inferred ? "purple" : ""}`}>{inferred ? t("Inferred") : t("Extracted")}</span>
              </span>
              {from && to && <span className="caption muted truncate" title={`${l.fromFile ?? ""} → ${l.toFile ?? ""}`}>{from} → {to}</span>}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Hubs({ report }: { report: CodeGraphReport }) {
  const more = report.hubCount - report.hubs.length;
  return (
    <Section title={t("Community hubs")} icon="⇄" testId="Code graph hubs">
      <div className="row wrap" style={{ gap: 6 }}>
        {report.hubs.map((h) => (
          <span key={h} className="cg-chip mono">{h}</span>
        ))}
        {more > 0 && <span className="cg-chip faint">{t("and {0} more", num(more))}</span>}
      </div>
    </Section>
  );
}

function Empty({ reply, unsupported, error, now }: { reply: CodeGraphEvent | null; unsupported: boolean; error: string | null; now: number }) {
  let title: string;
  if (unsupported) title = buildBlockedReason(null, true)!;
  else if (!reply) title = t("Reading the code graph…");
  else if (reply.reportError) title = reply.reportError === "too_large" ? t("The report is too large to read here — open graph.html") : t("The report could not be read");
  else title = t("No code graph yet");
  return (
    <div className="cg-empty col" data-testid="Code graph empty">
      <span className="cg-empty-logo" aria-hidden="true">⌬</span>
      <span className="bold">{title}</span>
      {reply && !reply.reportError && !unsupported && <span className="caption muted">{buildNote()}</span>}
      {reply && !unsupported && <BuildButton reply={reply} unsupported={unsupported} label={t("Build")} />}
      <BuildStatus reply={reply} unsupported={unsupported} error={error} now={now} />
    </div>
  );
}
