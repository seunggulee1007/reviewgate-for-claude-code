/**
 * MARK: polish p-lifecycle — P1-chrome-09 / P2-review-28: what the menu bar's Review and Chat items can do in a window now —
 * the Mac's `MenuState`. The page works it out from its store and sends it when it changes (`rg:menuState`); main keeps it
 * per window and builds the menu with the focused window's, so an item that cannot run is disabled instead of doing
 * nothing. Pure.
 */

export type MenuEnabled = {
  /** The selected file waits for review and may be accepted now. */
  accept: boolean;
  /** …and rejected now (the Mac's ⌘⇧R rules: the Changes tab, no past review shown, the diff pane open). */
  reject: boolean;
  /** Files wait for review: next / previous pending file. */
  pending: boolean;
  acceptAll: boolean;
  rejectAll: boolean;
  finishReview: boolean;
  commit: boolean;
  createPR: boolean;
  /** A new chat / another tab may be opened (no switch blocker). */
  chatSwitch: boolean;
  /** A turn runs (Stop). */
  stop: boolean;
};

export const MENU_ENABLED_KEYS: readonly (keyof MenuEnabled)[] = ["accept", "reject", "pending", "acceptAll", "rejectAll", "finishReview", "commit", "createPR", "chatSwitch", "stop"];

/** Everything off — a window that has not said (or has no project). */
export const NOTHING_ENABLED: MenuEnabled = Object.fromEntries(MENU_ENABLED_KEYS.map((k) => [k, false])) as MenuEnabled;

/** What a page sent, kept to booleans (anything else is off). */
export function validMenuState(raw: unknown): MenuEnabled {
  const o = (raw ?? {}) as Record<string, unknown>;
  return Object.fromEntries(MENU_ENABLED_KEYS.map((k) => [k, o[k] === true])) as MenuEnabled;
}

export function sameMenuState(a: MenuEnabled | null, b: MenuEnabled | null): boolean {
  if (a === null || b === null) return a === b;
  return MENU_ENABLED_KEYS.every((k) => a[k] === b[k]);
}
