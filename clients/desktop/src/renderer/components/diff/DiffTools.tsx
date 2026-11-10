/**
 * MARK: wave2 desktop-diff — the slim row above a diff's lines: the pane's own controls on the left (the review pane's
 * hunk-reject bar), "diff에서 찾기" (⌘F inside the diff) and the "줄바꿈" toggle on the right; and the find bar itself.
 * Store-free (the line renderer is rendered in node tests).
 */
import { useEffect, useRef, type ReactNode } from "react";
import { useDiffPrefs } from "../../diffPrefs";
import { t } from "../../i18n";
import { isComposing, isEnter } from "../../ime";

/** "줄바꿈": wrap long lines (default) or scroll every row together. Shared by every diff view, the full-file one included. */
export function WrapToggle() {
  const wrap = useDiffPrefs((s) => s.wrap);
  const toggle = useDiffPrefs((s) => s.toggleWrap);
  return (
    <button type="button" className={`small diff-tool ${wrap ? "active" : ""}`} aria-pressed={wrap} onClick={toggle} title={t("Wrap lines")} data-testid="Wrap lines">
      <span aria-hidden="true">↵</span> {t("Wrap lines")}
    </button>
  );
}

export function DiffToolsRow(props: { children?: ReactNode; onFind?: () => void }) {
  return (
    <div className="diff-tools" data-testid="Diff tools">
      <div className="diff-tools-start">{props.children}</div>
      {props.onFind && (
        <button type="button" className="small diff-tool" onClick={props.onFind} title={`${t("Find in diff")} (${t("⌘F")})`} aria-label={t("Find in diff")} data-testid="Find in diff">
          <span aria-hidden="true">⌕</span> {t("Find in diff")}
        </button>
      )}
      <WrapToggle />
    </div>
  );
}

/** The find bar over the diff: Enter / ⇧Enter step (not while a Korean syllable is being composed), Esc closes. */
export function DiffFindBar(props: {
  query: string;
  onQuery: (q: string) => void;
  count: number;
  /** -1: no current hit. */
  current: number;
  /** More hits than are listed. */
  capped: boolean;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
  /** Bumped by every ⌘F: the input takes the focus again and selects its text. */
  focusSeq: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [props.focusSeq]);
  const typed = props.query.trim().length > 0;
  const none = typed && props.count === 0;
  return (
    <div className="diff-find" role="search" data-testid="Diff find bar">
      <input
        ref={ref}
        value={props.query}
        placeholder={t("Find in diff")}
        aria-label={t("Find in diff")}
        onChange={(e) => props.onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          if (isEnter(e)) {
            e.preventDefault();
            props.onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
          }
        }}
        data-testid="Diff find input"
      />
      <span className={`count num ${none ? "none" : ""}`} data-testid="Diff find count">
        {!typed ? "" : props.count === 0 ? t("No results") : `${props.current + 1}/${props.count}${props.capped ? "+" : ""}`}
      </span>
      <button type="button" disabled={props.count === 0} onClick={() => props.onStep(-1)} title={t("Previous (⇧↩)")} aria-label={t("Previous match")}>↑</button>
      <button type="button" disabled={props.count === 0} onClick={() => props.onStep(1)} title={t("Next (↩)")} aria-label={t("Next match")}>↓</button>
      <button type="button" onClick={props.onClose} title={t("Close (Esc)")} aria-label={t("Close find")} data-testid="Diff find close">×</button>
    </div>
  );
}
