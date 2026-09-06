import type { ReactNode } from 'react';
import { ErrorBox } from '../components/ui';
import { Dialog } from '../turfs/Dialog';

interface Props {
  title: string;
  titleId: string;
  confirmLabel: string;
  busyLabel: string;
  /** Irreversible actions get the outline-danger treatment AND say so in words above. */
  danger?: boolean;
  busy: boolean;
  error?: unknown;
  errorTitle: string;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}

/** Shared shape for "start the drip" and "cancel the send" — both consequential, neither a form. */
export function ConfirmDialog({
  title,
  titleId,
  confirmLabel,
  busyLabel,
  danger,
  busy,
  error,
  errorTitle,
  onConfirm,
  onClose,
  children,
}: Props) {
  return (
    <Dialog
      title={title}
      titleId={titleId}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Back
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn--danger-outline' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      }
    >
      <div className="modal__body stack">
        {children}
        {error !== undefined && error !== null && <ErrorBox title={errorTitle} error={error} compact />}
      </div>
    </Dialog>
  );
}
