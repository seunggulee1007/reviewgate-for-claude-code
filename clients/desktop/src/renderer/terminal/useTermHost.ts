/**
 * §57.10: connects the window's terminal registry to `window.rg.pty` once (App mounts it): links open in the browser,
 * copies go through main, the theme follows the window's. After a renderer reload (or an ErrorBoundary remount) the
 * PTYs main still runs are adopted again with their replay (`list` → `attach`), and the first fit nudges their size so
 * the TUI repaints.
 */
import { useEffect } from "react";
import { onThemeChange } from "../theme";
import { useStore } from "../store";
import type { AppSettings } from "../../shared/ipc";
import { adoptTerminal, configureTerminals, hasTerminal, initTermHost } from "./termHost";
import { clampFontSize } from "./termHostOptions";
import { usePtyInfo } from "./ptyInfo";

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
      onFontSize: (size) => void useStore.getState().saveSettings({ terminalFontSize: size }),
      log,
    });
    const offTheme = onThemeChange((theme) => configureTerminals({ theme }));
    let alive = true;
    void pty
      .info()
      .then((info) => {
        if (!alive) return;
        usePtyInfo.setState({ info });
        configureTerminals({ osBuild: info.osBuild });
      })
      .catch(() => undefined);
    // Settings › Terminal: the font size and the renderer; Ctrl+= / Ctrl+- / Ctrl+0 in a terminal save the size.
    const applySettings = (s: AppSettings | null) => configureTerminals({ fontSize: clampFontSize(s?.terminalFontSize), gpu: s?.terminalGpu === "off" ? "off" : "auto" });
    applySettings(useStore.getState().settings);
    const offSettings = useStore.subscribe((s, prev) => {
      if (s.settings !== prev.settings) applySettings(s.settings);
    });
    void pty
      .list()
      .then(async (list) => {
        for (const p of list) {
          if (!alive || hasTerminal(p.ptyId)) continue;
          const a = await pty.attach(p.ptyId).catch(() => null);
          if (!alive || !a) continue;
          adoptTerminal(p.ptyId, p.kind, { ...(p.sessionId ? { sessionId: p.sessionId } : {}), ...(p.shell ? { shell: p.shell } : {}), replay: a.replay, status: { running: a.running, exit: a.exit } });
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
      offTheme();
      offSettings();
    };
  }, []);
}
