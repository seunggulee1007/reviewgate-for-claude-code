/**
 * The window's one-line toast (src/renderer/toast.ts): above the bottom of the chat transcript (the window's bottom centre
 * when there is none), announced politely, gone after a moment.
 */
import { useLayoutEffect, useState } from "react";
import { toastPlacement, useToast } from "../toast";
import "./session.css";

export function Toast() {
  const text = useToast((s) => s.text);
  const seq = useToast((s) => s.seq);
  // wave2 check-clients: placed where the chat is, measured when it shows (toast.ts `toastPlacement`).
  const [place, setPlace] = useState<ReturnType<typeof toastPlacement>>(null);
  useLayoutEffect(() => {
    if (!text) return;
    const r = document.querySelector(".pane.chat .transcript-wrap")?.getBoundingClientRect() ?? null;
    setPlace(toastPlacement(r, window.innerHeight));
  }, [text, seq]);
  if (!text) return null;
  return (
    <div key={seq} className="rg-toast" role="status" aria-live="polite" style={place ? { left: place.left, bottom: place.bottom, maxWidth: place.maxWidth } : undefined} data-testid="Toast">
      {text}
    </div>
  );
}
