/**
 * docs/PROTOCOL.md §70.1: the Ctrl+R search bar over the message box (src/renderer/historySearch.ts) — a field with the
 * focus, the match with the typed part highlighted, "2 / 5" and the keys. As on the Mac (App ComposerHistorySearch.swift).
 */
import { useEffect, useRef } from "react";
import { t } from "../../i18n";
import { isComposing } from "../../ime";
import {
  noteHistorySearchKey,
  searchHelp,
  searchHighlight,
  searchHint,
  searchKeyAction,
  searchLabel,
  searchMatch,
  searchNewer,
  searchOlder,
  searchPlaceholder,
  searchPosition,
  searchStatus,
  withQuery,
  type HistorySearch,
} from "../../historySearch";

export function HistorySearchBar({ search, onChange, onAccept, onCancel }: {
  search: HistorySearch;
  onChange: (next: HistorySearch) => void;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const match = searchMatch(search);
  const position = searchPosition(search);
  const at = match === null ? null : searchHighlight(match, search.query);
  return (
    <div className="history-search" role="search" title={searchHelp()} data-testid="Prompt history search">
      <div className="history-search-row">
        <span className="history-search-icon" aria-hidden="true">⟲</span>
        <input
          ref={input}
          className="history-search-input"
          type="text"
          value={search.query}
          placeholder={searchPlaceholder()}
          aria-label={searchLabel()}
          spellCheck={false}
          onChange={(e) => onChange(withQuery(search, e.target.value))}
          onKeyDown={(e) => {
            const key = { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: isComposing(e) };
            const action = searchKeyAction(key, search.query === "");
            if (action === null) return;
            e.preventDefault();
            e.stopPropagation();
            if (action === "older") {
              if (e.ctrlKey) noteHistorySearchKey(); // the menu's Refresh is dropped for this press
              onChange(searchOlder(search));
            } else if (action === "newer") onChange(searchNewer(search));
            else if (action === "accept") onAccept();
            else onCancel();
          }}
          data-testid="Prompt history search field"
        />
        {position && <span className="history-search-position caption muted" data-testid="Prompt history search position">{position.index} / {position.count}</span>}
        <button type="button" className="plain tiny" onClick={onCancel} title={t("Close the search — your draft stays (Esc)")} aria-label={t("Close the search")}>×</button>
      </div>
      {match !== null ? (
        <div className="history-search-match" data-testid="Prompt history search match">
          {at === null ? match : (<>{match.slice(0, at[0])}<mark>{match.slice(at[0], at[1])}</mark>{match.slice(at[1])}</>)}
        </div>
      ) : (
        <div className={`history-search-status caption ${search.query !== "" ? "warn" : "muted"}`} data-testid="Prompt history search status">{searchStatus(search)}</div>
      )}
      <div className="history-search-hint caption faint">{searchHint()}</div>
    </div>
  );
}
