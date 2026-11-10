/**
 * "Accept all" summary (docs/AUDIT-2026-09-14.md §1.9): every pending file with +/−, the tools that
 * wrote it, a "sensitive" marker (src/renderer/sensitive.ts) and how many were never opened in the
 * diff pane this turn (`store.viewedPaths`). Confirm → `accept_all`.
 * §31 (wave1 desktop-review): who changed a file comes from its `origin` — a file no tool explains is "앱 밖 변경",
 * never a made-up "Bash".
 * §34 (wave2 desktop-flow): "not viewed" is by content — a file viewed and then changed counts ("본 뒤 바뀜", said apart);
 * while a turn runs, the dialog says that a file the turn changes again comes back as pending.
 */
import { t } from "../../i18n";
import { isExternalChange } from "../../reviewGate";
import { viewStateOf } from "../../reviewRound";
import { pendingFiles, useStore } from "../../store";
import { isSensitivePath } from "../../sensitive";
import { PathText, statusColor } from "../ChangedFiles";
import { ConfirmDialog } from "./ConfirmDialog";
import { acceptAllNow } from "../../acceptAllAction";

export function AcceptAllDialog({ onClose }: { onClose: () => void }) {
  const state = useStore((s) => s.state);
  const viewedPaths = useStore((s) => s.viewedPaths);
  const pending = pendingFiles(state);
  const viewState = (f: (typeof pending)[number]) => viewStateOf(f, viewedPaths);
  const unviewed = pending.filter((f) => viewState(f) === "unviewed").length;
  const changedAfterView = pending.filter((f) => viewState(f) === "changed").length;
  const running = state.gate.phase === "running";
  const sensitive = pending.filter((f) => isSensitivePath(f.path)).length;
  const external = pending.filter((f) => isExternalChange(f)).length;
  return (
    <ConfirmDialog
      title={t("Accept all pending files?")}
      message={
        <div className="col" style={{ gap: 8, alignItems: "stretch" }}>
          <div>{t("{0} file(s) will be marked accepted.", pending.length)}</div>
          <ul className="list accept-all-list" data-testid="Accept all files">
            {pending.map((f) => (
              <li key={f.path} data-testid={`Accept all row ${f.path}`}>
                <div className="file-row">
                  <span className={`glyph ${statusColor(f.status)}`}>{f.status}</span>
                  <div className="grow col" style={{ gap: 2 }}>
                    <div className="path">
                      <PathText path={f.path} />
                      <span className="spacer" />
                      <span className="tiny num green">+{f.added}</span>
                      <span className="tiny num red">−{f.deleted}</span>
                      {viewState(f) === "unviewed" && <span className="tiny muted" title={t("Not opened in the diff pane this turn")}>{t("not viewed")}</span>}
                      {viewState(f) === "changed" && (
                        <span className="tiny blue" title={t("The file changed after you viewed its diff")} data-testid="Changed since viewed">
                          {t("Changed since viewed")}
                        </span>
                      )}
                    </div>
                    <div className="tools">
                      {f.tools.map((tool) => (
                        <span key={tool} className="pill">{tool}</span>
                      ))}
                      {isExternalChange(f) && (
                        <span className="pill gray external" title={t("Not changed by a Claude tool — it may be the IDE, another session or a git pull")} data-testid="External">
                          {t("Outside change")}
                        </span>
                      )}
                      {isSensitivePath(f.path) && <span className="pill orange" data-testid="Sensitive">{t("sensitive")}</span>}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {(unviewed > 0 || changedAfterView > 0 || sensitive > 0 || external > 0) && (
            <div className="orange caption" data-testid="Accept all warning">
              {unviewed > 0 && <div>{t("{0} file(s) not yet viewed.", unviewed)}</div>}
              {changedAfterView > 0 && <div data-testid="Accept all changed since viewed">{t("{0} changed since viewed", changedAfterView)}</div>}
              {sensitive > 0 && <div>{t("{0} sensitive file(s) (Claude settings, MCP config, CLAUDE.md, workflows, env).", sensitive)}</div>}
              {external > 0 && <div>{t("{0} of them changed outside the app (Claude may not have made them).", external)}</div>}
            </div>
          )}
          {running && (
            <div className="caption muted" data-testid="Accept all during turn">
              {t("Claude is still working: a file this turn changes again comes back as pending (Changed after accept).")}
            </div>
          )}
        </div>
      }
      confirmLabel={t("Accept all")}
      onConfirm={() => {
        acceptAllNow(); // MARK: r2-review-flow M28: with the same undo toast
        onClose();
      }}
      onCancel={onClose}
      testId="Accept all dialog"
    />
  );
}
