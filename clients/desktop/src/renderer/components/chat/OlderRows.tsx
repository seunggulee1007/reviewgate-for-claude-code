/**
 * MARK: wave4 w4-history — docs/PROTOCOL.md §38.3: [이전 대화 더 보기] over the oldest shown row (each press brings the 200
 * rows before it; the view keeps its place), and the jump to a chat-history search match once its row is shown (the
 * rows above it are loaded first). Nothing shows with an engine before §38.3 (no `start`) or when the chat starts here.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { transcriptShape } from "../../transcriptShape"; // MARK: wave4d w4d-speed
import { clearJump, jumpExpired, jumpState, loadOlderRows, messageOrdinal, useTranscriptPaging } from "../../transcriptHistory";
import "./olderRows.css";

export function OlderRowsBar({ scrollRef, rowsRef }: { scrollRef: React.RefObject<HTMLDivElement | null>; rowsRef: React.RefObject<HTMLDivElement | null> }) {
  const paging = useTranscriptPaging();
  const transcript = useStore((s) => transcriptShape(s.transcript)); // MARK: wave4d w4d-speed — rows added above, not deltas
  /** The scroll position before older rows went in above (restored right after they rendered). */
  const keep = useRef<{ height: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const k = keep.current;
    const el = scrollRef.current;
    if (!k || !el) return;
    keep.current = null;
    el.scrollTop = k.top + (el.scrollHeight - k.height);
  }, [transcript, scrollRef]);

  const more = async () => {
    const el = scrollRef.current;
    keep.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    if (!(await loadOlderRows())) keep.current = null;
  };

  // A search match: scroll to its row once it is shown; load the rows above it when it is further up.
  const { target, sessionId, loading } = paging;
  const jump = jumpState(paging);
  useEffect(() => {
    if (!target) return;
    if (jumpExpired(useTranscriptPaging.getState())) {
      clearJump(); // its chat never said where its rows start (an older engine)
      return;
    }
    if (sessionId === null || target.sessionId !== sessionId || loading) return; // its chat's rows are still on the way
    if (jump.itemId !== null) {
      const id = jump.itemId;
      const frame = requestAnimationFrame(() => {
        const k = messageOrdinal(useStore.getState().transcript, id);
        const el = k >= 0 ? rowsRef.current?.querySelectorAll<HTMLElement>('[data-testid="User message"], [data-testid="Assistant message"]')[k] : undefined;
        if (el) {
          el.scrollIntoView({ block: "center" });
          el.classList.remove("flash");
          void el.offsetWidth;
          el.classList.add("flash");
        }
        clearJump();
      });
      return () => cancelAnimationFrame(frame);
    }
    // A failed page gives the jump up (a refusal would otherwise be retried on every render).
    if (jump.load > 0) void loadOlderRows(jump.load).then((ok) => ok || clearJump());
    else clearJump(); // out of reach (the row is gone from the file)
    return undefined;
  }, [target, sessionId, loading, jump.itemId, jump.load, rowsRef]);

  if (transcript.length === 0 || paging.start === null || paging.start <= 0) return null;
  return (
    <div className="older-rows" data-testid="Older rows">
      <button type="button" className="small" disabled={paging.loading} onClick={() => void more()} data-testid="Show earlier messages">
        {paging.loading && <span className="spinner" />} {t("Show earlier messages")}
      </button>
      {paging.error && <span className="caption orange" data-testid="Older rows error">{paging.error}</span>}
    </div>
  );
}
