/**
 * MARK: c-panel — §57.18: the bottom panel's Run tab — the repository's commands on the left (kept, then what main found
 * in the project folder), the selected one's bar (state, Run / Stop / Restart) over its terminal on the right. A found
 * command asks once, inline ("Run this command?"). Logic: terminal/runPanel.ts.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { needsConfirmation, type RunConfig } from "../../../shared/runConfigs";
import { t } from "../../i18n";
import { Icon } from "../../icons";
import { isEnter } from "../../ime";
import { useStore } from "../../store";
import { usePtyInfo } from "../../terminal/ptyInfo";
import { addRun, cancelConfirm, confirmRun, deleteRun, findAgain, listedConfigs, loadDetected, runConfig, runStatus, stopRun, useRunPanel } from "../../terminal/runPanel";
import { runTerminalOf, subscribeTerminals, terminalsVersion, terminalStatus } from "../../terminal/termHost";
import { PointerMenu, type AgentMenuItem } from "../agents/AgentBits";
import { TerminalView } from "./TerminalView";

export function RunPanel() {
  const { selected, confirming, failed } = useRunPanel();
  useRunPanel((s) => s.detected);
  useStore((s) => s.settings?.projectRunConfigs);
  const project = useStore((s) => s.state.project?.path ?? "");
  const canRun = usePtyInfo((s) => (s.info?.shells.length ?? 0) > 0);
  useSyncExternalStore(subscribeTerminals, terminalsVersion, terminalsVersion);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; config: RunConfig } | null>(null);
  useEffect(() => {
    void loadDetected();
  }, [project]);
  const configs = listedConfigs();
  const current = configs.find((c) => c.id === selected) ?? configs[0] ?? null;
  const noPty = canRun ? null : t("Terminals need Windows 10 1903 or later");

  const menuItems = (c: RunConfig): AgentMenuItem[] => {
    const running = terminalStatus(runTerminalOf(c.id)).running;
    return [
      { label: t("Run"), onClick: () => runConfig(c), disabled: running ? t("It is running — Stop it or Restart") : noPty, testId: "Run menu run" },
      { label: t("Stop"), onClick: () => void stopRun(c.id), disabled: running ? null : t("Not running"), testId: "Run menu stop" },
      { label: t("Copy Command"), onClick: () => void navigator.clipboard.writeText(c.command).catch(() => undefined), testId: "Run menu copy" },
      { label: t("Remove"), onClick: () => void deleteRun(c), danger: true, testId: "Run menu remove" },
    ];
  };

  return (
    <div className="run-panel" data-testid="Run panel">
      <div className="run-list" role="listbox" aria-label={t("Run")}>
        {adding && <AddRunForm onDone={() => setAdding(false)} />}
        {configs.length === 0 && !adding && <div className="caption muted run-none">{t("No run commands found in this project — add one.")}</div>}
        {configs.map((c) => {
          const running = terminalStatus(runTerminalOf(c.id)).running;
          return (
            <div
              key={c.id}
              role="option"
              tabIndex={0}
              aria-selected={c.id === current?.id}
              className={`run-row ${c.id === current?.id ? "active" : ""}`}
              title={t("{0} — {1}", c.name, c.command)}
              onClick={() => useRunPanel.setState({ selected: c.id })}
              onKeyDown={(e) => {
                if (isEnter(e) || e.key === " ") {
                  e.preventDefault();
                  useRunPanel.setState({ selected: c.id });
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ at: { x: e.clientX, y: e.clientY }, config: c });
              }}
              data-testid={`Run config ${c.id}`}
            >
              <span className={`run-dot ${running ? "on" : ""}`} title={running ? t("Running") : t("Not running")} aria-hidden="true" />
              <span className="run-text">
                <span className="truncate">
                  {c.name}
                  {needsConfirmation(c) && (
                    <span className="caption muted" title={t("Found in the project's files — it asks before its first run")}>
                      {" "}
                      {t("found")}
                    </span>
                  )}
                </span>
                <code className="caption muted truncate">{c.command}</code>
              </span>
              {running ? (
                <button type="button" className="plain small" aria-label={t("Stop ‘{0}’", c.name)} title={t("Stop — ends the command and what it started")} onClick={(e) => (e.stopPropagation(), void stopRun(c.id))} data-testid={`Run stop ${c.id}`}>
                  <Icon name="stop" size={11} />
                </button>
              ) : (
                <button type="button" className="plain small" disabled={noPty !== null} aria-label={t("Run ‘{0}’", c.name)} title={noPty ?? t("Run {0} in the project folder", c.command)} onClick={(e) => (e.stopPropagation(), runConfig(c))} data-testid={`Run start ${c.id}`}>
                  <Icon name="play" size={11} />
                </button>
              )}
            </div>
          );
        })}
        <div className="run-list-bar row">
          <button type="button" className="plain small" onClick={() => setAdding(true)} disabled={adding} title={adding ? t("Type the command first") : t("Add a command to run in the project folder")} data-testid="Run add command">
            <Icon name="plus" size={11} /> {t("Add Command…")}
          </button>
          <span className="grow" />
          <button type="button" className="plain small" aria-label={t("Find run commands again")} title={t("Find again — read package.json, the Gradle and Maven wrappers again and bring back removed ones")} onClick={() => void findAgain()} data-testid="Run find again">
            <Icon name="refresh" size={11} />
          </button>
        </div>
      </div>
      <div className="run-body">{current ? <RunDetail config={current} confirming={confirming?.id === current.id ? confirming : null} failed={failed} noPty={noPty} project={project} /> : null}</div>
      {menu && <PointerMenu at={menu.at} items={menuItems(menu.config)} onClose={() => setMenu(null)} />}
    </div>
  );
}

function RunDetail(props: { config: RunConfig; confirming: RunConfig | null; failed: string | null; noPty: string | null; project: string }) {
  const { config } = props;
  const ptyId = runTerminalOf(config.id);
  const running = terminalStatus(ptyId).running;
  const status = runStatus(config.id, t);
  const runReason = props.noPty ?? (running ? t("It is running — Stop it or Restart") : null);
  return (
    <>
      <div className="run-bar row">
        <strong className="caption truncate">{config.name}</strong>
        {status && (
          <span className={`caption ${status.failed ? "orange" : "muted"}`} role="status" data-testid="Run status">
            {status.text}
          </span>
        )}
        {props.failed && (
          <span className="caption orange truncate" role="status" title={props.failed}>
            {props.failed}
          </span>
        )}
        <span className="grow" />
        <button type="button" className="plain small" disabled={runReason !== null} aria-label={t("Run")} title={runReason ?? t("Run {0} in the project folder", config.command)} onClick={() => runConfig(config)} data-testid="Run detail start">
          <Icon name="play" size={12} />
        </button>
        <button type="button" className="plain small" disabled={!running} aria-label={t("Stop")} title={running ? t("Stop — ends the command and what it started") : t("Not running")} onClick={() => void stopRun(config.id)} data-testid="Run detail stop">
          <Icon name="stop" size={12} />
        </button>
        <button
          type="button"
          className="plain small"
          disabled={!ptyId || props.noPty !== null}
          aria-label={t("Restart")}
          title={props.noPty ?? (ptyId ? t("Restart — stops it and runs it again in a fresh terminal") : t("It has not run yet — Run starts it"))}
          onClick={() => runConfig(config)}
          data-testid="Run detail restart"
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {props.confirming ? (
        <div className="run-confirm" role="alertdialog" aria-label={t("Run this command?")} data-testid="Run confirm">
          <strong>{t("Run this command?")}</strong>
          <code>{props.confirming.command}</code>
          <span className="caption muted">{t("It runs in {0} as you, with your permissions — ReviewGate does not sandbox it. It asks only before this command's first run.", props.project)}</span>
          <div className="row">
            <button type="button" className="primary" onClick={() => void confirmRun()} data-testid="Run confirm run">
              {t("Run")}
            </button>
            <button type="button" onClick={cancelConfirm} data-testid="Run confirm cancel">
              {t("Cancel")}
            </button>
          </div>
        </div>
      ) : ptyId ? (
        <TerminalView key={ptyId} ptyId={ptyId} label={config.name} testId="Run terminal" />
      ) : (
        <div className="run-idle" data-testid="Run idle">
          <code>{config.command}</code>
          <button type="button" disabled={props.noPty !== null} title={props.noPty ?? t("Run {0} in the project folder", config.command)} onClick={() => runConfig(config)}>
            <Icon name="play" size={11} /> {t("Run")}
          </button>
          <span className="caption muted">{t("It runs in {0} through Settings' terminal shell, as you — ReviewGate does not sandbox it.", props.project)}</span>
        </div>
      )}
    </>
  );
}

function AddRunForm(props: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const blank = command.trim().length === 0;
  const save = async () => {
    if ((await addRun(name, command)) !== null) props.onDone();
  };
  return (
    <form
      className="run-add"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onDone();
      }}
      data-testid="Run add form"
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Name (optional)")} aria-label={t("Name (optional)")} />
      <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t("Command, e.g. .\\gradlew.bat bootRun")} aria-label={t("Command")} autoFocus className="mono" />
      <div className="row">
        <button type="submit" className="primary small" disabled={blank} title={blank ? t("Type the command first") : t("Add it to this project's run commands")}>
          {t("Add")}
        </button>
        <button type="button" className="small" onClick={props.onDone}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}
