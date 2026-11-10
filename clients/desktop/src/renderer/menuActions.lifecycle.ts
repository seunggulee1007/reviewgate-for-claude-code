/**
 * Lane p-lifecycle's menu bar actions (polish P1-chrome-09: the Review / Chat menus, Help items): a handler per
 * `MenuAction` type, run by `runMenuAction` (menuActions.ts) when App.tsx's `onMenu` has no case for it. Seeded empty by
 * p-foundation; owned by p-lifecycle. The page's other answers to main (the close / quit question's facts, what the menu
 * items can do now) are wired from here once the page loads (lifecyclePage.ts).
 *
 * This table loads wherever menuActions.ts does (its tests run without a page), so the store is loaded only when an item
 * is chosen.
 */
import type { MenuActionHandlers } from "./menuActions";

type StoreModule = typeof import("./store");
type Store = ReturnType<StoreModule["useStore"]["getState"]>;

/** Runs `run` with the store (loaded on first use). */
const withStore = (run: (s: Store, m: StoreModule) => void) => () => void import("./store").then((m) => run(m.useStore.getState(), m));

/**
 * A key the page handles itself (every one of these listens on the document), pressed from the menu bar: a click does
 * exactly what the key does, wherever the focus is — ⌘ on a Mac, Ctrl elsewhere.
 */
export function pressKey(k: { key: string; code: string; shift?: boolean; alt?: boolean }, mac = typeof window !== "undefined" && window.rg?.platform === "darwin"): void {
  if (typeof document === "undefined") return;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k.key, code: k.code, shiftKey: k.shift === true, altKey: k.alt === true, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
}

const press = (key: string, code: string, mods: { shift?: boolean; alt?: boolean } = {}) => () => pressKey({ key, code, ...mods });

/** A dialog the Review menu opens — not over another one. */
const openReviewDialog = (kind: "acceptAll" | "rejectAll" | "finishReview" | "commit" | "createPR") =>
  withStore((s) => {
    if (!s.dialog && s.state.project) s.openDialog({ kind });
  });

/** ⌘] / ⌘[ from the menu: on the Changes tab (where the list is), as the key. */
const stepPending = (dir: 1 | -1) =>
  withStore((s, m) => {
    if (s.dialog || !s.state.project || !s.state.changedFiles.some((f) => f.state === "pending")) return;
    if (s.tab !== "changes") s.setTab("changes");
    m.useStore.getState().selectPending(dir);
  });

// MARK: polish p-lifecycle — P1-chrome-09 / P2-review-28 / P4-composer-06 / P5-sheets-46 / P1-chrome-20 / P1-chrome-06.
export const lifecycleMenuActions: MenuActionHandlers = {
  // Review › Accept: the selected pending file (a blocked accept says why — the store's notice).
  accept: withStore((s) => {
    const file = s.selectedPath ? s.state.changedFiles.find((f) => f.path === s.selectedPath) : undefined;
    if (!s.dialog && file?.state === "pending") s.accept(file.path);
  }),
  // ⌘⇧R asks first and says why it cannot (src/renderer/rejectShortcut.ts).
  reject: press("R", "KeyR", { shift: true }),
  next_pending: stepPending(1),
  prev_pending: stepPending(-1),
  accept_all: openReviewDialog("acceptAll"),
  reject_all: openReviewDialog("rejectAll"),
  finish_review: openReviewDialog("finishReview"),
  add_note: press("n", "KeyN", { alt: true }),
  ask_selection: press("/", "Slash", { alt: true }),
  request_changes: press("C", "KeyC", { shift: true }),
  commit: openReviewDialog("commit"),
  create_pr: openReviewDialog("createPR"),
  new_chat: press("t", "KeyT"),
  close_chat_tab: press("W", "KeyW", { shift: true }),
  chat_tab: (a) => {
    if (a.index >= 0 && a.index < 9) pressKey({ key: String(a.index + 1), code: `Digit${a.index + 1}` });
  },
  stop: withStore((s) => {
    if (s.state.gate.phase === "running") s.interrupt();
  }),
  find_chat: press("f", "KeyF"),
  find_diff: press("f", "KeyF", { alt: true }),
  sidebar_tab: (a) =>
    withStore((s) => {
      if (s.state.project) s.setTab(a.tab);
    })(),
  close_project: withStore((s) => void s.closeProject()),
};

// The page's answers to main (lifecyclePage.ts) — once, in a window with the bridge.
if (typeof window !== "undefined" && window.rg) void import("./lifecyclePage").then((m) => m.wirePage());
