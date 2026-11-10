/**
 * Lane p-window's menu bar actions (polish: Quick Open, project search, the window's panes): a handler per `MenuAction`
 * type, run by `runMenuAction` (menuActions.ts) when App.tsx's `onMenu` has no case for it. Seeded empty by p-foundation;
 * owned by p-window.
 */
import type { MenuActionHandlers } from "./menuActions";

export const windowMenuActions: MenuActionHandlers = {};
