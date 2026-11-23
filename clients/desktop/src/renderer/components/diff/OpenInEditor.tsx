/**
 * "Open in Editor" split button (the Mac app's `ExternalEditor` menu): the preferred editor from
 * settings is the primary action; the menu lists VS Code / IntelliJ IDEA / the file manager. A pick
 * from the menu is remembered as `preferredEditor`.
 */
import { useEffect, useState } from "react";
import type { EditorKind } from "../../../shared/ipc";
import { t } from "../../i18n";
import { revealInFolderLabel } from "../../platformWords"; // MARK: wave4d w4d-windows
import { useStore } from "../../store";
import { Menu, type MenuItem } from "../Menu";
import { IDE_CHOICES, ideTitle, openInIde } from "../../nav/openInIde"; // §62

export function editorTitle(kind: EditorKind): string {
  switch (kind) {
    case "vscode":
      return "VS Code";
    case "idea":
      return "IntelliJ IDEA";
    case "explorer":
      return revealInFolderLabel(window.rg.platform); // MARK: wave4d w4d-windows (polish-07)
    default:
      return t("Open in Editor");
  }
}

const CHOICES: EditorKind[] = ["vscode", "idea", "explorer"];

export function OpenInEditor(props: {
  absolutePath: string;
  line: number | null;
  disabled?: boolean;
  /** §62: the file's repo-relative path and line for "Open in IDE" (the menu then lists the IDEs; the checked one is Settings' "Open in"). */
  ide?: { path: string; line: number; column?: number };
}) {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const [preferred, setPreferred] = useState<EditorKind>(settings?.preferredEditor ?? "auto");

  useEffect(() => {
    if (settings) {
      setPreferred(settings.preferredEditor);
      return;
    }
    let live = true;
    window.rg
      .getSettings()
      .then((s) => live && setPreferred(s.preferredEditor))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [settings]);

  const open = (kind: EditorKind, remember: boolean) => {
    void window.rg.openInEditor(props.absolutePath, props.line, kind).then((used) => {
      if (remember && used && CHOICES.includes(used as EditorKind)) void saveSettings({ preferredEditor: used as EditorKind });
    });
  };

  // §62: Open in IDE through its URL scheme (vscode:// / idea://) or the system's app; a pick is remembered as "Open in".
  const ideChoice = settings?.openInIde ?? "vscode";
  const ide = props.ide;
  const ideItems: MenuItem[] = ide
    ? [
        { kind: "sep" },
        { kind: "head", label: `${t("Open in IDE")} (Ctrl+Alt+O)` },
        ...IDE_CHOICES.map((kind) => ({
          kind: "item" as const,
          label: ideTitle(kind),
          checked: ideChoice === kind,
          disabled: props.disabled,
          title: t("Open in {0} at this line — Ctrl+Alt+O opens there from now on", ideTitle(kind)),
          onClick: () => {
            if (kind !== ideChoice) void saveSettings({ openInIde: kind });
            void openInIde(ide.path, ide.line, ide.column ?? 1, kind);
          },
          testId: `Open in IDE ${kind}`,
        })),
      ]
    : [];

  return (
    <span className="split-button" title={t("Open in Editor")}>
      <button type="button" className="small" disabled={props.disabled} onClick={() => open(preferred, false)} data-testid="Open in Editor">
        ↗ {editorTitle(preferred)}
      </button>
      <Menu
        label=""
        align="right"
        testId="Open in Editor menu"
        items={[
          ...CHOICES.map((kind) => ({
            kind: "item" as const,
            label: editorTitle(kind),
            checked: preferred === kind,
            disabled: props.disabled,
            onClick: () => open(kind, true),
            testId: `Open in ${kind}`,
          })),
          ...ideItems,
        ]}
      />
    </span>
  );
}
