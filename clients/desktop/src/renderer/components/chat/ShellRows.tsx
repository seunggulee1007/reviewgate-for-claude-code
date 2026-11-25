/**
 * MARK: shell-mode — docs/PROTOCOL.md §67.3: the `!` command in the chat. While it runs, a live row at the end of the chat
 * (`$ command`, a spinner, the elapsed time, the output so far from `shell_output`, 중지); once it ended, its row
 * (`kind: "shell"`, restored with the chat): the command, how it ended (✓ 0 · ✗ 종료 코드 n · 중지됨 · 시간 초과), how long it
 * took, the output folded to its last lines with 전체 보기, "앞부분은 잘렸어요" when the engine cut its start, the files it
 * changed (names in the tooltip) and a context menu (명령 복사 · 출력 복사). The words are src/renderer/shellMode.ts's.
 */
import { useEffect, useState } from "react";
import type { ShellResult } from "@reviewgate/engine";
import { useNow } from "../../agents";
import { formatElapsed } from "../../elapsed";
import { t } from "../../i18n";
import { cancelShellCommand, foldShellOutput, shellEnd, shellFilesLine, shellRanInTitle, useShellLive } from "../../shellMode";
import { useStore } from "../../store";
import { showToast } from "../../toast";
import { useAgentContextMenu, type AgentMenuItem } from "../agents/AgentBits";
import { copyWithToast } from "../common/CopyButton";
import "./shell.css";

/** The running command, at the end of the chat; `onGrow` keeps the view at the bottom while its output comes in. */
export function ShellRunningRow({ onGrow }: { onGrow?: () => void }) {
  const shell = useStore((s) => s.state.session.shell ?? null);
  const live = useShellLive();
  const now = useNow(shell !== null, 1000);
  const output = shell && live.id === shell.id ? live.output : "";
  useEffect(() => onGrow?.(), [onGrow, output, shell?.id]);
  if (!shell) return null;
  const started = Date.parse(shell.startedAt);
  const elapsed = Number.isFinite(started) ? formatElapsed(Math.max(0, now - started) / 1000) : "";
  const stop = () => void cancelShellCommand().then((why) => why && showToast(why));
  return (
    <div className="shell-row running" data-testid="Shell running row">
      <div className="shell-head">
        <span className="spinner" aria-hidden="true" />
        <span className="shell-cmd mono truncate" title={shellRanInTitle(shell.command, shell.cwd)}>$ {shell.command}</span>
        <span className="shell-time tiny faint num" title={t("Running for {0}", elapsed)}>{elapsed}</span>
        <button type="button" className="small" onClick={stop} title={t("Stop the shell command (esc)")} aria-label={t("Stop the shell command")} data-testid="Stop shell row">
          <span aria-hidden="true">■</span> {t("Stop")}
        </button>
      </div>
      {output.length > 0 && <pre className="shell-output mono">{foldShellOutput(output).text}</pre>}
    </div>
  );
}

/** Right-click on a finished row: the command, the output. */
export function shellCopyItems(r: Pick<ShellResult, "command" | "output">): AgentMenuItem[] {
  return [
    { label: t("Copy command"), onClick: () => void copyWithToast(r.command), testId: "Copy shell command" },
    { label: t("Copy output"), onClick: () => void copyWithToast(r.output), disabled: r.output.length === 0 ? t("No output") : null, testId: "Copy shell output" },
  ];
}

/** A finished `!` command (live `shell_result` and restored rows alike). */
export function ShellRow({ result }: { result: ShellResult }) {
  const [all, setAll] = useState(false);
  const menu = useAgentContextMenu(shellCopyItems(result));
  const end = shellEnd(result);
  const folded = foldShellOutput(result.output);
  const files = shellFilesLine(result);
  const output = result.output.replace(/\s+$/, "");
  return (
    <div className={`shell-row ${end.tone}`} data-testid="Shell row" onContextMenu={menu.onContextMenu}>
      <div className="shell-head">
        <span className="shell-cmd mono truncate" title={shellRanInTitle(result.command, result.cwd)}>$ {result.command}</span>
        <span className={`shell-end ${end.tone}`} data-testid="Shell end">{end.text}</span>
        <span className="shell-time tiny faint num" title={t("Took {0}", formatElapsed(result.durationMs / 1000))}>{formatElapsed(result.durationMs / 1000)}</span>
      </div>
      {output.length === 0 ? (
        <div className="tiny faint">{t("(no output)")}</div>
      ) : (
        <>
          {result.truncated && <div className="tiny faint" data-testid="Shell output cut">{t("The start of the output was cut")}</div>}
          {folded.hidden > 0 && !all && (
            <button type="button" className="plain tiny shell-more" onClick={() => setAll(true)} title={t("Show the {0} lines above", folded.hidden)} data-testid="Shell show all">
              {t("Show all")}
            </button>
          )}
          <pre className="shell-output mono" data-testid="Shell output">{all ? output : folded.text}</pre>
          {folded.hidden > 0 && all && (
            <button type="button" className="plain tiny shell-more" onClick={() => setAll(false)} title={t("Show only the last lines")} data-testid="Shell collapse">
              {t("Collapse")}
            </button>
          )}
        </>
      )}
      {files && (
        <div className="shell-files caption" title={files.title} data-testid="Shell files">
          {files.text}
        </div>
      )}
      {menu.menu}
    </div>
  );
}
