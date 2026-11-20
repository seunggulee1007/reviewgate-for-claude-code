/**
 * §57.10 (plan §4.5): Settings › Terminal — "Terminal chat (preview)" (off by default; disabled with the reason when this
 * window cannot run a PTY), and while it is on: what new chats open as, the terminal's GPU renderer, full repaint and
 * font size. The bottom panel's default shell shows whenever the panel can open (it needs no preview).
 */
import type { AppSettings } from "../../../shared/ipc";
import { t } from "../../i18n";
import { usePtyInfo } from "../../terminal/ptyInfo";
import { clampFontSize, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from "../../terminal/termHostOptions";

export function TerminalSettingsSection({ settings, patch }: { settings: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  const info = usePtyInfo((s) => s.info);
  const available = info?.available === true;
  const shells = info?.shells ?? [];
  const preview = settings.terminalChatPreview === true && available;
  const unavailable = info === null ? t("Checking whether terminals can run here…") : info.reason ? t("Not available here: {0}", t(info.reason)) : t("Terminals are not available here");
  return (
    <section data-testid="Terminal settings">
      <h4>{t("Terminal")}</h4>
      <label className="check" title={available ? undefined : unavailable}>
        <input
          type="checkbox"
          checked={preview}
          disabled={!available}
          onChange={(e) => patch({ terminalChatPreview: e.target.checked })}
          data-testid="Terminal chat preview"
        />
        {t("Terminal chat (preview)")}
      </label>
      <div className="note">
        {t(
          "Claude Code itself runs in the chat column of a terminal chat — every key, command and dialog of the terminal works, and ReviewGate reviews each turn. A preview: it has not been verified on a real Windows machine yet, so Korean input, keys or drawing may misbehave. Off: no new terminal chats; the ones you have keep working.",
        )}
      </div>
      {!available && (
        <div className="note orange" role="status" data-testid="Terminal chat unavailable">
          {unavailable}
        </div>
      )}
      {preview && (
        <>
          <div className="field-row">
            <span>{t("New chats open as")}</span>
            <select
              value={settings.newChatKind === "terminal" ? "terminal" : "chat"}
              onChange={(e) => patch({ newChatKind: e.target.value === "terminal" ? "terminal" : "chat" })}
              title={t(
                "Terminal: Claude Code itself runs in the chat column — every command, key and dialog of the terminal works, and ReviewGate reviews each turn. Chat: ReviewGate's own chat UI with cards, the queue and flows that send for you.",
              )}
              aria-label={t("New chats open as")}
              data-testid="New chats open as"
            >
              <option value="chat">{t("Chat")}</option>
              <option value="terminal">{t("Terminal")}</option>
            </select>
          </div>
          <div className="note">
            {t(
              "For Ctrl+T, the + of the chat tabs and a project's first chat. Both kinds stay in the Chat menu: New Terminal Chat (Ctrl+Alt+T) and New Chat (Classic) (Ctrl+Alt+Shift+T). Chats you already have keep their kind.",
            )}
          </div>
          <div className="field-row">
            <span>{t("Terminal GPU acceleration")}</span>
            <select value={settings.terminalGpu === "off" ? "off" : "auto"} onChange={(e) => patch({ terminalGpu: e.target.value === "off" ? "off" : "auto" })} aria-label={t("Terminal GPU acceleration")} data-testid="Terminal GPU">
              <option value="auto">{t("Auto")}</option>
              <option value="off">{t("Off")}</option>
            </select>
          </div>
          <div className="note">{t("Auto draws the terminal with WebGL and falls back by itself where the graphics card cannot (virtual machines, Remote Desktop). Off always uses the slower DOM renderer.")}</div>
          <label className="check">
            <input type="checkbox" checked={settings.terminalFullRepaint !== false} onChange={(e) => patch({ terminalFullRepaint: e.target.checked })} data-testid="Terminal full repaint" />
            {t("Repaint the whole screen each frame (recommended on Windows)")}
          </label>
          <div className="note">{t("Claude Code redraws its whole screen instead of only what changed — no stale or doubled lines in Windows' console. Takes effect when Claude Code restarts.")}</div>
          <div className="field-row">
            <span>{t("Font size")}</span>
            <input
              type="number"
              min={TERMINAL_FONT_MIN}
              max={TERMINAL_FONT_MAX}
              value={clampFontSize(settings.terminalFontSize)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= TERMINAL_FONT_MIN && n <= TERMINAL_FONT_MAX) patch({ terminalFontSize: Math.round(n) });
              }}
              aria-label={t("Terminal font size")}
              title={t("{0}–{1} pt; Ctrl+= / Ctrl+- / Ctrl+0 in a terminal change it too", TERMINAL_FONT_MIN, TERMINAL_FONT_MAX)}
              data-testid="Terminal font size"
            />
          </div>
        </>
      )}
      {shells.length > 0 && (
        <>
          <div className="field-row">
            <span>{t("Default shell")}</span>
            <select value={settings.terminalShell === "cmd" ? "cmd" : "powershell"} onChange={(e) => patch({ terminalShell: e.target.value === "cmd" ? "cmd" : "powershell" })} aria-label={t("Default shell")} data-testid="Default shell">
              {shells.includes("powershell") && <option value="powershell">{t("PowerShell")}</option>}
              {shells.includes("cmd") && <option value="cmd">{t("Command Prompt")}</option>}
            </select>
          </div>
          <div className="note">{t("What the terminal panel at the bottom of the window opens (Ctrl+`). It needs no preview and runs in the project's folder.")}</div>
        </>
      )}
    </section>
  );
}
