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
*/

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalA11y<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
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

  useEffect(() => {
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
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const f = focusables();
      if (f.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = f[0];
      const lastEl = f[f.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === firstEl || !node.contains(active)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else if (active === lastEl || !node.contains(active)) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Повертаємо фокус на елемент, що відкрив модалку (якщо він ще в DOM).
      const t = triggerRef.current;
      if (t && t.isConnected && typeof t.focus === "function") t.focus();
    };
  }, []);

  return ref;
}
