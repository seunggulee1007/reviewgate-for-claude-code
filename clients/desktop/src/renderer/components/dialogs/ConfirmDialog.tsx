/** Generic confirm (the Mac app's `.alert`): title, message, one primary/destructive action and Cancel. */
import type { ReactNode } from "react";
import { t } from "../../i18n";
import { Modal } from "../Menu";
import "./dialogs.css";

export function ConfirmDialog(props: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  return (
    <Modal title={props.title} onClose={props.busy ? undefined : props.onCancel} testId={props.testId ?? "Confirm dialog"}>
      <div className="message">{props.message}</div>
      <div className="actions">
        {props.busy && <span className="spinner" />}
        <span className="spacer" />
        <button type="button" onClick={props.onCancel} disabled={props.busy} data-testid="Cancel">{props.cancelLabel ?? t("Cancel")}</button>
        <button
          type="button"
          className={props.danger ? "danger" : "primary"}
          autoFocus
          disabled={props.busy}
          onClick={props.onConfirm}
          data-testid={props.confirmLabel}
        >
          {props.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
