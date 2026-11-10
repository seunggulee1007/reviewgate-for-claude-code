/**
 * MARK: polish p-ui-kit — the DOM side of the dialog primitive (`Modal` in components/Menu.tsx): which dialog is the
 * newest (only that one takes the keys and holds the focus), where Tab goes inside it, where the focus goes back, what a
 * click past it would throw away, and its default button.
 *
 *   if (topDialog() === el && e.key === "Tab") cycleTab(e, el);
 *   const b = isDefaultButtonKey(e) ? defaultButton(el) : null; // ⌘↩ → <button className="primary"> in .actions
 *   <button type="button" data-default onClick={create}>…</button>   // a default button outside the bottom row
 */
import { isEnter, type ImeKeyLike } from "../ime";

const openDialogs: HTMLElement[] = [];

/** A dialog opened (its element). The newest is the one on top: a confirm over Settings takes the keys, Settings waits. */
export function pushDialog(el: HTMLElement): () => void {
  openDialogs.push(el);
  return () => {
    const i = openDialogs.lastIndexOf(el);
    if (i >= 0) openDialogs.splice(i, 1);
  };
}

export function topDialog(): HTMLElement | null {
  return openDialogs[openDialogs.length - 1] ?? null;
}

const openers = new WeakMap<Element, HTMLElement | null>();

/** Where the focus was when this dialog opened. */
export function rememberOpener(dialog: HTMLElement, opener: HTMLElement | null): void {
  openers.set(dialog, opener);
}

/**
 * Where the focus goes back to when a dialog closes: where it was when the dialog opened — or, when that was a button in
 * a dialog that is gone (Reject all → its second confirm took the same slot), where the focus was before that one.
 */
export function returnTarget(opener: HTMLElement | null): HTMLElement | null {
  let target = opener;
  for (let hops = 0; target && !target.isConnected && hops < 8; hops++) {
    const gone = target.closest('[role="dialog"]');
    target = gone ? (openers.get(gone) ?? null) : null;
  }
  return target?.isConnected ? target : null;
}

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';

/** The controls Tab stops on in this dialog, in order — not a nested dialog's, not a disabled or hidden one, one per radio group. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.tabIndex < 0 || el.matches(":disabled") || el.closest('[role="dialog"]') !== root || el.closest("[inert]")) return false;
    if (el.getClientRects().length === 0 || getComputedStyle(el).visibility === "hidden") return false;
    if (el instanceof HTMLInputElement && el.type === "radio" && el.name) {
      // A radio group is one stop: its checked button, else its first.
      const group = Array.from(root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`));
      const stop = group.find((r) => r.checked) ?? group[0];
      if (stop !== el) return false;
    }
    return true;
  });
}

/** Tab / ⇧Tab go round inside the dialog: from the last control to the first and back, never to the screen behind it. */
export function cycleTab(e: KeyboardEvent, root: HTMLElement): void {
  const list = tabbables(root);
  const active = document.activeElement as HTMLElement | null;
  if (list.length === 0) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = list[0]!;
  const last = list[list.length - 1]!;
  if (!active || !root.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

const TEXT_FIELDS = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="tel"], input[type="password"], input[type="number"], [contenteditable=""], [contenteditable="true"]';

function textFields(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TEXT_FIELDS)).filter((el) => el.closest('[role="dialog"]') === root);
}

function textOf(el: HTMLElement): string {
  const value = (el as Partial<HTMLInputElement>).value;
  return typeof value === "string" ? value : (el.textContent ?? "");
}

/** The text in the dialog's fields as it opened (a generated commit message counts as the dialog's own). */
export function snapshotText(root: HTMLElement): WeakMap<HTMLElement, string> {
  const at = new WeakMap<HTMLElement, string>();
  for (const el of textFields(root)) at.set(el, textOf(el));
  return at;
}

/** Whether a field's text changed since the dialog opened — what a click outside it would throw away. */
export function textChanged(root: HTMLElement, at: WeakMap<HTMLElement, string>): boolean {
  return textFields(root).some((el) => textOf(el) !== (at.get(el) ?? ""));
}

/** The dialog stays and says so: a short pulse (an outline with reduced motion), as Windows flashes a dialog clicked past. */
export function nudge(el: HTMLElement): void {
  el.removeAttribute("data-nudge");
  void el.offsetWidth; // restart the animation on a second click
  el.setAttribute("data-nudge", "");
  window.setTimeout(() => el.removeAttribute("data-nudge"), 400);
}

/** ⌘↩ (Ctrl+Enter on Windows): a dialog's default button — not with ⌥ or ⇧ (other meanings), not the Enter that ends a composition. */
export function isDefaultButtonKey(e: ImeKeyLike & { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && isEnter(e);
}

/**
 * The dialog's default button: one marked `data-default`, else the primary button of its last button row (`.actions`,
 * the row at the bottom — Commit, Create PR, Submit review, Done). None when it is disabled, or when the row's strongest
 * button is a danger one (a confirm to revert has no default: Cancel has the focus).
 */
export function defaultButton(root: HTMLElement): HTMLButtonElement | null {
  const own = <T extends Element>(list: NodeListOf<T>): T[] => Array.from(list).filter((el) => el.closest('[role="dialog"]') === root);
  const marked = own(root.querySelectorAll<HTMLButtonElement>("button[data-default]"));
  const rows = own(root.querySelectorAll<HTMLElement>(".actions"));
  const primary = rows.length > 0 ? own(rows[rows.length - 1]!.querySelectorAll<HTMLButtonElement>("button.primary")) : [];
  const button = marked[marked.length - 1] ?? primary[primary.length - 1] ?? null;
  return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" ? button : null;
}

/**
 * Press the default button as macOS does: the field being edited ends its editing first (a setting that saves when it
 * loses the focus saves), then the button is clicked; if the dialog stays (a commit still running, an error shown), the
 * field gets the focus back.
 */
export function pressDefault(root: HTMLElement, button: HTMLButtonElement): void {
  const active = document.activeElement;
  const field = active instanceof HTMLElement && active !== button && active !== root && root.contains(active) ? active : null;
  field?.blur();
  button.click();
  if (field?.isConnected && (document.activeElement === null || document.activeElement === document.body)) field.focus({ preventScroll: true });
}
