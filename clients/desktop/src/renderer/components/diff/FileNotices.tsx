/**
 * wave1 desktop-review (docs/PROTOCOL.md §32): under the diff header, what the selected file's review entry says beyond the
 * diff — a mods file ("설정·훅 (Claude 동작 변경)") with its risks, content that was not captured (never revertible),
 * a gitignored file (reviewed, but not committed).
 */
import type { ChangedFileState } from "@reviewgate/engine";
import { t } from "../../i18n";
import { isModsFile, modsRiskHelp, modsRiskLabel, modsRisksOf, uncapturedText } from "../../reviewGate";
import { useStore } from "../../store";
import "../reviewGate.css";

export function FileNotices({ file }: { file: ChangedFileState }) {
  const gate = useStore((s) => s.state.gate);
  const mods = isModsFile(file);
  if (!mods && !file.uncaptured && !file.ignored) return null;
  return (
    <div className="file-notices" data-testid="File notices">
      {mods && (
        <div className="notice red" data-testid="Mods notice">
          <span className="bold">{t("Settings & hooks (changes how Claude works)")}</span>
          {modsRisksOf(file).map((r) => (
            <span key={r} className="pill red" title={modsRiskHelp(r)}>{modsRiskLabel(r)}</span>
          ))}
        </div>
      )}
      {file.uncaptured && (
        <div className="notice orange" data-testid="Uncaptured notice">
          <span aria-hidden="true">⚠</span>
          <span>{uncapturedText(file, gate)}</span>
        </div>
      )}
      {file.ignored && (
        <div className="notice gray" data-testid="Ignored notice">
          <span>{t("gitignored — not committed")}</span>
        </div>
      )}
    </div>
  );
}
