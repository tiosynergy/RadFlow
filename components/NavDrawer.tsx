"use client";

/* ===== NavDrawer — бічна панель, що на вузьких екранах стає off-canvas шухлядою =====

   WCAG 2.1 AA · 1.4.10 Reflow. Оболонка застосунку — `.app { grid-template-columns:
   240px 1fr }`. На 320px сайдбар з'їдав 240 з 320 — контент дошки не було видно
   взагалі, і сторінка скролилась у ДВА боки. Нижче 480px сайдбар виїжджає за край,
   контент займає всю ширину, а меню відкривається кнопкою «☰».

   Чому Fragment, а не обгортка: `.app` — грід, і будь-який <div> навколо <aside>
   став би грід-елементом замість нього (обхід через `display: contents` ламає
   дерево доступності в частині браузерів). Фрагмент віддає кнопку, скрим і <aside>
   прямими дітьми `.app`; вище 480px кнопка й скрим — `display: none`, тож грід
   бачить рівно два елементи, як і раніше, і десктоп не змінюється ні на піксель.

   Доступність (2.1.2 «без пастки», 2.4.3 «порядок фокуса»):
   - `aria-expanded` / `aria-controls` на кнопці-тригері;
   - при відкритті фокус іде в шухляду, Tab циклічно ходить у її межах;
   - Esc закриває, фокус повертається на «☰»;
   - клік по пункту меню або зміна маршруту закриває шухляду;
   - «☰» лишається видимою й у відкритому стані і працює як перемикач мишею:
     ховати активний тригер не можна (кнопка, що зникає під фокусом, — пастка),
     тому шапка сайдбара резервує під неї місце (`.sb-head` padding). З
     КЛАВІАТУРИ у відкритому стані «☰» недосяжна — вона поза пасткою фокуса;
     закриття з клавіатури — «✕» всередині шухляди або Esc;
   - розширення вікна понад 480px закриває шухляду (інакше пастка фокуса
     залишилась би на десктопі, де кнопки «☰» вже немає);
   - скрим — `aria-hidden`, він лише візуальний; закрити можна і клавіатурою.

   ⚠️ Кнопки-пункти всередині НЕ обгорнуті — закриття ловиться делегуванням
   на contentEditable-безпечному `closest()`, щоб не чіпати кожен пункт у трьох
   сайдбарах (Sidebar, ReferrerSidebar, RadSidebar). Повзунок щільності
   (`.sb-density-box`) свідомо виключено: він міняє налаштування, а не навігує. */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Ширина, нижче якої сайдбар працює як шухляда. Дзеркало `@media (max-width: 480px)`
 *  у styles/prototype/radflow.css — міняти тільки парою. */
export const NAV_DRAWER_MAX = 480;

interface NavDrawerProps {
  children: React.ReactNode;
  /** Підпис для скрінрідера: «Відкрити меню — <label>». */
  label?: string;
}

export default function NavDrawer({ children, label = "навігація" }: NavDrawerProps) {
  const [open, setOpen] = useState(false);
  /* Чи ми взагалі в drawer-режимі. Стартує false і на сервері, і в першому
     клієнтському рендері — інакше розійшлась би гідратація. */
  const [narrow, setNarrow] = useState(false);
  const pathname = usePathname();
  const asideRef = useRef<HTMLElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  /* Повернення фокуса на «☰» робимо ТУТ, а не в оновлювачі setOpen: оновлювач
     має бути чистим (React у StrictMode викликає його двічі — фокус смикався б
     двічі і в dev розходився б із продом). */
  const openRef = useRef(false);
  openRef.current = open;
  const close = useCallback(() => {
    const wasOpen = openRef.current;
    setOpen(false);
    if (wasOpen) {
      const b = btnRef.current;
      if (b && b.isConnected) b.focus();
    }
  }, []);

  // Зміна маршруту — шухляда завжди закривається (інакше після переходу вона
  // лишалась би поверх нової сторінки з активною пасткою фокуса).
  useEffect(() => { setOpen(false); }, [pathname]);

  /* Вихід із drawer-режиму при розширенні вікна: пастка фокуса й скрим не мають
     сенсу там, де сайдбар знову стоїть у гріді.

     ⚠️ Запит — ТОЧНЕ дзеркало CSS (`max-width: 480px`), а не `min-width: 481px`.
     Дробові ширини реальні (зум браузера, масштаб ОС 125/150%): на 480.5px
     обидва запити «max-width:480» і «min-width:481» хибні одночасно — CSS уже
     повернув сайдбар у грід і сховав «☰», а JS ще тримав би пастку фокуса,
     і зняти її не було б чим (2.1.2 «без пастки клавіатури»). */
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${NAV_DRAWER_MAX}px)`);
    const onChange = () => {
      setNarrow(mq.matches);
      if (!mq.matches) setOpen(false);
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => { mq.removeEventListener("change", onChange); };
  }, []);

  // Фокус усередину + пастка + Esc — тільки поки відкрито.
  useEffect(() => {
    if (!open) return;
    const node = asideRef.current;
    if (!node) return;

    const focusables = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
      );

    const first = focusables()[0];
    if (first) first.focus();

    const onKey = (e: KeyboardEvent) => {
      if (!node.isConnected) return;
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) { e.preventDefault(); return; }
      const firstEl = f[0];
      const lastEl = f[f.length - 1];
      const cur = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (cur === firstEl || !node.contains(cur)) { e.preventDefault(); lastEl.focus(); }
      } else if (cur === lastEl || !node.contains(cur)) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); };
  }, [open, close]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="rf-navtoggle"
        aria-label={(open ? "Закрити меню — " : "Відкрити меню — ") + label}
        aria-expanded={open}
        aria-controls="rf-nav"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span aria-hidden="true">☰</span>
      </button>

      <div
        className={"rf-nav-scrim" + (open ? " open" : "")}
        onClick={close}
        aria-hidden="true"
      />

      {/* role/aria-modal — ЛИШЕ у відкритій шухляді: пастка фокуса без
          оголошеного діалогу лишає користувача скрінрідера без меж вікна, а
          вішати роль безумовно не можна — десктопний сайдбар не діалог. */}
      <aside
        id="rf-nav"
        ref={asideRef}
        role={narrow && open ? "dialog" : undefined}
        aria-modal={narrow && open ? true : undefined}
        aria-label={narrow && open ? "Меню — " + label : undefined}
        className={"sidebar" + (open ? " nav-open" : "")}
        onClick={(e) => {
          const t = e.target as HTMLElement | null;
          if (!t) return;
          if (t.closest(".sb-density-box")) return;   // перемикач щільності — не навігація
          if (t.closest("a, .sb-item, .sb-cab, .sb-cab-all, .sb-cab-btn")) close();
        }}
      >
        <button type="button" className="rf-navclose" aria-label="Закрити меню" onClick={close}>
          <span aria-hidden="true">✕</span>
        </button>
        {children}
      </aside>
    </>
  );
}
