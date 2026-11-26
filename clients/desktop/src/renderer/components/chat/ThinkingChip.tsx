/**
 * docs/PROTOCOL.md §70.4: the composer bar's thinking chip — a brain, "Thinking off" when off; a click toggles it as Alt+T
 * does. Its tooltip says the key, or that the model always thinks, or why it is off. As on the Mac (ComposerThinking.swift).
 */
import type { ThinkingState } from "@reviewgate/engine";
import { thinkingChipText, thinkingHelp, thinks } from "../../thinking";

export function ThinkingChip({ thinking, blocker, onToggle }: { thinking: ThinkingState; blocker: string | null; onToggle: () => void }) {
  const on = thinks(thinking);
  const help = blocker ?? thinkingHelp(thinking);
  return (
    <button
      type="button"
      className={`caption-btn thinking-chip${on ? " on" : " off"}`}
      onClick={onToggle}
      disabled={blocker !== null}
      title={help}
      aria-label={`${thinkingChipText(thinking)} — ${help}`}
      aria-pressed={on}
      data-testid="Thinking toggle"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2.5a2 2 0 0 0-2 2v.2A2.2 2.2 0 0 0 2.5 7a2.2 2.2 0 0 0 .7 1.6A2.3 2.3 0 0 0 5 12.5a1.8 1.8 0 0 0 3 .8V3.6A1.8 1.8 0 0 0 6 2.5Z" />
        <path d="M10 2.5a2 2 0 0 1 2 2v.2A2.2 2.2 0 0 1 13.5 7a2.2 2.2 0 0 1-.7 1.6A2.3 2.3 0 0 1 11 12.5a1.8 1.8 0 0 1-3 .8" />
      </svg>
      {!on && <span>{thinkingChipText(thinking)}</span>}
    </button>
  );
}
