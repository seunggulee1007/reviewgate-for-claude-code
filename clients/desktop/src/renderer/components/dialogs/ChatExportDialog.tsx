/**
 * docs/PROTOCOL.md §70.3: `/export` alone — the conversation as plain text (its start and size), Copy to Clipboard (the
 * default) or Save to File… (main's save dialog asks before replacing). As on the Mac (App ComposerExport.swift).
 */
import { useState } from "react";
import { t } from "../../i18n";
import { copyExport, exportSize, saveExport, type ChatExport } from "../../chatExport";
import { showToast } from "../../toast";
import { Modal } from "../Menu";

const PREVIEW_CHARS = 6000;

export function ChatExportDialog({ export: exp, onClose }: { export: ChatExport; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = exp.text.length > PREVIEW_CHARS ? `${exp.text.slice(0, PREVIEW_CHARS)}\n…` : exp.text;
  const copy = () => {
    void copyExport(exp).then((r) => {
      showToast(r.notice);
      onClose();
    });
  };
  const save = () => {
    setBusy(true);
    void saveExport(exp).then((r) => {
      setBusy(false);
      if (r === null) return; // the save dialog was cancelled
      if (!r.ok) {
        setError(r.notice);
        return;
      }
      showToast(r.notice);
      onClose();
    });
  };
  return (
    <Modal title={t("Export Conversation")} onClose={busy ? undefined : onClose} testId="Chat export dialog">
      <div className="caption muted">{t("The conversation as plain text, as the terminal's /export writes it")}</div>
      <pre className="chat-export-preview" data-testid="Chat export preview">{preview}</pre>
      <div className="caption muted">{exportSize(exp.text)}</div>
      {error !== null && <div className="caption warn" role="alert">{error}</div>}
      <div className="actions">
        <button type="button" onClick={onClose} disabled={busy} title={busy ? t("Saving…") : undefined}>{t("Cancel")}</button>
        <button type="button" onClick={save} disabled={busy} title={busy ? t("Saving…") : t("Choose where to save the conversation as a text file")} data-testid="Chat export save">
          {t("Save to File…")}
        </button>
        <button type="button" className="primary" onClick={copy} disabled={busy} title={busy ? t("Saving…") : t("Puts the whole conversation on the clipboard as plain text")} data-testid="Chat export copy" autoFocus>
          {t("Copy to Clipboard")}
        </button>
      </div>
    </Modal>
  );
}
