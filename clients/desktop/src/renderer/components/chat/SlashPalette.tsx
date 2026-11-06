/**
 * Floating list above the composer (the Mac app's `SlashCommandPalette`). MARK: wave3 desktop-session — §36.5 (SME-03):
 * each command with its dimmed argument hint and a one-line description, grouped by where it comes from (recently used
 * first: built-in / mine / project / each plugin / MCP), the selected row highlighted; "Starting session…" while the CLI
 * starts. The rules live in src/renderer/slashCommands.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionCapabilities } from "@reviewgate/engine";
import { t } from "../../i18n";
import { flattenSections, groupKey, groupTitle, loadSlashRecents, paletteEmptyState, paletteEmptyText, recordRecent, saveSlashRecents, sessionStarting, slashCommandIn, slashEntries, slashSections, type PaletteEmptyState, type SlashEntry, type SlashSection } from "../../slashCommands";
import { useStore } from "../../store";
import "./slash.css";

export type { SlashEntry } from "../../slashCommands";

/** The `/token` being typed at the start of the draft; null once whitespace follows it (or there is no slash). */
export function slashToken(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const rest = draft.slice(1);
  return /\s/.test(rest) ? null : rest;
}

/**
 * MARK: r1-composer M14 (docs/PROTOCOL.md §36.5) — when the composer's palette shows: a project is open (also while Claude
 * works or the session starts — the cached list, or "Starting session…"; it used to wait for a message that could be sent),
 * Esc has not closed it since the draft last changed, and ⌘/ opened it or a `/token` is typed. A pick goes into the draft;
 * ⌘↩ then sends it, puts it into the running turn or queues it, like any message.
 */
export function slashPaletteShows(o: { projectOpen: boolean; dismissed: boolean; forced: boolean; token: string | null }): boolean {
  return o.projectOpen && !o.dismissed && (o.forced || o.token !== null);
}

/**
 * The palette's model for the composer: the sections for the typed `/token`, the flattened entries (what ↑ / ↓ walk), why
 * nothing is listed, whether the CLI is still starting, and the per-project "recently used" memory (a pick, or a sent
 * message that starts with a known command).
 */
export function useSlashPalette(caps: SessionCapabilities | null, token: string | null, projectHash: string | null) {
  const starting = useStore((s) => sessionStarting(s.state.session));
  const loadUserSettings = useStore((s) => s.settings?.loadUserSettings !== false);
  const [recents, setRecents] = useState<string[]>(() => loadSlashRecents(projectHash));
  useEffect(() => setRecents(loadSlashRecents(projectHash)), [projectHash]);
  const all = useMemo(() => slashEntries(caps), [caps]);
  const sections = useMemo(() => slashSections(all, token ?? "", recents), [all, token, recents]);
  const entries = useMemo(() => flattenSections(sections), [sections]);
  const emptyState = paletteEmptyState({ caps, entries: all, shown: entries, starting, loadUserSettings });
  const record = useCallback(
    (name: string) => {
      setRecents((cur) => {
        const next = recordRecent(name, cur);
        saveSlashRecents(projectHash, next);
        return next;
      });
    },
    [projectHash],
  );
  /** A sent message that starts with a known command counts as using it. */
  const recordText = useCallback(
    (text: string) => {
      const name = slashCommandIn(text, all);
      if (name) record(name);
    },
    [all, record],
  );
  return { sections, entries, emptyState, starting, loadUserSettings, record, recordText };
}

export function SlashPalette(props: {
  sections: SlashSection[];
  selection: number;
  /** Why nothing is listed; null when there is something. */
  emptyState: PaletteEmptyState | null;
  /** The entries come from a cache (an earlier session's) until this session's arrive. */
  cached: boolean;
  /** The CLI has not answered initialize yet. */
  starting: boolean;
  onPick: (e: SlashEntry) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${props.selection}"]`) as HTMLElement | null | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [props.selection, props.sections]);

  // No header for ranked matches, nor for a lone unknown-source group (an engine before §36: names only).
  const lone = props.sections.length === 1 && props.sections[0]!.group.kind === "other";
  let index = 0;
  return (
    <div className="palette slash-palette" data-testid="Slash palette" onMouseDown={(e) => e.preventDefault()}>
      {props.emptyState ? (
        <div className="note" role="status" data-testid={props.emptyState === "starting" ? "Slash palette starting" : "Slash palette empty"}>
          {props.emptyState === "starting" && <span className="spinner" aria-hidden="true" />}
          {paletteEmptyText(props.emptyState)}
        </div>
      ) : (
        <>
          <div className="items" ref={listRef} role="listbox" aria-label={t("Commands")}>
            {props.sections.map((section) => {
              const title = lone ? null : groupTitle(section.group);
              return (
                <div key={groupKey(section.group)} role="group" aria-label={title ?? undefined}>
                  {title && <div className="slash-head" aria-hidden="true">{title}</div>}
                  {section.entries.map((entry) => {
                    const i = index++;
                    const selected = i === props.selection;
                    return (
                      <div
                        key={entry.name}
                        role="option"
                        aria-selected={selected}
                        aria-label={[`/${entry.name}`, entry.argumentHint, entry.description].filter((s) => s.length > 0).join(", ")}
                        className={`item slash-item ${selected ? "selected" : ""}`}
                        title={entry.description || `/${entry.name}`}
                        data-index={i}
                        onClick={() => props.onPick(entry)}
                        data-testid={`Slash ${entry.name}`}
                      >
                        <span className="slash-line">
                          <span className="slash-name">/{entry.name}</span>
                          {entry.argumentHint && <span className="slash-hint">{entry.argumentHint}</span>}
                          {entry.isSkill && <span className="badge">{t("skill")}</span>}
                        </span>
                        {entry.description && <span className="slash-desc">{entry.description}</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div className="foot">
            {t("↑↓ select · ↩/⇥ insert · esc close")}
            {props.cached && <span data-testid="Slash palette cached"> {t("(cached)")}</span>}
            {props.starting && <span data-testid="Slash palette starting footer"> · {t("Starting session…")}</span>}
          </div>
        </>
      )}
    </div>
  );
}
