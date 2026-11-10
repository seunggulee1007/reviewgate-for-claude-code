/**
 * MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3: the user's Claude Code mods in "Applied extensions" (the Mac's
 * `ModsSection`): name, description, folder and whether this session loaded each — read only. A mod's panes draw only in
 * the terminal, so the section says so and opens the board (§43.1; this dialog closes first).
 */
import type { SessionExtensions } from "@reviewgate/engine";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { modState, modsNote } from "../../codeGraph";
import { revealInFolderLabel } from "../../platformWords";

/** Closes this dialog and opens the agent board (§43.1) — a board already open stays open (its key would close it). */
export function openBoardFromMods(): void {
  const s = useStore.getState();
  s.openDialog(null);
  s.toggleBoard(true);
}

export function ModsSection({ ext }: { ext: SessionExtensions }) {
  const mods = ext.mods ?? [];
  if (mods.length === 0) return null;
  return (
    <section className="ext-section" data-testid="Extensions mods">
      <h4>
        {t("Mods")} <span className="faint num">{mods.length}</span>
      </h4>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <span className="caption muted grow">{modsNote()}</span>
        <button type="button" className="small" onClick={() => openBoardFromMods()} title={t("Open the agent board (⌥⌘B)")} data-testid="Open the board from mods">
          {t("Open the board")}
        </button>
      </div>
      <ul className="ext-plugins">
        {mods.map((m) => (
          <li key={m.path} className={m.loaded ? "" : "off"} data-testid={`Mod ${m.name}`}>
            <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
              <span className="row" style={{ gap: 6 }}>
                <span className="bold truncate">{m.name}</span>
                {m.version && <span className="tiny faint">v{m.version}</span>}
                <span className={`pill ${m.loaded ? "green" : "gray"}`}>{modState(m)}</span>
              </span>
              {m.description && <span className="caption muted">{m.description}</span>}
              <span className="mono tiny faint truncate" title={m.path}>{m.path}</span>
            </div>
            <button type="button" className="plain small" onClick={() => void window.rg.showItemInFolder(m.path)} aria-label={revealInFolderLabel(window.rg?.platform ?? "")} title={revealInFolderLabel(window.rg?.platform ?? "")}>
              📁
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
