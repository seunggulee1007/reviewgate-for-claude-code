/**
 * §40.3 (wave4b w4b-side, audit SME-12): right-click on Claude's answer → "곁질문으로 묻기" about the selected text (or the
 * whole answer when nothing is selected). The anchor is the quote and the turn it is from. Not on a chat shown read-only
 * (§39.2): its side questions would go to the running chat's conversation — the item is there, disabled, with why.
 */
import { useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { t } from "../../i18n";
import { quoteAnchor } from "../../sideTrust";
import { useStore } from "../../store";
import { useViewing } from "../../viewedChat";
import { PointerMenu } from "../agents/AgentBits";
import { Markdown } from "../chat/Markdown";

/** Claude's finished answer with the right-click "곁질문으로 묻기". */
export function QuotableMarkdown({ itemId, text }: { itemId: number; text: string }) {
  const { onContextMenu, menu } = useQuoteMenu(itemId, text);
  return (
    <>
      <div onContextMenu={onContextMenu}>
        <Markdown text={text} />
      </div>
      {menu}
    </>
  );
}

/** The turn of an assistant row: the nearest user message before it that has one (null: none). */
function turnOf(itemId: number): number | null {
  const items = useStore.getState().transcript;
  const at = items.findIndex((x) => x.id === itemId);
  for (let i = at; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "user" && typeof it.turn === "number") return it.turn;
  }
  return null;
}

export function useQuoteMenu(itemId: number, text: string): { onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void; menu: ReactNode } {
  const [at, setAt] = useState<{ x: number; y: number; selection: string } | null>(null);
  const close = useRef(() => setAt(null)).current;
  const viewing = useViewing();
  const askAbout = useStore((s) => s.askAbout);
  const onContextMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const sel = window.getSelection();
    const inside = sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode);
    e.preventDefault();
    setAt({ x: e.clientX, y: e.clientY, selection: inside ? sel!.toString() : "" });
  };
  const menu = at ? (
    <PointerMenu
      at={at}
      onClose={close}
      items={[
        {
          label: at.selection.trim() ? t("Ask about this in a side question") : t("Ask about this answer in a side question"),
          disabled: viewing ? t("You are reading another chat — side questions go to the running chat.") : null,
          onClick: () => {
            const anchor = quoteAnchor(at.selection.trim() ? at.selection : text, turnOf(itemId));
            if (anchor) askAbout(anchor, { context: anchor.quote!.text });
          },
          testId: "Quote side question",
        },
      ]}
    />
  ) : null;
  return { onContextMenu, menu };
}
