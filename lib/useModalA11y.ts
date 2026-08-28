"use client";

/* ===== useModalA11y =====
   Доступність модальних вікон (WCAG 2.1.2 / 2.4.3):
   - фокус на перший інтерактивний елемент при відкритті;
   - пастка фокуса (Tab/Shift+Tab циклічно в межах діалогу);
   - закриття по Esc;
   - повернення фокуса на елемент-тригер при закритті.

   Використання:
     const dialogRef = useModalA11y<HTMLDivElement>(onClose);
     <div className="overlay">
       <div className="dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label="…">…</div>
     </div>

   active=false — компонент ЗМОНТОВАНИЙ, але свій діалог зараз не малює (напр.
   RescheduleModal при зміні кабінету віддає замість себе форму переоформлення).
   Тоді пастка фокуса й Esc мусять мовчати: інакше у відʼєднаному вузлі немає
   жодного фокусабельного елемента → Tab гаситься preventDefault і нікуди не
   йде (пастка на порожнечу), а Esc закриває все дерево замість верхнього
   вікна. Коли active знову true — ефект переграється й фокус стає в діалог. */

import { useEffect, useRef } from "react";
import { acquireTrap } from "@/lib/modalTrapStack";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalA11y<T extends HTMLElement = HTMLDivElement>(onClose: () => void, active = true) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Елемент-тригер фіксуємо під час ПЕРШОГО рендера — до коміту DOM модалки
  // й автофокуса всередині неї, тож тут ще активний елемент, що відкрив вікно.
  const triggerRef = useRef<HTMLElement | null>(null);
  if (triggerRef.current === null && typeof document !== "undefined") {
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body) triggerRef.current = a;
  }

  /* Повернення фокуса — ОКРЕМИМ ефектом із [] : воно має статись рівно раз, при
     закритті вікна. Якби воно жило в ефекті нижче (deps [active]), то кожна
     деактивація смикала б фокус на кнопку-тригер позаду — дошка прокручувалась би,
     а скрінрідер оголошував би її дорогою в наступне вікно; а при розмонтуванні з
     неактивного стану воно б, навпаки, не спрацювало зовсім. */
  useEffect(() => () => {
    const t = triggerRef.current;
    if (t && t.isConnected && typeof t.focus === "function") t.focus();
  }, []);

  /* Чи вікно ВЖЕ деактивувалось хоч раз. Потрібно, щоб відрізнити перше
     відкриття від повернення після закриття вкладеного вікна (ревʼю с46 р3). */
  const wasDeactivatedRef = useRef(false);

  useEffect(() => {
    if (!active) { wasDeactivatedRef.current = true; return; }
    const node = ref.current;
    /* Пастка береться ТУТ — після раннього виходу по `active`, тож неактивне
       вікно в стек не потрапляє взагалі (с46, U-8). */
    const trap = acquireTrap();

    const focusables = (): HTMLElement[] => {
      if (!node) return [];
      return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
      );
    };

    /* Фокус на перший інтерактивний елемент (або на сам діалог) — але НЕ якщо
       ми ПОВЕРТАЄМОСЬ після вкладеного вікна і фокус уже всередині діалога
       (ревʼю с46 р1 і р3). Ефект тепер переграється не лише при відкритті: коли
       вкладене вікно закривається, `active` вертається в true, і безумовний
       `first.focus()` смикав би фокус у шапку («✕»), а `.dialog` з overflow-y
       прокручувався б наверх — тобто кожне закриття вкладеної форми втрачало б
       місце в кейсі. Дитина в цей момент уже сама повернула фокус на
       кнопку-тригер своїм [] -ефектом.
       ⚠️ `wasDeactivatedRef` тут обовʼязковий: без нього правка мовчки міняла б
       і ПЕРШЕ відкриття. React застосовує `autoFocus` у фазі коміту, тобто ДО
       пасивних ефектів, тож у BookingModal фокус уже стоїть у полі ПІБ — і
       перевірка «фокус усередині» пропустила б початкове наведення на «✕» для
       найчастішого діалога продукту. Це продуктова зміна, а не інженерна, і в
       цей пакет вона не входить (ревʼю р3, F2). */
    const returningFromNested = wasDeactivatedRef.current;
    const focusedInside = !!node && node.contains(document.activeElement);
    const first = focusables()[0];
    if (returningFromNested && focusedInside) {
      // фокус уже де треба — не рухаємо
    } else if (first) {
      first.focus();
    } else if (node) {
      node.setAttribute("tabindex", "-1");
      node.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      // Другий рубіж до active: між зняттям вузла з DOM і прибиранням слухача
      // (порядок ефектів React) діалог уже невидимий, а обробник ще живий.
      if (!node || !node.isConnected) return;
      /* Третій рубіж (с46, U-8): обидва слухачі живуть на document у capture,
         тож stopPropagation між ними не працює — розділяє їх лише стек. Якщо
         поверх нас відкрилось вкладене вікно, мовчимо: інакше Esc закрив би
         разом із ним і нас, викинувши незбережені правки, а Tab перехопився б
         двічі й замкнув фокус на двох елементах. */
      if (!trap.isTop()) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = f[0];
      const lastEl = f[f.length - 1];
      const cur = document.activeElement as HTMLElement | null;   // не плутати з active (проп)
      if (e.shiftKey) {
        if (cur === firstEl || !node.contains(cur)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else if (cur === lastEl || !node.contains(cur)) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      trap.release();
    };
  }, [active]);

  return ref;
}
