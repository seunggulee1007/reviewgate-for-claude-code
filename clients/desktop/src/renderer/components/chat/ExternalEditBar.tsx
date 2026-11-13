/**
 * MARK: composer parity — docs/PROTOCOL.md §56.3: "Editing in <editor>…" over the composer while the draft is out (Ctrl+G),
 * with Done and Cancel and the same in its context menu. As on the Mac (ComposerExternalEditorBar).
 */
import { t } from "../../i18n";
import type { ExternalEdit } from "../../externalEdit";
import { useAgentContextMenu, type AgentMenuItem } from "../agents/AgentBits";

export function ExternalEditBar({ editing, onDone, onCancel }: { editing: ExternalEdit | null; onDone: () => void; onCancel: () => void }) {
  const items: AgentMenuItem[] = [
    { label: t("Done"), onClick: onDone, testId: "External editor menu done" },
    { label: t("Cancel"), onClick: onCancel, testId: "External editor menu cancel" },
  ];
  const menu = useAgentContextMenu(items);
  if (!editing) return null;
  const line = t("Editing in {0}… — each save comes into the message box", editing.name);
  return (
    <div className="external-edit" role="status" data-testid="External editor" onContextMenu={menu.onContextMenu}>
      <span className="grow truncate" title={line}>{line}</span>
      <button type="button" className="tiny" onClick={onDone} title={t("Stop editing outside — what you saved stays in the message box")} data-testid="External editor done">{t("Done")}</button>
      <button type="button" className="tiny" onClick={onCancel} title={t("Stop editing outside and put back the message as it was before ⌃G")} data-testid="External editor cancel">{t("Cancel")}</button>
      {menu.menu}
    </div>
  );
}
