"use client";

/* Єдиний тост (UX-аудит v2 · A-1/B-2): доступний live-регіон + семантичний колір.
   - Регіон ЗАВЖДИ у DOM (persistent), aria-live відображає терміновість поточного
     тоста → скрінрідер озвучує підсумок дії (раніше .toast-wrap мовчав).
   - Колір лівого бордера за ТИПОМ події: success=зелений, error=червоний,
     info=синій, warn=помаранч (раніше все, крім error, було зелене — info-повідомлення
     на кшталт «пацієнт відмовився» їхали в success-зелений).
   - Помилки — assertive + role="alert"; решта — polite + role="status". Кнопка «✕» (dismiss).
   Тривалість (3с / 6с для помилок) лишається в notify() кожної дошки. */

export interface ToastData {
  msg: string;
  type?: string; // "success" | "error" | "info" | "warn"
  /** Необовʼязкова дія (напр. soft-undo «Скасувати») — рендериться кнопкою у тості. */
  action?: { label: string; onAction: () => void };
}

const TONE: Record<string, string> = {
  success: "var(--green)",
  error: "var(--red)",
  info: "#4da3ff",
  warn: "var(--orange)",
};
const ICON: Record<string, string> = { success: "✓", error: "⚠", info: "ℹ", warn: "⚠" };

export default function Toast({ toast, onDismiss }: { toast: ToastData | null; onDismiss?: () => void }) {
  const kind = toast?.type && toast.type in TONE ? toast.type : "success";
  const isError = kind === "error";
  return (
    <div
      // Регіон persistent (не монтується/демонтується разом із тостом) — інакше
      // скрінрідер міг би не озвучити. aria-live відображає терміновість поточного тоста.
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 50, pointerEvents: "none" }}
    >
      {toast && (
        <div
          style={{
            pointerEvents: "auto", display: "flex", alignItems: "center", gap: 10,
            background: "var(--card)", border: "1px solid var(--border-strong)",
            borderLeft: "4px solid " + TONE[kind], borderRadius: 12, padding: "12px 18px",
            boxShadow: "var(--shadow-pop)", fontSize: 13.5, maxWidth: "min(90vw, 520px)",
          }}
        >
          <span aria-hidden="true" style={{ color: TONE[kind], fontSize: 15, lineHeight: 1 }}>{ICON[kind]}</span>
          <span style={{ flex: "1 1 auto", minWidth: 0 }}>{toast.msg}</span>
          {toast.action && (
            <button
              type="button" onClick={() => { toast.action?.onAction(); onDismiss?.(); }}
              style={{ background: "none", border: "none", color: TONE[kind], cursor: "pointer", fontSize: 13, fontWeight: 700, textDecoration: "underline", padding: "2px 4px", flexShrink: 0, whiteSpace: "nowrap" }}
            >
              {toast.action.label}
            </button>
          )}
          {onDismiss && (
            <button
              type="button" onClick={onDismiss} aria-label="Закрити повідомлення"
              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 2, flexShrink: 0 }}
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  );
}
