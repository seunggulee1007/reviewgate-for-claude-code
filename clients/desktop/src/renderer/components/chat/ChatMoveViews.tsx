/**
 * MARK: wave4b w4b-follow — docs/PROTOCOL.md §39.4 (as the Mac's ChatMoveViews.swift): above the composer, the chat that
 * moved to another worktree ("옮김 → <worktree>", read-only here, [그 창 열기]) or why the last move was refused; the
 * tab badge; and the confirm that stops Claude before a move ("Claude가 작업 중이에요 — 멈추고 옮길까요?").
 */
import { useState, type ReactNode } from "react";
import type { ChatMoveRef } from "@reviewgate/engine";
import { chatMoveNeedsStop, folderName, moveChat, movedChatOf, useChatMoveNotice } from "../../chatMove";
import { sessionsOf } from "../../sessions";
import { useViewing } from "../../viewedChat";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { Modal } from "../Menu";

export function MovedChatBar() {
  // wave4b integration: the chat on screen — one shown read-only (§39.2), else the current one.
  const shownId = useViewing()?.id;
  const moved = useStore((s) => movedChatOf(s.state, shownId ?? sessionsOf(s.state).currentId));
  const notice = useChatMoveNotice((s) => s.text);
  const setNotice = useChatMoveNotice((s) => s.set);
  if (moved) {
    return (
      <div className="banner blue chat-move-bar" role="status" data-testid="Moved chat bar">
        <span className="icon" aria-hidden="true">→</span>
        <span className="text grow">{t("Moved → {0}. This chat continues in that window; here it is read-only.", moved.name)}</span>
        <span className="actions">
          <button type="button" className="small" title={moved.path} onClick={() => void window.rg.openInNewWindow(moved.path)} data-testid="Open moved chat window">
            {t("Open That Window")}
          </button>
        </span>
      </div>
    );
  }
  if (!notice) return null;
  return (
    <div className="banner orange chat-move-bar" role="status" data-testid="Chat move notice">
      <span className="icon" aria-hidden="true">⚠</span>
      <span className="text grow">{notice}</span>
      <span className="actions">
        <button type="button" className="plain small" onClick={() => setNotice(null)} title={t("Dismiss")} aria-label={t("Dismiss")} data-testid="Dismiss chat move notice">
          ✕
        </button>
      </span>
    </div>
  );
}

export function MovedChatBadge({ moved }: { moved: ChatMoveRef }) {
  return (
    <span className="pill blue" title={moved.path} data-testid="Moved chat badge">
      {t("Moved → {0}", moved.name)}
    </span>
  );
}

/** "이 채팅을 거기로 옮기기": asks first while Claude works; `onDone` after the request (or Cancel). */
export function useChatMove(): { start: (path: string) => void; dialog: ReactNode } {
  const needsStop = useStore((s) => chatMoveNeedsStop(s.state));
  const [path, setPath] = useState<string | null>(null);
  const start = (p: string) => {
    if (needsStop) setPath(p);
    else void moveChat(p, false, false);
  };
  const dialog = path ? <ChatMoveConfirm path={path} onClose={() => setPath(null)} /> : null;
  return { start, dialog };
}

function ChatMoveConfirm({ path, onClose }: { path: string; onClose: () => void }) {
  const [continueThere, setContinueThere] = useState(true);
  const [busy, setBusy] = useState(false);
  const name = folderName(path);
  const confirm = () => {
    setBusy(true);
    void moveChat(path, true, continueThere).finally(() => {
      setBusy(false);
      onClose();
    });
  };
  return (
    <Modal title={t("Claude is working — stop it and move the chat?")} onClose={busy ? undefined : onClose} testId="Chat move dialog">
      <div className="message">
        <div>{t("The turn stops here and this chat continues in {0}. The review of this folder stays here.", name)}</div>
        <label className="row-line" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={continueThere} onChange={(e) => setContinueThere(e.target.checked)} data-testid="Chat move continue there" />
          {t("Ask Claude to continue there")}
        </label>
      </div>
      <div className="actions">
        {busy && <span className="spinner" />}
        <span className="spacer" />
        <button type="button" onClick={onClose} disabled={busy} data-testid="Cancel">{t("Cancel")}</button>
        <button type="button" className="primary" autoFocus disabled={busy} onClick={confirm} data-testid="Stop and move">
          {t("Stop and Move")}
        </button>
      </div>
    </Modal>
  );
}
