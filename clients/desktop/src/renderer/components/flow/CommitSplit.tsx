/**
 * docs/PROTOCOL.md §53 in the commit sheet: "나눠서 커밋" — the accepted changes as commit cards (message, parts, a "→" menu to
 * move a file / hunk to another card or to "커밋하지 않음", up / down, delete), "AI로 나누기" (a read-only fork proposes the cards),
 * and "커밋 N개 만들기" (`commit_series`). The state and the words are pure (commitSplit.ts); this is the screen.
 */
import { useEffect, useMemo, useReducer, useState } from "react";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { showToast } from "../../toast";
import { buildSeries, initialSplit, partKey, seriesBlocker, seriesDoneText, seriesFailureText, splitRefusalText, splitReducer, type SplitPart, type SplitTarget } from "../../commitSplit";
import { updateReason } from "../../flowLogic";
import type { CommitFile } from "../../../shared/commitSeries";
import "./flow.css";

type Move = (from: SplitTarget, to: SplitTarget, part: SplitPart, wholeFile: boolean) => void;

/** `paths`: the dialog's ticked accepted files. The panel lists its own actions (Cancel / "커밋 N개 만들기"). */
export function CommitSplitPanel(props: { paths: string[]; push: boolean; initialMessage: string; onClose: () => void;
  /** Tests: the hunks already loaded (no `commit_hunks`). */ preloaded?: CommitFile[] }) {
  const loadHunks = useStore((s) => s.loadCommitHunks);
  const splitWithClaude = useStore((s) => s.splitCommitWithClaude);
  const commitSeries = useStore((s) => s.commitSeries);
  const splitting = useStore((s) => s.flow.splitting);
  const [files, setFiles] = useState<CommitFile[] | null>(props.preloaded ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [s, dispatch] = useReducer(splitReducer, undefined, () => initialSplit(props.preloaded ?? [], props.initialMessage));
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiUnsupported, setAiUnsupported] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A series that stopped in the middle made commits: making it again would repeat them. */
  const [stopped, setStopped] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const key = props.paths.join("\0");

  useEffect(() => {
    if (props.preloaded) return;
    let alive = true;
    setFiles(null);
    setLoadError(null);
    void loadHunks(props.paths).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        setLoadError(r.unsupported ? updateReason() : splitRefusalText(r.error));
        return;
      }
      setFiles(r.files);
      dispatch({ type: "init", files: r.files, message: props.initialMessage }); // one card with everything
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const list = files ?? [];
  const byPath = useMemo(() => new Map(list.map((f) => [f.path, f])), [list]);
  const blocker = files === null ? t("Loading…") : stopped ? t("Close this sheet — some commits were already made") : seriesBlocker(s, { splitting, committing });
  const move: Move = (from, to, part, wholeFile) => dispatch({ type: "move", files: list, from, to, path: part.path, ...(wholeFile ? {} : { hunk: part.hunk }) });

  const runAi = async () => {
    if (splitting || committing || files === null) return;
    setAiError(null);
    const r = await splitWithClaude(props.paths);
    if (!r.ok) {
      if (r.error !== "busy") {
        setAiUnsupported(r.unsupported);
        setAiError(r.unsupported ? updateReason() : splitRefusalText(r.error));
      }
      return;
    }
    dispatch({ type: "propose", files: list, commits: r.commits, unassigned: r.unassigned });
  };

  const submit = async () => {
    if (blocker) return;
    setCommitting(true);
    setError(null);
    const r = await commitSeries(buildSeries(s), props.push);
    setCommitting(false);
    if (r.ok) {
      showToast(seriesDoneText(r.made, r.pushed));
      props.onClose();
      return;
    }
    if (r.made.length > 0) setStopped(true);
    setError(seriesFailureText(r.error, r.made));
  };

  const targets = (from: SplitTarget): { value: string; label: string }[] => [
    ...s.cards.map((c, i) => ({ value: String(c.id), label: t("Commit {0}", i + 1) })).filter((o) => o.value !== String(from)),
    ...(from === "none" ? [] : [{ value: "none", label: t("Not committed") }]),
  ];

  const partRows = (from: SplitTarget, parts: SplitPart[]) => {
    const paths = [...new Set(parts.map((p) => p.path))];
    return paths.map((path) => {
      const mine = parts.filter((p) => p.path === path);
      const f = byPath.get(path);
      const whole = mine.length === 1 && mine[0]!.hunk === null;
      return (
        <li key={path} className="split-file" data-testid={`Split file ${path}`}>
          <div className="flow-row">
            <span className="mono truncate split-path" title={path}>{path}</span>
            {f && f.hunks.length > 0 && mine.length < f.hunks.length && <span className="caption muted">{t("{0} of {1} parts", mine.length, f.hunks.length)}</span>}
            {!whole && mine.length > 1 && <MoveMenu label={path} options={targets(from)} onPick={(to) => move(from, to, mine[0]!, true)} />}
            {(whole || mine.length === 1) && <MoveMenu label={path} options={targets(from)} onPick={(to) => move(from, to, mine[0]!, whole)} />}
          </div>
          {!whole && (
            <ul className="split-hunks">
              {mine.map((p) => {
                const h = f?.hunks.find((x) => x.id === p.hunk);
                const k = `${from}:${partKey(p)}`;
                const expanded = open.has(k);
                return (
                  <li key={k}>
                    <div className="flow-row">
                      <button
                        type="button"
                        className="plain small split-chip mono"
                        aria-expanded={expanded}
                        title={t("Show the change")}
                        onClick={() => setOpen((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                        data-testid={`Split hunk ${partKey(p)}`}
                      >
                        #{p.hunk} {h?.header ?? ""}
                      </button>
                      {h && <span className="caption muted">+{h.added} −{h.deleted}</span>}
                      <MoveMenu label={`${path} #${p.hunk}`} options={targets(from)} onPick={(to) => move(from, to, p, false)} />
                    </div>
                    {expanded && h && <pre className="split-hunk-text mono">{h.text}</pre>}
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      );
    });
  };

  return (
    <div className="commit-split" data-testid="Commit split">
      <div className="flow-row">
        <button type="button" className="small" disabled={files === null || splitting || committing || stopped} onClick={() => void runAi()} data-testid="Split with Claude"
          title={t("Claude proposes the smallest meaningful commits, in an order where each one builds — in a read-only side session; nothing is committed")}>
          <span className="flow-spark" aria-hidden="true">✦</span> {t("Split with Claude")}
        </button>
        {splitting && (
          <span className="row caption muted" style={{ gap: 6 }} data-testid="Split progress">
            <span className="spinner" aria-hidden="true" />
            {t("Splitting…")}
          </span>
        )}
        {!splitting && s.before && (
          <button type="button" className="flow-link" onClick={() => dispatch({ type: "restore" })} data-testid="Restore split">
            {t("Restore the previous split")}
          </button>
        )}
      </div>
      {(aiError || loadError) && (
        <div className="flow-reason" data-testid="Split error">
          <span aria-hidden="true">⚠</span>
          <span>{loadError ?? aiError}</span>
        </div>
      )}
      {files === null && !loadError && <div className="hint">{t("Loading…")}</div>}
      {files !== null && (
        <ol className="split-cards" data-testid="Split cards">
          {s.cards.map((c, i) => (
            <li key={c.id} className="split-card" data-testid={`Split card ${i + 1}`}>
              <div className="flow-row">
                <strong className="caption">{t("Commit {0}", i + 1)}</strong>
                <span className="spacer" />
                <button type="button" className="plain small" aria-label={t("Move up")} title={t("Move up")} disabled={i === 0} onClick={() => dispatch({ type: "reorder", card: c.id, by: -1 })}>↑</button>
                <button type="button" className="plain small" aria-label={t("Move down")} title={t("Move down")} disabled={i === s.cards.length - 1} onClick={() => dispatch({ type: "reorder", card: c.id, by: 1 })}>↓</button>
                <button type="button" className="plain small" aria-label={t("Delete this commit")} title={t("Delete this commit — its changes go to Not committed")} onClick={() => dispatch({ type: "deleteCard", files: list, card: c.id })}>✕</button>
              </div>
              <textarea
                className="body mono"
                rows={2}
                value={c.message}
                placeholder={t("Commit message")}
                aria-label={t("Commit message") + ` ${i + 1}`}
                onChange={(e) => dispatch({ type: "message", card: c.id, message: e.target.value })}
                data-testid={`Split message ${i + 1}`}
              />
              {c.why && <div className="caption muted" data-testid={`Split why ${i + 1}`}>{c.why}</div>}
              {c.parts.length === 0 ? <div className="caption muted">{t("No changes in this commit")}</div> : <ul className="split-parts">{partRows(c.id, c.parts)}</ul>}
            </li>
          ))}
        </ol>
      )}
      {files !== null && (
        <button type="button" className="small" disabled={committing || stopped} onClick={() => dispatch({ type: "addCard" })} data-testid="Add commit">
          + {t("Add commit")}
        </button>
      )}
      {files !== null && (
        <div className="split-none" data-testid="Split not committed">
          <strong className="caption">{t("Not committed")}</strong>
          {s.unassigned.length === 0 ? (
            <div className="caption muted">{t("Everything is in a commit")}</div>
          ) : (
            <>
              <div className="caption muted">{t("These stay uncommitted and in the review")}</div>
              <ul className="split-parts">{partRows("none", s.unassigned)}</ul>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="flow-reason" data-testid="Split commit error">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </div>
      )}
      <div className="actions">
        {committing && <span className="spinner" />}
        {blocker && !committing && <span className="caption muted split-blocker" data-testid="Split blocker">{blocker}</span>}
        <span className="spacer" />
        <button type="button" disabled={committing} onClick={props.onClose}>{stopped ? t("Close") : t("Cancel")}</button>
        <button type="button" className="primary" disabled={blocker !== null} onClick={() => void submit()} title={blocker ?? undefined} data-testid="Make commits">
          {t("Make {0} commit(s)", s.cards.length)}
        </button>
      </div>
    </div>
  );
}

/** The "→" menu of a file / hunk: a native select (keyboard, screen readers), back to "→" after each pick. */
function MoveMenu(props: { label: string; options: { value: string; label: string }[]; onPick: (to: SplitTarget) => void }) {
  return (
    <select
      className="split-move"
      value=""
      aria-label={t("Move {0} to…", props.label)}
      title={t("Move to another commit")}
      disabled={props.options.length === 0}
      onChange={(e) => {
        const v = e.target.value;
        if (v) props.onPick(v === "none" ? "none" : Number(v));
      }}
      data-testid="Split move"
    >
      <option value="">→</option>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
