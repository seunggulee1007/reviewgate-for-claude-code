/**
 * MARK: wave2 desktop-diff — the right-click menu of a diff line (audit comp-19): "복사" (the selected text, when there
 * is a selection), "줄 복사" (the line's code without its +/− sign) and "경로:줄 복사" (`path:line` for IntelliJ's
 * Go to file / a chat message), and in the review pane "에디터에서 열기" at that line. A fixed popover at the pointer; Esc, a
 * click elsewhere, a scroll or the window losing focus closes it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DiffLine } from "@reviewgate/engine";
import { pathLineOf } from "../../diffTools";
import { t } from "../../i18n";
import { showToast } from "../../toast";

export type LineMenuAt = { x: number; y: number; line: DiffLine; selection: string };
/** MARK: wave3 desktop-flow — §36.14: a pane's own entries at the top of the menu (the PR diff's "Ask in a side thread"). */
export type LineMenuItem = { label: string; onClick: () => void; title?: string; disabled?: boolean; testId?: string };

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(t("Copied"));
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
  }
}

export function LineMenu(props: { at: LineMenuAt; path: string | undefined; oldPath: string | null; onClose: () => void; onOpen?: (line: DiffLine) => void; items?: LineMenuItem[] }) {
  const { at, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });

  // Keep the menu inside the window (a click near the right / bottom edge opens it to the left / above).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)) });
  }, [at.x, at.y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onClose, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onClose, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const pathLine = props.path ? pathLineOf(at.line, props.path, props.oldPath) : null;
  const run = (text: string) => {
    onClose();
    void copy(text);
  };
  return (
    <div ref={ref} className="menu line-menu" role="menu" style={{ position: "fixed", left: pos.left, top: pos.top }} data-testid="Line menu">
      {/* MARK: wave3 desktop-flow — the pane's own entries first */}
      {props.items && props.items.length > 0 && (
        <>
          {props.items.map((it) => (
            <div
              key={it.label}
              role="menuitem"
              aria-disabled={it.disabled || undefined}
              className={`item ${it.disabled ? "disabled" : ""}`}
              title={it.title}
              onClick={() => {
                if (it.disabled) return;
                onClose();
                it.onClick();
              }}
              data-testid={it.testId}
            >
              <span className="truncate">{it.label}</span>
            </div>
          ))}
          <div className="sep" />
        </>
      )}
      {at.selection.length > 0 && (
        <div role="menuitem" className="item" onClick={() => run(at.selection)} data-testid="Copy selection">
          <span className="truncate">{t("Copy")}</span>
        </div>
      )}
      <div role="menuitem" className="item" onClick={() => run(at.line.text)} data-testid="Copy line">
        <span className="truncate">{t("Copy line")}</span>
      </div>
      {pathLine && (
        <div role="menuitem" className="item" onClick={() => run(pathLine)} title={pathLine} data-testid="Copy path line">
          <span className="truncate">{t("Copy path:line")}</span>
          <span className="tiny faint mono truncate">{pathLine.slice(pathLine.lastIndexOf("/") + 1)}</span>
        </div>
      )}
      {props.onOpen && (
        <>
          <div className="sep" />
          <div
            role="menuitem"
            className="item"
            onClick={() => {
              onClose();
              props.onOpen?.(at.line);
            }}
            data-testid="Open line in editor"
          >
            <span className="truncate">↗ {t("Open in Editor")}</span>
          </div>
        </>
      )}
    </div>
  );
}
