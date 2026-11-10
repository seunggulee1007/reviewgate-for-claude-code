/**
 * MARK: polish p-foundation — P5-sheets-34: a field that saves on blur keeps what was typed when it goes away without one.
 * Esc closes a dialog by taking it off the page, and an element taken off the page gets no blur: the patterns, the system
 * prompt, the commit template typed last were lost. On unmount the draft is committed when it differs from what is stored.
 *
 *   const [draft, setDraft] = useState(settings.bashAllowPatterns);
 *   useCommitOnUnmount(draft, settings.bashAllowPatterns, (v) => patch({ bashAllowPatterns: v }));
 *   <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => patch({ bashAllowPatterns: draft })} />
 *   <SavedTick value={settings.bashAllowPatterns} />
 */
import { useEffect, useRef } from "react";

export function useCommitOnUnmount<T>(draft: T, saved: T, commit: (value: T) => void): void {
  const latest = useRef({ draft, saved, commit });
  latest.current = { draft, saved, commit };
  useEffect(
    () => () => {
      const { draft: d, saved: s, commit: c } = latest.current;
      if (!Object.is(d, s)) c(d);
    },
    [],
  );
}
