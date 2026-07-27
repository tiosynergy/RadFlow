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

  useEffect(() => {
    if (!active) return;
    const node = ref.current;

    const focusables = (): HTMLElement[] => {
      if (!node) return [];
      return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
      );
    };

    // Фокус на перший інтерактивний елемент (або на сам діалог).
    const first = focusables()[0];
    if (first) {
      first.focus();
    } else if (node) {
      node.setAttribute("tabindex", "-1");
      node.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      // Другий рубіж до active: між зняттям вузла з DOM і прибиранням слухача
      // (порядок ефектів React) діалог уже невидимий, а обробник ще живий.
      if (!node || !node.isConnected) return;
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
    return () => { document.removeEventListener("keydown", onKey, true); };
  }, [active]);

  return ref;
}
