"use client";

import { useEffect, useRef, useState } from "react";

/* Єдиний тост (UX-аудит v2 · A-1/B-2): доступний live-регіон + семантичний колір.
   - Регіон ЗАВЖДИ у DOM (persistent), aria-live відображає терміновість поточного
     тоста → скрінрідер озвучує підсумок дії (раніше .toast-wrap мовчав).
   - Колір лівого бордера за ТИПОМ події: success=зелений, error=червоний,
     info=синій, warn=помаранч (раніше все, крім error, було зелене — info-повідомлення
     на кшталт «пацієнт відмовився» їхали в success-зелений).
   - Помилки — assertive + role="alert"; решта — polite + role="status". Кнопка «✕» (dismiss).
   - W-12 (с75): регіонів ДВА, і обидва завжди в DOM. Раніше один регіон міняв
     role/aria-live у ту саму мить, коли вставлявся текст, — а браузер має
     знати терміновість регіону ДО зміни, інакше повідомлення могло піти не
     тим каналом або не піти зовсім. Тост малюється в тому регіоні, чий тип.
   Тривалість (3с / 6с для помилок) лишається в notify() кожної дошки. */

export interface ToastData {
  msg: string;
  type?: string; // "success" | "error" | "info" | "warn"
  /** Необовʼязкова дія (напр. soft-undo «Скасувати») — рендериться кнопкою у тості.
      `hotkey` — підказка сполучення (W-11: «Ctrl+Z»), яке дошка обробляє сама. */
  action?: { label: string; onAction: () => void; hotkey?: string };
}

/* W-11 (с75): скільки тост живе ПІСЛЯ того, як курсор/фокус його відпустили,
   якщо таймер дошки за час утримання вже сплив. */
const RELEASE_GRACE_MS = 1000;

const TONE: Record<string, string> = {
  success: "var(--green)",
  error: "var(--red-text)",   // W-4: текст/гліф/кнопка дії — 4.5:1; як смуга 4px — 6.4 на --card
  info: "var(--blue-text)",
  warn: "var(--orange)",
};
const ICON: Record<string, string> = { success: "✓", error: "⚠", info: "ℹ", warn: "⚠" };

const REGION_STYLE = { position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 50, pointerEvents: "none" } as const;

export default function Toast({ toast, onDismiss }: { toast: ToastData | null; onDismiss?: () => void }) {
  /* W-11 (с75): поки курсор або фокус усередині картки, тост не зникає — таймер
     дошки лишається як був (він просто ставить toast = null), а ми тримаємо
     ОСТАННІЙ тост, доки його тримають, і ще RELEASE_GRACE_MS після. Так «↩
     Відмінити» не тікає з-під курсора на 6-й секунді (2.2.1). Дія і ✕ гасять
     одразу — інакше після кліку по кнопці фокус лишався б усередині, і картка
     висіла б із протухлим текстом. */
  const [held, setHeld] = useState(false);
  const [last, setLast] = useState<ToastData | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  /* Звідки прийшов фокус у тост (Tab із дошки): після «↩ Відмінити»/✕ картка
     зникає, і без цього фокус падав би в <body> (ревʼю с75, 2.4.3). */
  const cameFrom = useRef<HTMLElement | null>(null);
  /* Лічильник тостів: два поспіль ОДНАКОВІ повідомлення («Позначено: неявка» для
     двох пацієнтів) не міняють DOM — і ридер мовчить. key={seq} перемонтовує
     картку, тобто робить нову вставку в live-регіон. */
  const seqRef = useRef(0);
  const prevToastRef = useRef<ToastData | null>(null);
  if (toast !== prevToastRef.current) { prevToastRef.current = toast; if (toast) seqRef.current++; }
  useEffect(() => { if (toast) setLast(toast); }, [toast]);
  useEffect(() => () => { if (releaseTimer.current) clearTimeout(releaseTimer.current); }, []);
  /* Страховка від «залипання»: елемент під фокусом у картці міг зникнути разом із
     нею (blur при видаленні вузла браузер не шле) — при кожній зміні тосту
     звіряємо, чи утримання ще справжнє (курсор або фокус усередині). */
  useEffect(() => {
    if (!held) return;
    const c = cardRef.current;
    if (!c || (!c.matches(":hover") && !c.contains(document.activeElement))) setHeld(false);
  }, [toast, held]);
  const hold = () => { if (releaseTimer.current) { clearTimeout(releaseTimer.current); releaseTimer.current = null; } setHeld(true); };
  const release = () => { if (releaseTimer.current) clearTimeout(releaseTimer.current); releaseTimer.current = setTimeout(() => setHeld(false), RELEASE_GRACE_MS); };
  const restoreFocus = () => {
    const c = cardRef.current, from = cameFrom.current;
    if (c && c.contains(document.activeElement) && from && from.isConnected) from.focus();
    cameFrom.current = null;
  };
  const dismiss = () => { restoreFocus(); setLast(null); setHeld(false); onDismiss?.(); };
  const shown = toast ?? (held ? last : null);
  const kind = shown?.type && shown.type in TONE ? shown.type : "success";
  const isError = kind === "error";
  const holdProps = {
    ref: cardRef,
    onMouseEnter: hold, onMouseLeave: release,
    onFocus: (e: React.FocusEvent<HTMLDivElement>) => {
      const from = e.relatedTarget as HTMLElement | null;
      if (from && !e.currentTarget.contains(from)) cameFrom.current = from;
      hold();
    },
    onBlur: (e: React.FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release(); },
  };
  // Обидва регіони persistent (не монтуються/демонтуються разом із тостом) —
  // інакше скрінрідер міг би не озвучити. Одночасно вміст має щонайбільше один.
  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" style={REGION_STYLE}>
        {shown && !isError && <ToastCard key={seqRef.current} toast={shown} kind={kind} onDismiss={onDismiss ? dismiss : undefined} holdProps={holdProps} />}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" style={REGION_STYLE}>
        {shown && isError && <ToastCard key={seqRef.current} toast={shown} kind={kind} onDismiss={onDismiss ? dismiss : undefined} holdProps={holdProps} />}
      </div>
    </>
  );
}

function ToastCard({ toast, kind, onDismiss, holdProps }: { toast: ToastData; kind: string; onDismiss?: () => void; holdProps: React.HTMLAttributes<HTMLDivElement> & { ref: React.RefObject<HTMLDivElement | null> } }) {
  return (
    <div
      {...holdProps}
      style={{
        pointerEvents: "auto", display: "flex", alignItems: "center", gap: 10,
        background: "var(--card)", border: "1px solid var(--border-strong)",
        borderLeft: "4px solid " + TONE[kind], borderRadius: 12, padding: "12px 18px",
        boxShadow: "var(--shadow-pop)", fontSize: "0.84375rem", maxWidth: "min(90vw, 520px)",
      }}
    >
      <span aria-hidden="true" style={{ color: TONE[kind], fontSize: "0.9375rem", lineHeight: 1 }}>{ICON[kind]}</span>
      <span style={{ flex: "1 1 auto", minWidth: 0 }}>{toast.msg}</span>
      {toast.action && (
        <button
          type="button" onClick={() => { toast.action?.onAction(); onDismiss?.(); }}
          aria-keyshortcuts={toast.action.hotkey ? toast.action.hotkey.replace(/Ctrl/i, "Control") : undefined}
          style={{ background: "none", border: "none", color: TONE[kind], cursor: "pointer", fontSize: "0.8125rem", fontWeight: 700, textDecoration: "underline", padding: "2px 4px", flexShrink: 0, whiteSpace: "nowrap" }}
        >
          {toast.action.label}
          {/* aria-hidden: сполучення вже в aria-keyshortcuts — інакше ридер каже його двічі */}
          {toast.action.hotkey && <kbd aria-hidden="true" style={{ marginLeft: 6, font: "inherit", fontWeight: 500, textDecoration: "none", color: "var(--text-muted)" }}>{toast.action.hotkey}</kbd>}
        </button>
      )}
      {onDismiss && (
        <button
          type="button" onClick={onDismiss} aria-label="Закрити повідомлення"
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: "1rem", lineHeight: 1, padding: 2, flexShrink: 0 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
