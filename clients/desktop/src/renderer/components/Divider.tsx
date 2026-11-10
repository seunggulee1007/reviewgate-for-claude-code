/** Vertical drag handle between panes (M15): reports the pointer's x-delta live and the final value on release. */
import { useRef } from "react";

export function Divider(props: { onDrag: (dx: number) => void; onEnd: () => void; testId?: string }) {
  const startX = useRef(0);
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startX.current = e.clientX;
    const el = e.currentTarget as HTMLElement;
    el.classList.add("dragging");
    document.body.classList.add("resizing");
    const onMove = (ev: MouseEvent) => {
      props.onDrag(ev.clientX - startX.current);
      startX.current = ev.clientX;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      el.classList.remove("dragging");
      document.body.classList.remove("resizing");
      props.onEnd();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  return <div className="divider" role="separator" aria-orientation="vertical" onMouseDown={onMouseDown} data-testid={props.testId} />;
}
