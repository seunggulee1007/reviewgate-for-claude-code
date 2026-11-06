/**
 * r1-scope — docs/PROTOCOL.md §33.4 / §39.4: a `worktree_outside_review` row says what already ran outside this window's
 * review (no banner does): the files a command changed there, and the folder's actions — move this chat into that worktree
 * (asks first while Claude works) and open it as a workbench, or open the folder. Another chat's rows (viewing) act on
 * nothing.
 */
import { t } from "../../i18n";
import { movedChat } from "../../chatMove";
import { scopeFilesLine } from "../../scopeNotices";
import { sessionActions, type ErrorRow } from "../../sessionErrors";
import { useStore } from "../../store";
import { useViewing } from "../../viewedChat";
import { samePath } from "../Sidebar";
import { useChatMove } from "./ChatMoveViews";

export function ScopeRowFiles({ item }: { item: ErrorRow }) {
  const line = scopeFilesLine(item.facts?.files);
  return line ? <span className="err-sub" data-testid="Scope row files" title={item.facts?.files?.join("\n")}>{line}</span> : null;
}

export function ScopeRowActions({ item }: { item: ErrorRow }) {
  const workbenches = useStore((s) => s.state.workbenches.list);
  const moved = useStore((s) => movedChat(s.state) !== null);
  const viewing = useViewing();
  const chatMove = useChatMove();
  const facts = item.facts ?? {};
  const path = facts.path;
  if (viewing || !path) return null;
  const actions = sessionActions(facts.code, { count: item.count ?? 1, facts, isWorkbench: (p) => workbenches.some((w) => samePath(w.path, p)) });
  if (actions.length === 0) return null;
  return (
    <span className="row" style={{ gap: 6, marginTop: 4 }} data-testid="Scope row actions">
      {actions.map((a, i) => {
        const cls = i === 0 ? "small primary" : "small";
        switch (a) {
          case "moveChat":
            return (
              <button key={a} type="button" className={cls} disabled={moved} title={moved ? t("This chat is read-only here, so it cannot be moved.") : t("This chat continues in that worktree's window, and its changes there are reviewed")} onClick={() => chatMove.start(path)} data-testid="Row move chat">
                {t("Move This Chat There")}
              </button>
            );
          case "openWorkbench":
            return (
              <button key={a} type="button" className={cls} title={path} onClick={() => void window.rg.openWorkbenchWindow(path)} data-testid="Row open workbench">
                {t("Open as a workbench")}
              </button>
            );
          case "openFolder":
            return (
              <button key={a} type="button" className={cls} title={path} onClick={() => void window.rg.openInNewWindow(path)} data-testid="Row open folder">
                {t("Open folder")}
              </button>
            );
          default:
            return null;
        }
      })}
      {chatMove.dialog}
    </span>
  );
}
