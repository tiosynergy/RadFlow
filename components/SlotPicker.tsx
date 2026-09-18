"use client";

/* ===== RadFlow — вибір слота (крок 5 хв) =====
   Сітка: у рядку 4 півгодинні слоти, кожен поділено на 6 частин по 5 хв
   (4×6 = 24 міні-слоти на рядок = 2 год). Рядків стільки, щоб покрити графік
   роботи кабінету. Дослідження будь-якої тривалості (більше/менше за 30 хв)
   фарбує свої 5-хв слоти.

   БУФЕР ВИДНО ОКРЕМО (2026-07-11). Зайнятість кабінету = тривалість + буфер, але
   раніше і те, і те малювалось однаковим червоним: не було видно, коли САМЕ
   дослідження закінчується, а коли йде прибирання/переукладка. Тепер:
     busy    → суцільний червоний — триває саме дослідження;
     buffer  → червона штриховка   — буфер після чужого запису (кабінет ще зайнятий);
     plan    → зелені межі         — початок і кінець ПЛАНОВАНОГО дослідження;
     planbuf → зелена штриховка    — буфер планованого дослідження (коли кабінет звільниться).

   Решта станів:
     blocked  → .busy  (кабінет на ремонті/ТО);
     break    → .brk   (сіра штриховка — перерва в роботі кабінету);
     tight    → .tight (помаранчевий — не вміщується: запис / кінець графіка / перерва);
     offsched → .offsched (0077 — ПОЗА ГРАФІКОМ: після закриття або в перерву).
                Слот КЛІКАБЕЛЬНИЙ, але вибір веде до діалогу підтвердження —
                тому це «вільний» стан (freeStates), а не .taken;
     past, offhours, closed → .taken (приглушено).
   Кожна модалка передає власний stateOf() — валідація не змінюється.

   W-5 (с75, WCAG 4.1.2 / 2.5.8). Сітка — справжній listbox: блок = role="group"
   з назвою «08:30», пʼятихвилинки = role="option" + aria-selected; у порядку
   Tab лише ОДНА комірка (обрана, інакше перша вільна) — roving tabindex, решта
   стрілками: ←/→ сусідня доступна комірка, ↑/↓ ±30 хв, Home/End. Раніше до
   «Зберегти» було ~144 табстопи, а ридер чув «список» без опцій. Розмір комірок
   ≥24px — у CSS (.slot-grid4: 2 блоки в рядку). */

import { useRef, useState } from "react";
import { groupSlots, slotFmt, slotToMin } from "@/lib/slots";

export type SlotStateFn = (slot: string) => string;
export type SlotTitleFn = (slot: string, state: string) => string;

interface Props {
  slots: string[];                 // 5-хв слоти графіка кабінету
  stateOf: SlotStateFn;            // стан слота (логіка модалки)
  value: string;                   // обраний "HH:MM"
  onChange: (slot: string) => void;
  titleOf?: SlotTitleFn;
  freeStates?: string[];           // стани, що вважаються вільними (default ["free"])
  spanMin?: number;                // тривалість планованого дослідження (хв) — для зелених меж
  bufferMin?: number;              // буфер після дослідження — малюємо зеленою штриховкою
  resetKey?: string;               // (не використовується — лишено для сумісності пропсів)
}

export default function SlotPicker({ slots, stateOf, value, onChange, titleOf, freeStates = ["free"], spanMin = 0, bufferMin = 0 }: Props) {
  /* Підказка зайнятого слота по ТАПу (планшет/тач). На тачі немає hover → стан
     зайнятої п'ятихвилинки (інтервал, ПІБ, статус) жив лише в title=/aria-label
     і був недосяжний. Тап по зайнятому слоту показує той самий текст видимим
     рядком під сіткою; вибір вільних слотів це не змінює. */
  const [hint, setHint] = useState<{ slot: string; text: string } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  if (!slots.length) return null;
  const isFree = (st: string) => freeStates.includes(st);
  const blocks = groupSlots(slots); // 30-хв блоки в межах графіка

  /* Roving tabindex: у Tab-порядку одна комірка — обрана (якщо вона фокусабельна),
     інакше перша вільна, інакше перша фокусабельна (зайнята з підказкою). */
  const focusable = (s: string) => { const st = stateOf(s); return isFree(st) || (!!titleOf && titleOf(s, st) !== s); };
  const allSubs = blocks.flatMap((bl) => Array.from({ length: 6 }, (_, i) => slotFmt(bl.startMin + i * 5)));
  const tabStop = (value && allSubs.includes(value) && focusable(value)) ? value
    : allSubs.find((s) => isFree(stateOf(s))) ?? allSubs.find(focusable) ?? "";

  function onGridKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const list = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("button.slot:not([disabled])") ?? []);
    if (!list.length) return;
    const cur = document.activeElement as HTMLButtonElement | null;
    const i = Math.max(0, list.findIndex((b) => b === cur));
    const minOf = (b: HTMLButtonElement) => slotToMin(b.dataset.slot || "00:00");
    let n = i;
    if (e.key === "ArrowRight") n = Math.min(list.length - 1, i + 1);
    else if (e.key === "ArrowLeft") n = Math.max(0, i - 1);
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = list.length - 1;
    else if (e.key === "ArrowDown") { const t = minOf(list[i]) + 30; const j = list.findIndex((b) => minOf(b) >= t); n = j < 0 ? list.length - 1 : j; }
    else if (e.key === "ArrowUp") { const t = minOf(list[i]) - 30; let j = -1; list.forEach((b, k) => { if (minOf(b) <= t) j = k; }); n = j < 0 ? 0 : j; }
    e.preventDefault();
    list[n]?.focus();
    list[n]?.scrollIntoView({ block: "nearest" });
  }

  // Зелені межі планованого дослідження: перша (початок) і остання (кінець) 5-хв частини.
  const planStart = value || "";
  const startMin = value ? slotToMin(value) : 0;
  const planEnd = value && spanMin > 0 ? slotFmt(startMin + Math.max(0, spanMin - 5)) : planStart;
  // Буфер планованого дослідження: [start+dur, start+dur+buffer) — кабінет ще зайнятий прибиранням.
  const bufFrom = startMin + spanMin;
  const bufTo = bufFrom + Math.max(0, bufferMin);

  return (
    <div className="slot-picker">
    <div className="slot-grid4" role="listbox" aria-label="Вільні слоти (крок 5 хв). Стрілки — між комірками, ↑↓ — на 30 хв" ref={gridRef} onKeyDown={onGridKey}>
      {blocks.map((bl) => {
        // 6 рівних частин по 5 хв від початку 30-хв блоку.
        const subs = Array.from({ length: 6 }, (_, i) => slotFmt(bl.startMin + i * 5));
        return (
          <div className="slot-blk" key={bl.key} role="group" aria-label={slotFmt(bl.startMin)}>
            <span className="slot-blk-lab" aria-hidden="true">{slotFmt(bl.startMin)}</span>
            <div className="slot-blk-cells" role="presentation">
              {subs.map((s) => {
                const st = stateOf(s);
                const free = isFree(st);
                const m = slotToMin(s);
                const plan = !!value && (s === planStart || s === planEnd);
                const planBuf = !!value && bufferMin > 0 && m >= bufFrom && m < bufTo;
                const label = titleOf ? titleOf(s, st) : s;
                // Зайнятий слот показуємо ПІДКАЗКУ (не disabled — інакше тап на тачі
                // не спрацьовує); aria-disabled лишає його «недоступним» для вибору.
                const showHint = !free && !!titleOf && label !== s;
                return (
                  <button key={s} type="button"
                    className={"slot"
                      + (value === s ? " sel" : "")
                      + (plan ? " plan" : "")
                      + (!plan && planBuf ? " planbuf" : "")
                      + (!free ? " taken" : "")
                      + (hint?.slot === s ? " hinted" : "")
                      + (st === "tight" ? " tight" : "")
                      + (st === "casebusy" ? " casebusy" : "")
                      + (st === "offsched" ? " offsched" : "")
                      + (st === "break" ? " brk" : "")
                      + (st === "buffer" ? " busybuf" : "")
                      + ((st === "busy" || st === "blocked") ? " busy" : "")}
                    disabled={!free && !showHint}
                    role="option" aria-selected={value === s} tabIndex={s === tabStop ? 0 : -1} data-slot={s}
                    aria-disabled={!free}
                    onClick={() => { if (free) { setHint(null); onChange(s); } else if (showHint) { setHint((h) => (h?.slot === s ? null : { slot: s, text: label })); } }}
                    title={label}
                    /* Стан слота (зайнято/перерва/буфер + інтервал) має бути в
                       ДОСТУПНОМУ імені, а не лише у title= (на тачі тултипа немає,
                       і скрінрідер title не завжди озвучує). */
                    aria-label={label}>
                    {s.slice(3)}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
    {hint && (
      <div className="slot-hint" role="status" aria-live="polite">
        <span className="slot-hint-txt">{hint.text}</span>
        <button type="button" className="slot-hint-x" aria-label="Закрити підказку" onClick={() => setHint(null)}>✕</button>
      </div>
    )}
    </div>
  );
}
