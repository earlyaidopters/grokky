import { useRef } from "react";
import { useDialogFocus } from "./use-dialog-focus";

export function ConfirmDialog({ title, detail, confirmLabel, onConfirm, onCancel, busy = false, cancelLabel = "Keep editing" }: {
  title: string; detail: string; confirmLabel: string; onConfirm(): void; onCancel(): void; busy?: boolean; cancelLabel?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, () => { if (!busy) onCancel(); });
  return <div className="confirm-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
    <section ref={ref} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <h2>{title}</h2><p>{detail}</p><footer><button data-dialog-initial-focus type="button" disabled={busy} onClick={onCancel}>{cancelLabel}</button><button className="danger" type="button" disabled={busy} onClick={onConfirm}>{busy ? "Working…" : confirmLabel}</button></footer>
    </section>
  </div>;
}
