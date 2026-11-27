/**
 * docs/PROTOCOL.md §71.2: Claude's to-do checklist over the message box — "할 일 · 5개 중 2개 완료", then at most five
 * items (□ pending, ◼ in progress with its running words, ✓ done), live. Hidden with Ctrl+Shift+L, `/todos` or its
 * chevron. As the Mac's App ComposerTodos.swift; the rules in todoChecklist.ts.
 */
import type { TodoItem } from "@reviewgate/engine";
import { t } from "../../i18n";
import { shownText, statusLabel, todoProgress, todoWindow, TODOS_KEY_LABEL, useTodoPanel } from "../../todoChecklist";
import "./todos.css";

const MARK: Record<TodoItem["status"], string> = { pending: "☐", in_progress: "◼", completed: "✓" };

export function TodoChecklist({ todos }: { todos: TodoItem[] }) {
  const shown = useTodoPanel((s) => s.shown);
  const setShown = useTodoPanel((s) => s.setShown);
  if (!shown || todos.length === 0) return null;
  const w = todoWindow(todos);
  const hide = t("Hide the checklist ({0} or /todos shows it again)", TODOS_KEY_LABEL);
  return (
    <div className="todo-panel" role="region" aria-label={t("To-dos")} title={t("Claude's to-do checklist for this chat — it follows the work live, as Ctrl+T in Claude Code")} data-testid="Todo checklist">
      <div className="todo-head">
        <span className="bold">{t("To-dos")}</span>
        <span className="muted">{todoProgress(todos)}</span>
        <span className="spacer" />
        <button type="button" className="plain tiny" onClick={() => setShown(false)} title={hide} aria-label={hide} data-testid="Todo checklist hide">⌄</button>
      </div>
      {w.before > 0 && <div className="todo-more">{t("{0} done above", w.before)}</div>}
      <ul className="todo-list">
        {w.items.map((item, i) => (
          <li key={`${w.before + i}`} className={`todo-item ${item.status}`} title={item.text} aria-label={`${statusLabel(item.status)}: ${item.text}`}>
            <span className="todo-mark" aria-hidden="true">{MARK[item.status]}</span>
            <span className="todo-text">{shownText(item)}</span>
          </li>
        ))}
      </ul>
      {w.after > 0 && <div className="todo-more">{t("+{0} more", w.after)}</div>}
    </div>
  );
}
