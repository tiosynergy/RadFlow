"use client";

/* ===== RadFlow — легка модалка підтвердження =====
   Для деструктивних дій (напр. «Зняти з листа очікування»). A11y: role=dialog,
   фокус-пастка/Esc/повернення фокуса — через useModalA11y. */

import type { ReactNode } from "react";
import { useModalA11y } from "@/lib/useModalA11y";

interface ConfirmDialogProps {
  title: string;
  text: ReactNode;
  confirmLabel?: string;
  /** Напис на кнопці відмови. Для деструктивних дій краще явне «Залишити»/«Ні»,
      ніж «Скасувати» поруч зі «Скасувати запис» (плутанина: що саме скасовуємо). */
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  hideCancel?: boolean; // прибрати нижню кнопку відмови (закрити можна ✕ угорі)
  onConfirm: () => void;
  onClose: () => void;
}

export default function ConfirmDialog({ title, text, confirmLabel = "Підтвердити", cancelLabel = "Скасувати", danger, busy, hideCancel, onConfirm, onClose }: ConfirmDialogProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="overlay">
      <div className="dialog fade-in" ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: 440 }}>
        <div className="dlg-head">
          <div className="dlg-title">{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button>
        </div>
        <div className="dlg-body" style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>{text}</div>
        <div className="dlg-foot" style={hideCancel ? { justifyContent: "center" } : undefined}>
          {!hideCancel && <button className="btn btn-ghost" onClick={onClose}>{cancelLabel}</button>}
          <button className={"btn " + (danger ? "btn-danger" : "btn-primary")} disabled={busy} aria-busy={busy} onClick={onConfirm}>
            {busy ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
