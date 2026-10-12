/** Dropdown menu primitive (the Mac app's borderless `Menu`): a label button plus a popover of items. */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

export type MenuItem =
  | { kind: "item"; label: ReactNode; onClick?: (e: ReactMouseEvent) => void; disabled?: boolean; danger?: boolean; title?: string; checked?: boolean; testId?: string }
  | { kind: "sep" }
  | { kind: "head"; label: string }
  | { kind: "footer"; label: string };

export function Menu(props: { label: ReactNode; items: MenuItem[]; title?: string; align?: "left" | "right"; className?: string; disabled?: boolean; testId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className={`menu-anchor ${props.className ?? ""}`} ref={ref}>
      <button type="button" className="menu-button" title={props.title} disabled={props.disabled} onClick={() => setOpen((o) => !o)} data-testid={props.testId}>
        {props.label}
        <span className="chev">▼</span>
      </button>
      {open && !props.disabled && (
        <div className={`menu ${props.align === "right" ? "right" : ""}`} role="menu">
          {props.items.map((it, i) => {
            if (it.kind === "sep") return <div key={i} className="sep" />;
            if (it.kind === "head") return <div key={i} className="head">{it.label}</div>;
            if (it.kind === "footer") return <div key={i} className="footer">{it.label}</div>;
            return (
              <div
                key={i}
                role="menuitem"
                className={`item ${it.disabled ? "disabled" : ""} ${it.danger ? "danger" : ""}`}
                title={it.title}
                data-testid={it.testId}
                onClick={(e) => {
                  if (it.disabled) return;
                  setOpen(false);
                  it.onClick?.(e);
                }}
              >
                <span style={{ width: 12, textAlign: "center" }}>{it.checked ? "✓" : ""}</span>
                <span className="truncate">{it.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Modal(props: { title?: ReactNode; children: ReactNode; onClose?: () => void; wide?: boolean; testId?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose?.()}>
      <div className={`dialog ${props.wide ? "wide" : ""}`} role="dialog" data-testid={props.testId}>
        {props.title && <h3>{props.title}</h3>}
        {props.children}
      </div>
    </div>
  );
}
