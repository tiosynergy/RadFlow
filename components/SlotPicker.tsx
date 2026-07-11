"use client";

/* ===== RadFlow — вибір слота (крок 5 хв) =====
   Сітка: у рядку 4 півгодинні слоти, кожен поділено на 6 частин по 5 хв
   (4×6 = 24 міні-слоти на рядок = 2 год). Рядків стільки, щоб покрити графік
   роботи кабінету. Зайняті 5-хв міні-слоти — червоні (стан busy). Дослідження
   будь-якої тривалості (більше/менше за 30 хв) фарбує свої 5-хв слоти.
   Кожна модалка передає власний stateOf() — валідація не змінюється. */

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
  resetKey?: string;               // (не використовується — лишено для сумісності пропсів)
}

export default function SlotPicker({ slots, stateOf, value, onChange, titleOf, freeStates = ["free"], spanMin = 0 }: Props) {
  if (!slots.length) return null;
  const isFree = (st: string) => freeStates.includes(st);
  const blocks = groupSlots(slots); // 30-хв блоки в межах графіка

  // Зелені межі планованого дослідження: перша (початок) і остання (кінець) 5-хв частини.
  const planStart = value || "";
  const planEnd = value && spanMin > 0 ? slotFmt(slotToMin(value) + Math.max(0, spanMin - 5)) : planStart;

  return (
    <div className="slot-grid4" role="listbox" aria-label="Вільні слоти (крок 5 хв)">
      {blocks.map((bl) => {
        // 6 рівних частин по 5 хв від початку 30-хв блоку.
        const subs = Array.from({ length: 6 }, (_, i) => slotFmt(bl.startMin + i * 5));
        return (
          <div className="slot-blk" key={bl.key}>
            <span className="slot-blk-lab">{slotFmt(bl.startMin)}</span>
            <div className="slot-blk-cells">
              {subs.map((s) => {
                const st = stateOf(s);
                const free = isFree(st);
                const plan = value && (s === planStart || s === planEnd);
                return (
                  <button key={s} type="button"
                    className={"slot" + (value === s ? " sel" : "") + (plan ? " plan" : "") + (!free ? " taken" : "") + (st === "tight" ? " tight" : "") + ((st === "busy" || st === "blocked" || st === "break") ? " busy" : "")}
                    disabled={!free} onClick={() => onChange(s)} title={titleOf ? titleOf(s, st) : s} aria-label={s}>
                    {s.slice(3)}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
