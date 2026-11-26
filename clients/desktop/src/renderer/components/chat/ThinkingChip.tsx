/**
 * docs/PROTOCOL.md §70.4: the composer bar's thinking chip — Claude Code's ✻, struck through when off; a click toggles it as
 * Alt+T does. Its tooltip says the key, or that the model always thinks, or why it is off. As on the Mac (ComposerThinking.swift).
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
      {/* Claude Code's own thinking mark; struck through while off (the words are the tooltip and the label: a narrow pane keeps one row) */}
      <span className="thinking-mark" aria-hidden="true">✻</span>
    </button>
  );
}
