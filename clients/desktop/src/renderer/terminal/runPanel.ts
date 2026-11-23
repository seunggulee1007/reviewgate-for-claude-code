/**
 * MARK: c-panel — docs/PROTOCOL.md §57.18: the bottom panel's Run tab on Windows, as on the Mac (RunPanel.swift). The
 * repository's kept commands (`settings.projectRunConfigs`, src/shared/runConfigs.ts) plus what main detects in the
 * project folder (`rg.pty.detectRuns`); each one runs in its own PTY (main: Settings' terminal shell `-Command` /
 * `/c` in the project root — the renderer names only the config's id). Nothing runs without a click; a detected command
 * asks once and is kept as confirmed. Its output stays until it is run again (a fresh terminal).
 */
import { create } from "zustand";
import { flowRepoRoot, withRepoEntry } from "../../shared/flowSettings";
import { projectRootHash } from "../../shared/hash";
import { keepRun, listedRuns, needsConfirmation, removeRun, restoreDetected, storedRuns, type ProjectRuns, type RunConfig } from "../../shared/runConfigs";
import { useStore } from "../store";
import { measureCellWidth } from "../terminalLayout";
import { terminalStartRefusal } from "../terminalStrip";
import { adoptTerminal, disposeTerminal, estimateSize, focusTerminal, runTerminalOf, terminalConfig, terminalStatus } from "./termHost";
import { TERMINAL_FONT_FAMILY } from "./termHostOptions";

export const useRunPanel = create<{
  /** What main found in the project folder (read when the tab shows, and on Find Again). */
  detected: RunConfig[];
  selected: string | null;
  /** The detected command waiting for Run in the confirmation. */
  confirming: RunConfig | null;
  /** Why the last start failed (cleared by the next). */
  failed: string | null;
}>(() => ({ detected: [], selected: null, confirming: null, failed: null }));

/** The repository's kept runs (the flow settings' key: every workbench of it shares them). */
export function keptRuns(): ProjectRuns | undefined {
  const s = useStore.getState();
  const root = flowRepoRoot(s.state);
  return root ? s.settings?.projectRunConfigs?.[projectRootHash(root)] : undefined;
}

/** What the tab lists: the kept commands, then the detected ones neither kept nor removed. */
export function listedConfigs(): RunConfig[] {
  return listedRuns(keptRuns(), useRunPanel.getState().detected);
}

async function saveRuns(next: ProjectRuns): Promise<void> {
  const s = useStore.getState();
  const root = flowRepoRoot(s.state);
  if (!root || !s.settings) return;
  await s.saveSettings({ projectRunConfigs: withRepoEntry(s.settings.projectRunConfigs, root, storedRuns(next)) });
}

/** Asks main for the project folder's candidates (nothing runs). */
export async function loadDetected(): Promise<void> {
  let detected: RunConfig[] = [];
  try {
    detected = (await window.rg?.pty?.detectRuns?.()) ?? [];
  } catch {
    /* no window for this renderer */
  }
  useRunPanel.setState({ detected });
}

/** ▶ (also Restart): a detected command asks first, once; any other runs in a fresh terminal. */
export function runConfig(config: RunConfig): void {
  useRunPanel.setState({ selected: config.id, failed: null });
  if (needsConfirmation(config)) {
    useRunPanel.setState({ confirming: config });
    return;
  }
  void startRun(config.id);
}

/** Run in the confirmation: kept as confirmed, then run. */
export async function confirmRun(): Promise<void> {
  const config = useRunPanel.getState().confirming;
  if (!config) return;
  useRunPanel.setState({ confirming: null });
  await saveRuns(keepRun(keptRuns(), { ...config, confirmed: true }));
  await startRun(config.id);
}

export function cancelConfirm(): void {
  useRunPanel.setState({ confirming: null });
}

async function startRun(runId: string): Promise<void> {
  const pty = window.rg?.pty;
  if (!pty) return;
  const size = estimateSize(document.querySelector<HTMLElement>(".shell-panel .run-body"), measureCellWidth(`${terminalConfig().fontSize}px ${TERMINAL_FONT_FAMILY}`));
  try {
    const r = await pty.open({ kind: "run", runId, ...size });
    if (!r.ok) {
      useRunPanel.setState({ failed: terminalStartRefusal(r.code, r.error) ?? (r.error || r.code) });
      return;
    }
    // Main ended the previous PTY of this command; its terminal goes (a run again is a fresh one).
    const old = runTerminalOf(runId);
    if (old && old !== r.ptyId) disposeTerminal(old);
    adoptTerminal(r.ptyId, "run", { runId });
    setTimeout(() => focusTerminal(r.ptyId), 0);
  } catch (e) {
    useRunPanel.setState({ failed: terminalStartRefusal("spawn_failed", e instanceof Error ? e.message : String(e)) });
  }
}

/** ■: the command and what it started end (main closes the pseudoconsole, then the tree); the output stays. */
export async function stopRun(runId: string): Promise<void> {
  const ptyId = runTerminalOf(runId);
  if (ptyId && terminalStatus(ptyId).running) await window.rg?.pty?.kill(ptyId).catch(() => undefined);
}

/** Add Command…: the user's own command — theirs, so it never asks. Null when the command is blank. */
export async function addRun(name: string, command: string): Promise<RunConfig | null> {
  const cmd = command.trim();
  if (!cmd || /[\r\n]/.test(cmd)) return null;
  const config: RunConfig = { id: crypto.randomUUID(), name: name.trim() || cmd, command: cmd, detected: false, confirmed: true };
  await saveRuns(keepRun(keptRuns(), config));
  useRunPanel.setState({ selected: config.id });
  return config;
}

/** Remove: a kept command goes; a detected one stays away until Find Again. A running one is stopped first. */
export async function deleteRun(config: RunConfig): Promise<void> {
  await stopRun(config.id);
  const ptyId = runTerminalOf(config.id);
  if (ptyId) disposeTerminal(ptyId);
  await saveRuns(removeRun(keptRuns(), config));
}

/** Find Again: the folder is read again and removed detected commands come back. */
export async function findAgain(): Promise<void> {
  await saveRuns(restoreDetected(keptRuns()));
  await loadDetected();
}

/** "Running" / "Exited (n)" / "Stopped"; null before its first run. */
export function runStatus(runId: string, t: (k: string, ...a: (string | number)[]) => string): { text: string; failed: boolean } | null {
  const ptyId = runTerminalOf(runId);
  if (!ptyId) return null;
  const st = terminalStatus(ptyId);
  if (st.running) return { text: t("Running"), failed: false };
  const exit = st.exit;
  if (!exit || exit.reason === "killed" || exit.reason === "closed" || exit.exitCode === null) return { text: t("Stopped"), failed: false };
  return { text: t("Exited ({0})", exit.exitCode), failed: exit.exitCode !== 0 };
}
