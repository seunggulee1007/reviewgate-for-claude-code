/**
 * MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3: the chat history search shows up to three matching lines of a chat
 * (`transcript_search {perChat: 3}`), each opening the chat at its row, and "N건 더" when more matched (an older engine
 * sends one line and no count: shown as before).
 */
import type { TranscriptSearchMatch } from "@reviewgate/engine";
import { t } from "../../i18n";
import { matchHits } from "../../reviewLeftovers";
import "../diff/reviewLeftovers.css";

export function MatchLines(props: { match: TranscriptSearchMatch; disabled: boolean; onOpenAt: (row: number) => void }) {
  const { hits, more } = matchHits(props.match);
  return (
    <>
      {hits.map((h) => (
        <button
          key={h.row}
          type="button"
          className="plain caption search-match-line clickable truncate"
          style={{ textAlign: "left", padding: 0 }}
          disabled={props.disabled}
          onClick={() => props.onOpenAt(h.row)}
          title={t("Found in the messages")}
          data-testid="History match line"
        >
          {h.kind === "user_message" ? "› " : "◆ "}
          {h.line}
        </button>
      ))}
      {more > 0 && (
        <span className="caption muted search-match-more" title={t("Open the chat and use Find (⌘F) to see every match")} data-testid="History match more">
          {t("{0} more", more)}
        </span>
      )}
    </>
  );
}
