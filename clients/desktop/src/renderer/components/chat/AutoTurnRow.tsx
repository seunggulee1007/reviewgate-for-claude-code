/**
 * A turn Claude started itself (docs/PROTOCOL.md §52) in the transcript: a background command ended, a /loop run, a
 * /goal. It is the turn's first row, where a user message would be (like the §29 peer message), with what woke Claude.
 */
import { autoTurnLines, autoTurnTitle, type AutoTurnRow } from "../../background";
import "../session.css";

export function AutoTurnRowView({ item }: { item: AutoTurnRow }) {
  const { detail, summary } = autoTurnLines(item);
  return (
    <div className="auto-turn-row" data-testid="Auto turn" data-trigger={item.trigger} data-turn={item.turn}>
      <div className="auto-turn-head">
        <span aria-hidden="true">↻</span>
        <span className="bold">{autoTurnTitle(item)}</span>
      </div>
      {detail && <div className="auto-turn-detail">{detail}</div>}
      {summary && <div className="auto-turn-summary muted">{summary}</div>}
    </div>
  );
}
