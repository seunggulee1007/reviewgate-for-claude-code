/**
 * §57.10: connects the window's terminal registry to `window.rg.pty` once (App mounts it): links open in the browser,
 * copies go through main, the theme follows the window's. After a renderer reload (or an ErrorBoundary remount) the
 * PTYs main still runs are adopted again with their replay (`list` → `attach`), and the first fit nudges their size so
 * the TUI repaints.
 */
import { useEffect } from "react";
import { onThemeChange } from "../theme";
import { useStore } from "../store";
import { adoptTerminal, configureTerminals, hasTerminal, initTermHost } from "./termHost";

export function useTermHost(): void {
  useEffect(() => {
    const rg = window.rg;
    const pty = rg?.pty;
    if (!pty) return;
    const log = (line: string) => useStore.setState((s) => ({ logs: [...s.logs, line].slice(-500) }));
    configureTerminals({ platform: rg.platform });
    const off = initTermHost(pty, {
      openLink: (uri) => void rg.openExternal(uri),
      copy: (text) => void rg.copyText(text),
      log,
    });
    const offTheme = onThemeChange((theme) => configureTerminals({ theme }));
    let alive = true;
    void pty
      .info()
      .then((info) => alive && configureTerminals({ osBuild: info.osBuild }))
      .catch(() => undefined);
    void pty
      .list()
      .then(async (list) => {
        for (const p of list) {
          if (!alive || hasTerminal(p.ptyId)) continue;
          const a = await pty.attach(p.ptyId).catch(() => null);
          if (!alive || !a) continue;
          adoptTerminal(p.ptyId, p.kind, { ...(p.sessionId ? { sessionId: p.sessionId } : {}), replay: a.replay, status: { running: a.running, exit: a.exit } });
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
      offTheme();
    };
  }, []);
}
