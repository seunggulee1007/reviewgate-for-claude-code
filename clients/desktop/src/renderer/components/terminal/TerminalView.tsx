/**
 * §57.10 (plan §4.1): shows one terminal of the registry (renderer/terminal/termHost.ts) — its persistent element is
 * re-parented into this view while it is mounted, so unmounting (a chat switch, the PRs tab, the panel hidden) never
 * ends the terminal or loses its screen.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { hasTerminal, mountTerminal, subscribeTerminals, terminalsVersion } from "../../terminal/termHost";

export function TerminalView(props: { ptyId: string; label: string; testId?: string; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useSyncExternalStore(subscribeTerminals, terminalsVersion, terminalsVersion);
  const known = hasTerminal(props.ptyId);
  useEffect(() => {
    if (!ref.current || !known) return;
    return mountTerminal(props.ptyId, ref.current);
  }, [props.ptyId, known]);
  return <div ref={ref} className="term-view" role="group" aria-label={props.label} title={props.title} data-testid={props.testId} />;
}
