/**
 * docs/PROTOCOL.md §72.1: `/hooks` — the hooks in effect, read-only, as the terminal's `/hooks` browser: by event, each
 * with its matcher, what it runs and where it is defined, and Open in Editor for its file. As on the Mac (App
 * HooksSheet.swift); the words in hooksList.ts.
 */
import { useEffect, useState } from "react";
import type { HookEntry, HookFile } from "@reviewgate/engine";
import { t } from "../../i18n";
import { hookDetails, hookOpenHelp, hookSourceLabel, hooksByEvent, hooksOffText, loadHooks, matcherLabel, type HooksList } from "../../hooksList";
import { Menu, Modal } from "../Menu";

export function HooksDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<HooksList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allEvents, setAllEvents] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const load = () => {
    void loadHooks().then((r) => {
      if ("list" in r) {
        setList(r.list);
        setError(null);
      } else setError(r.error);
    });
  };
  useEffect(load, []);
  const open = (path: string) => {
    void window.rg.openInEditor(path, 1).then((why) => setOpenError(why));
  };
  const groups = list ? hooksByEvent(list.hooks, allEvents) : [];
  const off = hooksOffText(list?.off ?? null);
  return (
    <Modal title={t("Hooks")} onClose={onClose} wide testId="Hooks dialog">
      <div className="row hooks-head">
        <span className="tiny muted">{t("Read-only, as the terminal's /hooks. To change a hook, edit the file that defines it.")}</span>
        <span className="spacer" />
        <label className="tiny row" title={t("Also list the events no hook is set for, as the terminal's All events")}>
          <input type="checkbox" checked={allEvents} disabled={list === null} onChange={(e) => setAllEvents(e.target.checked)} data-testid="Hooks all events" />
          {t("All events")}
        </label>
        <button type="button" className="small" onClick={load} title={t("Read the settings files again")} data-testid="Hooks refresh">{t("Refresh")}</button>
      </div>
      {off && <div className="tiny orange" data-testid="Hooks off">{off}</div>}
      {openError && <div className="tiny orange">{openError}</div>}
      <div className="hooks-body">
        {error !== null ? (
          <div className="small red">{error}</div>
        ) : list === null ? (
          <div className="small muted">{t("Reading the settings files…")}</div>
        ) : groups.length === 0 ? (
          <div className="small muted hooks-empty">{t("No hooks in the settings this chat loads")}</div>
        ) : (
          groups.map((g) => (
            <section key={g.event} className="hooks-event" data-testid={`Hooks event ${g.event}`}>
              <div className="row">
                <span className="small bold mono">{g.event}</span>
                <span className="tiny muted">{g.hooks.length === 0 ? t("No hooks") : t("{0} hooks", g.hooks.length)}</span>
              </div>
              {g.hooks.map((h, i) => <HookRow key={`${h.path}|${i}`} hook={h} open={open} />)}
            </section>
          ))
        )}
      </div>
      <div className="tiny muted">{t("Hooks a skill or subagent adds while it runs are in no settings file and are not listed.")}</div>
      <div className="actions">
        <FilesMenu files={list?.files ?? []} open={open} />
        <span className="spacer" />
        <button type="button" className="primary" onClick={onClose} autoFocus data-testid="Hooks done">{t("Done")}</button>
      </div>
    </Modal>
  );
}

function HookRow({ hook, open }: { hook: HookEntry; open: (path: string) => void }) {
  const details = hookDetails(hook);
  const source = hookSourceLabel(hook.source, hook.plugin);
  return (
    <div className={`hooks-row${hook.active === false ? " off" : ""}`} data-testid="Hooks row" aria-label={`${hook.event}, ${matcherLabel(hook.matcher)}, ${source}`}>
      <div className="row">
        <span className="hooks-matcher mono tiny" title={t("Matcher")}>{matcherLabel(hook.matcher)}</span>
        <span className="tiny muted">{hook.type}</span>
        <span className="tiny muted truncate">{source}</span>
        {hook.active === false && <span className="tiny bold orange">{t("Off")}</span>}
        <span className="spacer" />
        <button type="button" className="small" disabled={!hook.path} onClick={() => open(hook.path)} title={hookOpenHelp(hook.path, !!hook.path)} data-testid="Hooks open">
          {t("Open in Editor")}
        </button>
      </div>
      <div className="hooks-text mono tiny" title={hook.text}>{hook.text}</div>
      {details && <div className="tiny muted">{details}</div>}
    </div>
  );
}

/** The settings files this chat reads — open one to add or change a hook (a missing one is disabled with why). */
function FilesMenu({ files, open }: { files: HookFile[]; open: (path: string) => void }) {
  return (
    <Menu
      label={t("Settings files")}
      align="left"
      disabled={files.length === 0}
      title={t("Open a settings file this chat reads in your editor")}
      testId="Hooks files"
      items={files.map((f) => ({
        kind: "item" as const,
        label: `${hookSourceLabel(f.source, f.plugin)} — ${f.path}`,
        disabled: !f.exists,
        title: hookOpenHelp(f.path, f.exists),
        onClick: () => open(f.path),
      }))}
    />
  );
}
