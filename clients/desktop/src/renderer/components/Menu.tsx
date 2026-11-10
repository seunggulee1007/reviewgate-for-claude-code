/**
 * Dropdown menu primitive (the Mac app's borderless `Menu`): a label button plus a popover of items.
 * MARK: polish p-ui-kit — P1-chrome-31 / P2-review-31 / P4-composer-12: the keyboard works it as Windows' menus do
 * (components/menuKeys.ts): ↓ / Enter / Space on the button open it on the first item that can be chosen (↑ on the last),
 * ↓ ↑ Home End and a first letter move, Enter / Space choose, Esc closes it — before a dialog it sits in — and Tab leaves
 * it; focus goes back to the button. A click opens it with no item marked, as a native menu does: the item under the
 * pointer is the marked one, the one the keys move on from. The button says it has a menu and whether it is open.
 */
import { Children, isValidElement, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { isComposing, isEnter } from "../ime";
import { Icon } from "../icons";
import { firstEnabled, lastEnabled, menuKeyTarget } from "./menuKeys";
import { cycleTab, defaultButton, isDefaultButtonKey, nudge, pressDefault, pushDialog, rememberOpener, returnTarget, snapshotText, textChanged, topDialog } from "./modalDom";

export type MenuItem =
  | { kind: "item"; label: ReactNode; onClick?: (e: ReactMouseEvent) => void; disabled?: boolean; danger?: boolean; title?: string; checked?: boolean; testId?: string }
  | { kind: "sep" }
  | { kind: "head"; label: string }
  | { kind: "footer"; label: string };

type OpenFocus = "first" | "last" | "menu";

export function Menu(props: { label: ReactNode; items: MenuItem[]; title?: string; /** polish p-foundation (P2-review-29): the trigger's accessible name when its label is an icon or empty */ ariaLabel?: string; align?: "left" | "right"; className?: string; disabled?: boolean; testId?: string }) {
  const [open, setOpen] = useState(false);
  const focusOnOpen = useRef<OpenFocus>("menu");
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const buttonId = useId();
  const menuId = useId();
  const shown = open && !props.disabled;

  const show = (focus: OpenFocus) => {
    focusOnOpen.current = focus;
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!shown) return;
    const items = menuItems(list.current);
    const nav = navItems(items);
    const where = focusOnOpen.current;
    (where === "menu" || items.length === 0 ? list.current : items[where === "first" ? firstEnabled(nav) : lastEnabled(nav)])?.focus();
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // Esc is the menu's while it is open, wherever the focus is: caught on the way down, so the dialog the menu sits in
    // (components/Menu.tsx Modal), the message box or a pane never sees it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isComposing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [shown]);

  const onButtonKey = (e: ReactKeyboardEvent) => {
    if (isComposing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || isEnter(e) || e.key === " ") {
      // Not the click Enter / Space would make: the menu opens on an item, not as a click opens it.
      e.preventDefault();
      if (shown && (isEnter(e) || e.key === " ")) close(true);
      else if (shown) {
        const items = menuItems(list.current);
        items[e.key === "ArrowUp" ? lastEnabled(navItems(items)) : firstEnabled(navItems(items))]?.focus();
      } else show(e.key === "ArrowUp" ? "last" : "first");
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (isComposing(e)) return;
    const items = menuItems(list.current);
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Tab") {
      // Tab leaves the menu: it closes and Tab goes on from the button, to the control after (⇧ before) it.
      close(true);
      return;
    }
    if (isEnter(e) || e.key === " ") {
      e.preventDefault();
      // The item's own click (the one a pointer makes), so an item's ⌥ meaning (open in a new window) works from the keys too.
      items[current]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey }));
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const next = menuKeyTarget(e.key, current, navItems(items));
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className={`menu-anchor ${props.className ?? ""}`} ref={ref}>
      <button
        ref={button}
        id={buttonId}
        type="button"
        className="menu-button"
        title={props.title}
        aria-label={props.ariaLabel}
        aria-haspopup="menu"
        aria-expanded={shown}
        aria-controls={shown ? menuId : undefined}
        disabled={props.disabled}
        onClick={() => (shown ? close(false) : show("menu"))}
        onKeyDown={onButtonKey}
        data-testid={props.testId}
      >
        {props.label}
        <span className="chev" aria-hidden="true"><Icon name="chevronDown" size={12} /></span>
      </button>
      {shown && (
        <div
          ref={list}
          id={menuId}
          className={`menu rg-menu ${props.align === "right" ? "right" : ""}`}
          role="menu"
          aria-labelledby={buttonId}
          tabIndex={-1}
          onKeyDown={onMenuKey}
          // The pointer leaving the menu unmarks the item it was on (the keys start over from the menu).
          onMouseLeave={() => {
            if (list.current && list.current.contains(document.activeElement) && document.activeElement !== list.current) list.current.focus();
          }}
        >
          {menuRows(props.items, (it, e) => {
            if (it.disabled) return;
            close(true);
            it.onClick?.(e);
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The rows of an open menu. An item takes focus only from the keys or the pointer (tabIndex −1: Tab never stops in a
 * menu); a checked one is a radio item (its ✓ is not read); a disabled one stays focusable and says it is disabled.
 * MARK: polish p-ui-kit — P1-chrome-34: ▼ and ✓ are the icon set's chevron and check (icons.tsx), not font glyphs that
 * change size and weight with the font (Segoe UI Symbol on Windows).
 */
export function menuRows(items: MenuItem[], choose: (it: Extract<MenuItem, { kind: "item" }>, e: ReactMouseEvent) => void): ReactNode[] {
  return items.map((it, i) => {
    if (it.kind === "sep") return <div key={i} className="sep" role="separator" />;
    if (it.kind === "head") return <div key={i} className="head" role="none">{it.label}</div>;
    if (it.kind === "footer") return <div key={i} className="footer" role="none">{it.label}</div>;
    return (
      <div
        key={i}
        role={it.checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={it.checked === undefined ? undefined : it.checked}
        aria-disabled={it.disabled ? true : undefined}
        tabIndex={-1}
        className={`item ${it.disabled ? "disabled" : ""} ${it.danger ? "danger" : ""}`}
        title={it.title}
        data-testid={it.testId}
        // The item under the pointer is the marked one — the one ↓ / ↑ go on from, as in a native menu.
        onMouseMove={(e) => {
          if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
        }}
        onClick={(e) => choose(it, e)}
      >
        <span className="check" aria-hidden="true">{it.checked && <Icon name="check" size={12} />}</span>
        <span className="truncate">{it.label}</span>
      </div>
    );
  });
}

/** The menu's items in order (separators, headings and footers are not items). */
function menuItems(list: HTMLElement | null): HTMLElement[] {
  return list ? Array.from(list.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')) : [];
}

function navItems(items: HTMLElement[]) {
  return items.map((el) => ({ text: el.querySelector(".truncate")?.textContent ?? el.textContent ?? "", disabled: el.getAttribute("aria-disabled") === "true" }));
}

/**
 * The dialog primitive: a dimmed backdrop and a panel with a title.
 * MARK: polish p-ui-kit — P1-chrome-32 / P5-sheets-06: it is a modal dialog to the keys and to a screen reader
 * (role dialog, aria-modal, named by its title). It remembers where the focus was when it opened and gives it back when
 * it closes (unless what closed it put the focus somewhere); Tab and ⇧Tab go round inside it, and a focus that wanders to
 * the screen behind it (a pane focusing itself when a turn ends) comes back. With no field asking for the focus it takes
 * it itself, so Esc and Tab work at once. Only the newest dialog does this: a confirm over Settings has the keys.
 * MARK: polish p-ui-kit — P5-sheets-06 / P4-composer-10: Esc closes it unless it cancels an IME composition or a field
 * inside answered it first (`preventDefault`). A click on the backdrop closes it only while no text in it changed since it
 * opened (and `dismissOnBackdrop` is not false): a click past the commit message never throws it away — the dialog
 * pulses instead, and the field keeps the focus.
 * MARK: polish p-ui-kit — P5-sheets-08: ⌘↩ (Ctrl+Enter) anywhere in it presses its default button (`data-default`, else
 * the primary button of its bottom row) — a field's own ⌘↩ never runs as well, so a commit is never sent twice.
 * MARK: polish p-ui-kit — P5-sheets-06: the title and the bottom button row (a last child `<div className="actions">`)
 * stay put; the body between them scrolls, so a 637 px window never scrolls Cancel / Commit out of sight.
 */
export function Modal(props: {
  title?: ReactNode;
  children: ReactNode;
  onClose?: () => void;
  wide?: boolean;
  testId?: string;
  /** MARK: polish p-ui-kit (P5-sheets-06): false — a click on the dimmed backdrop never closes it (typed text never lets it anyway). */
  dismissOnBackdrop?: boolean;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  // Where the focus was when the dialog opened — read while rendering, before a child's autoFocus moves it.
  const [opener] = useState(() => (typeof document === "undefined" ? null : ((document.activeElement as HTMLElement | null | undefined) ?? null)));
  const latest = useRef(props);
  latest.current = props;
  const openedText = useRef<WeakMap<HTMLElement, string> | null>(null);
  const [body, footer] = splitFooter(props.children);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const pop = pushDialog(el);
    rememberOpener(el, opener);
    openedText.current = snapshotText(el);
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
    let lastInside: HTMLElement | null = el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const onKey = (e: KeyboardEvent) => {
      if (topDialog() !== el) return;
      if (e.key === "Escape") {
        // Esc closes the dialog — not the Esc that cancels a Korean composition (the text being typed stays), not one a
        // field inside already answered (a rename Esc cancels), not while it is busy (no onClose).
        const close = latest.current.onClose;
        if (e.defaultPrevented || isComposing(e) || !close) return;
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Tab" && !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.altKey) cycleTab(e, el);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (topDialog() !== el || !(e.target instanceof HTMLElement)) return;
      if (el.contains(e.target)) {
        lastInside = e.target;
        return;
      }
      if (e.target.closest(".rg-toast")) return; // a toast's button sits above the backdrop
      (lastInside?.isConnected && el.contains(lastInside) ? lastInside : el).focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      pop();
      // A real close — StrictMode's rehearsal unmount leaves the dialog on the page — gives the focus back, unless what
      // closed the dialog put it somewhere else.
      const active = document.activeElement;
      if (!el.isConnected && (active === null || active === document.body)) returnTarget(opener)?.focus({ preventScroll: true });
    };
  }, [opener]);
  return (
    <div
      className="backdrop"
      onMouseDown={(e) => {
        const el = dialog.current;
        if (e.target !== e.currentTarget || !el) return;
        e.preventDefault(); // the focus stays in the dialog (the caret in the field)
        const { onClose, dismissOnBackdrop } = latest.current;
        if (onClose && dismissOnBackdrop !== false && !(openedText.current && textChanged(el, openedText.current))) onClose();
        else nudge(el);
      }}
    >
      <div
        ref={dialog}
        className={`dialog ${props.wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.title ? titleId : undefined}
        tabIndex={-1}
        data-testid={props.testId}
        // Caught on the way down, before the field's own ⌘↩ (which would submit a second time).
        onKeyDownCapture={(e) => {
          const el = dialog.current;
          if (!el || topDialog() !== el || !isDefaultButtonKey(e)) return;
          const button = defaultButton(el);
          if (!button) return; // none, or off: the key goes on as before
          e.preventDefault();
          e.stopPropagation();
          pressDefault(el, button);
        }}
      >
        {props.title && <h3 id={titleId}>{props.title}</h3>}
        {body.length > 0 && <div className="dialog-body">{body}</div>}
        {footer}
      </div>
    </div>
  );
}

/** A dialog's children: the body, and its bottom button row — a last `<div className="actions">` — kept out of the scrolling. */
export function splitFooter(children: ReactNode): [ReactNode[], ReactNode] {
  const list = Children.toArray(children);
  const last = list[list.length - 1];
  const className = isValidElement<{ className?: unknown }>(last) && typeof last.type === "string" ? last.props.className : undefined;
  return typeof className === "string" && className.split(/\s+/).includes("actions") ? [list.slice(0, -1), last] : [list, null];
}
