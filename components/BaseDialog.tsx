"use client";

/* ===== RadFlow — каркас довільної модалки (WCAG W-9, с75) =====
   Оверлей + .dialog + шапка з заголовком і ✕, а всередині — будь-який вміст
   (.dlg-body / .dlg-foot лишаються за викликачем). A11y — той самий контракт,
   що в ConfirmDialog: role="dialog", aria-modal, aria-labelledby на заголовок,
   пастка фокуса / Esc / повернення фокуса через useModalA11y.

   Навіщо окремий каркас, а не ConfirmDialog: у чотирьох вікнах (пароль
   співробітника/CEO, «Незбережені зміни» майстра, видалення центру) є власні
   поля й по три кнопки, і кожне з них до с75 малювало оверлей руками — без
   ролі, пастки й Esc, а фокус після закриття губився в <body>.

   `busy` — дія в польоті: клік по оверлею, ✕ і Esc не закривають вікно, доки
   вона не завершиться (кнопки всередині вимикає сам викликач).

   Початковий фокус (ревʼю с75): хук ставить його на перший фокусабельний
   елемент — це ✕ у шапці, і він перебиває `autoFocus` поля (React застосовує
   autoFocus у фазі коміту, ефект хука — після). До с75 ці вікна відкривались
   одразу в полі («Задати пароль» → набрав → Enter), тож каркас після хука
   переводить фокус у ПЕРШЕ поле вмісту, якщо воно є (APG Dialog: «if the
   dialog contains a form, focus the first input»); без полів лишається ✕. */

import { useEffect, useId, type CSSProperties, type ReactNode } from "react";
import { useModalA11y } from "@/lib/useModalA11y";

interface BaseDialogProps {
  title: ReactNode;
  onClose: () => void;
  busy?: boolean;
  maxWidth?: number;
  style?: CSSProperties;
  children: ReactNode;
}

export default function BaseDialog({ title, onClose, busy = false, maxWidth, style, children }: BaseDialogProps) {
  const titleId = useId();
  const dialogRef = useModalA11y<HTMLDivElement>(() => { if (!busy) onClose(); });
  // Оголошено ПІСЛЯ хука: ефекти одного компонента йдуть у порядку оголошення,
  // тож цей виконується останнім і його вибір фокуса — остаточний.
  useEffect(() => {
    const field = dialogRef.current?.querySelector<HTMLElement>("input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])");
    if (field) field.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- лише при відкритті
  }, []);
  return (
    <div className="overlay" onClick={() => { if (!busy) onClose(); }}>
      <div className="dialog fade-in" style={{ ...(maxWidth ? { maxWidth } : {}), ...style }} ref={dialogRef}
        role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined}
        onClick={(e) => e.stopPropagation()}>
        <div className="dlg-head">
          <div className="dlg-title" id={titleId}>{title}</div>
          <button className="icon-btn" aria-label="Закрити" onClick={onClose} disabled={busy}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
