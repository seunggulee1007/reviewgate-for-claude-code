/**
 * MARK: wave4c w4c-commit
 * The turn-end line, led by "대화를 줄였어요 …" when the turn compacted the conversation (docs/PROTOCOL.md §41.1, SME-11:
 * `/compact` from the palette, or the CLI's auto-compaction) — so the chat says that Claude now remembers what came before
 * as a summary. As on the Mac (`CompactedRow`).
 */
import { compactedText, type CompactedRowFacts } from "../../commitFormat";

export function TurnEndRow({ item }: { item: { summary: string; compacted?: CompactedRowFacts } }) {
  return (
    <>
      {item.compacted && (
        <div className="turn-end muted" role="note" data-testid="Compacted row">
          <span>◇ {compactedText(item.compacted)}</span>
        </div>
      )}
      <div className="turn-end num" data-testid="Turn end"><span>{item.summary}</span></div>
    </>
  );
}
