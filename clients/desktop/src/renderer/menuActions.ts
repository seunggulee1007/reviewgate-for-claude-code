/**
 * MARK: polish p-foundation — P1-chrome-09: where a menu bar item lands in the renderer when App.tsx's `onMenu` switch
 * has no case of its own for it. A lane adds menu items (src/main/menu.ts, a `MenuAction` type in src/shared/ipc.ts) and
 * their handlers in its own table file, never in App.tsx:
 *
 *   // menuActions.lifecycle.ts (p-lifecycle), menuActions.window.ts (p-window)
 *   export const lifecycleMenuActions: MenuActionHandlers = { accept: () => useStore.getState().acceptSelected() };
 *
 * or, from a component while it is mounted (a dialog that owns the action):
 *
 *   useEffect(() => registerMenuAction("find_chat", () => openFind()), []);
 *
 * A handler registered at run time wins over a table's.
 */
import type { MenuAction } from "../shared/ipc";
import { lifecycleMenuActions } from "./menuActions.lifecycle";
import { windowMenuActions } from "./menuActions.window";

type ActionOf<K extends MenuAction["type"]> = Extract<MenuAction, { type: K }>;

/** A handler per menu action type, each given its own action. */
export type MenuActionHandlers = { [K in MenuAction["type"]]?: (action: ActionOf<K>) => void };

const registered = new Map<string, (action: MenuAction) => void>();
const tables: MenuActionHandlers[] = [lifecycleMenuActions, windowMenuActions];

/** Handles `type` until the returned function is called (the latest registration of a type wins). */
export function registerMenuAction<K extends MenuAction["type"]>(type: K, handler: (action: ActionOf<K>) => void): () => void {
  const entry = handler as (action: MenuAction) => void;
  registered.set(type, entry);
  return () => {
    if (registered.get(type) === entry) registered.delete(type);
  };
}

/** Runs the handler of `action` (registered at run time first, then the lanes' tables); false when none has one. */
export function runMenuAction(action: MenuAction): boolean {
  const handler = registered.get(action.type) ?? tableHandler(action.type);
  if (!handler) return false;
  handler(action);
  return true;
}

function tableHandler(type: MenuAction["type"]): ((action: MenuAction) => void) | undefined {
  for (const table of tables) {
    const handler = table[type] as ((action: MenuAction) => void) | undefined;
    if (handler) return handler;
  }
  return undefined;
}
